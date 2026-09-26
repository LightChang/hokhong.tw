// 產銷履歷與有機蔬果行情：有溯源標示的貨，比一般貨貴幾成
//
// 買菜的人問「有機／履歷貴這麼多，值不值得」；種的人問「轉型有沒有價差」。
// 這個角度幾乎沒有人在做，因為官方這支資料只給當天，沒有歷史——所以我們自己存。
//
// 為什麼現在先做管線再等資料：歷史長度是時間的函數，不是知識的函數。管線先跑著，
// 每天累積，到樣本夠了自動放行（ready 由 MIN_DAYS 決定），不必到時候再從頭寫。
//
// 來源形狀（2026-09-26 實查）：一列一筆「日期×作物×市場×溯源別」的成交，
// 欄位 交易日期／作物代號／作物名稱／市場代號／市場名稱／交易金額_元／交易量_公斤／溯源代號。
// 溯源代號實際出現 4、6、7、X、休市 五種，**來源沒有說明 4／6／7 各代表什麼**，
// 所以一律合併成「有溯源標示」，不假裝知道哪個是有機、哪個是產銷履歷。
//
// 產出 data/page/tap.json：
//   { ready, days, need, byCrop: { <作物名稱>: { taggedPrice, plainPrice, premiumPct, ... } }, overall }
//
// 用法：node transform/tap.mjs
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA, RAW } from './_db.mjs';

const PAGE = join(DATA, 'page');
const MIN_DAYS = 60;        // 累積幾個交易日才放行顯示
const MIN_KG = 500;         // 單一作物在整個期間的最低累計量（兩邊各自都要過）
const TAGGED = new Set(['4', '6', '7']);   // 有溯源標示；X = 無標示；休市 = 沒有交易

const rd = (v, n = 1) => (v == null ? null : +Number(v).toFixed(n));

async function main() {
  await mkdir(PAGE, { recursive: true });
  const dir = join(RAW, 'tap-trans');
  const files = (await readdir(dir).catch(() => [])).filter((f) => f.endsWith('.json.gz')).sort();

  // 同一天可能被抓過多次（檔名是抓取日），用「日期＋作物＋市場＋溯源別」去重
  const seen = new Map();
  const bad = [];
  for (const f of files) {
    for (const r of JSON.parse(gunzipSync(await readFile(join(dir, f))))) {
      const code = String(r['溯源代號'] ?? '').trim();
      if (code === '休市') continue;
      const vol = Number(r['交易量_公斤']);
      const amt = Number(r['交易金額_元']);
      if (!(vol > 0) || !(amt > 0)) {
        if (code && code !== '休市') bad.push(`${r['交易日期']}／${r['作物名稱']}／${r['市場名稱']}：量 ${r['交易量_公斤']}、金額 ${r['交易金額_元']}`);
        continue;
      }
      seen.set(`${r['交易日期']}|${r['作物名稱']}|${r['市場代號']}|${code}`, { ...r, vol, amt, code });
    }
  }
  const rows = [...seen.values()];
  const days = [...new Set(rows.map((r) => r['交易日期']))].sort();

  // 加權均價 = 交易金額 ÷ 交易量（來源沒有給均價欄）
  const byCrop = new Map();
  for (const r of rows) {
    const name = String(r['作物名稱'] ?? '').trim();
    if (!name) continue;
    if (!byCrop.has(name)) byCrop.set(name, { tagAmt: 0, tagVol: 0, plainAmt: 0, plainVol: 0, tagDays: new Set(), plainDays: new Set() });
    const e = byCrop.get(name);
    if (TAGGED.has(r.code)) { e.tagAmt += r.amt; e.tagVol += r.vol; e.tagDays.add(r['交易日期']); }
    else { e.plainAmt += r.amt; e.plainVol += r.vol; e.plainDays.add(r['交易日期']); }
  }

  const crops = {};
  for (const [name, e] of byCrop) {
    if (!(e.tagVol >= MIN_KG) || !(e.plainVol >= MIN_KG)) continue;
    const tagged = e.tagAmt / e.tagVol;
    const plain = e.plainAmt / e.plainVol;
    crops[name] = {
      taggedPrice: rd(tagged, 2), plainPrice: rd(plain, 2),
      premiumPct: rd((tagged / plain - 1) * 100),
      taggedVolume: Math.round(e.tagVol), plainVolume: Math.round(e.plainVol),
      taggedDays: e.tagDays.size, plainDays: e.plainDays.size,
    };
  }

  const tot = rows.reduce((a, r) => {
    if (TAGGED.has(r.code)) { a.tagAmt += r.amt; a.tagVol += r.vol; } else { a.plainAmt += r.amt; a.plainVol += r.vol; }
    return a;
  }, { tagAmt: 0, tagVol: 0, plainAmt: 0, plainVol: 0 });

  const out = {
    builtAt: new Date().toISOString(),
    // 放行條件：樣本夠才顯示。不夠的時候頁面什麼都不講，不用幾天的資料講「有機貴幾成」
    ready: days.length >= MIN_DAYS,
    days: days.length, need: MIN_DAYS, from: days[0] ?? null, to: days.at(-1) ?? null,
    definition: {
      taggedCodes: [...TAGGED],
      note: '來源的溯源代號實際出現 4、6、7、X，但來源沒有說明各代表什麼，所以 4／6／7 一律合併為「有溯源標示」（產銷履歷或有機），不細分。',
      minKg: MIN_KG,
    },
    overall: tot.tagVol > 0 && tot.plainVol > 0 ? {
      taggedPrice: rd(tot.tagAmt / tot.tagVol, 2), plainPrice: rd(tot.plainAmt / tot.plainVol, 2),
      premiumPct: rd(((tot.tagAmt / tot.tagVol) / (tot.plainAmt / tot.plainVol) - 1) * 100),
      taggedVolume: Math.round(tot.tagVol), plainVolume: Math.round(tot.plainVol),
    } : null,
    crops,
    badCount: bad.length, badRows: bad.slice(0, 10),
  };
  await writeFile(join(PAGE, 'tap.json'), JSON.stringify(out));

  console.error(`產銷履歷／有機：累積 ${days.length}/${MIN_DAYS} 個交易日`
    + `（${out.from ?? '—'}~${out.to ?? '—'}）${out.ready ? '，已放行顯示' : '，樣本不足，頁面暫不顯示'}`);
  if (out.overall) {
    console.error(`  全體：有標示 ${out.overall.taggedPrice} 元/公斤 vs 無標示 ${out.overall.plainPrice}`
      + `　價差 ${out.overall.premiumPct > 0 ? '+' : ''}${out.overall.premiumPct}%`
      + `（量 ${Math.round(out.overall.taggedVolume / 1000)} 噸 vs ${Math.round(out.overall.plainVolume / 1000)} 噸）`);
  }
  const top = Object.entries(crops).sort((a, b) => b[1].premiumPct - a[1].premiumPct).slice(0, 6);
  for (const [name, c] of top) {
    console.error(`  ${name.padEnd(8)} 有標示 ${String(c.taggedPrice).padStart(6)} vs 一般 ${String(c.plainPrice).padStart(6)}　`
      + `${c.premiumPct > 0 ? '+' : ''}${c.premiumPct}%`);
  }
  if (bad.length) console.error(`  來源壞列 ${bad.length} 筆已跳過（量或金額不是正數）`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
