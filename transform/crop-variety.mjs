// 同一種菜底下的品種價差，以及進口佔多少
//
// 兩個原本答不出來的問題：
//   「攤子上這把高麗菜是哪一種、差多少」→ 批發是按品種成交的（甘藍分初秋、改良種、
//     改良尖、紫色…），站上原本一律加權平均成一個數字，品種價差整個被平掉。
//   「這個菜為什麼颱風後不漲」        → 進口佔比高的品項，價格不由本地天氣決定。
//
// 資料來源就是 L1 的 `作物名稱`（品種級，例：甘藍-初秋、甘藍-進口 改良種），
// 不必新增任何來源。進口的判準是名稱含「進口」——這是行情站自己的標法
// （identify 的 import-prefix 規則就是靠它），不是我們猜的。
//
// 產出 data/page/crop-variety.json：
//   { days, byCrop: { <tc>|<plv3_key>: { varieties: [...], importPct, spreadPct } } }
//
// 用法：node transform/crop-variety.mjs
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect, q, DATA, readL1, num } from './_db.mjs';

const PAGE = join(DATA, 'page');
const MAP = join(DATA, 'identity', 'crop-map.parquet');
const DAYS = 365;          // 看近一年：品種組合有季節性，一季的窗會少掉半年的品種
const MIN_SHARE = 0.01;    // 佔比低於 1% 的品種不列（一年只賣幾筆的規格，講出來是雜訊）
const MAX_LIST = 8;

const rd = (v, n = 1) => (v == null ? null : +Number(v).toFixed(n));
// 「甘藍-初秋」→「初秋」；「柿子-甜柿」在 plv3 是「柿」時不切（少切比切錯好）
const stripPrefix = (variety, plv3) =>
  (variety.startsWith(`${plv3}-`) ? variety.slice(plv3.length + 1).trim() : variety) || variety;

async function main() {
  const con = await connect();
  await mkdir(PAGE, { recursive: true });

  const [{ last_date }] = await q(con, `SELECT max(trans_date)::VARCHAR AS last_date
    FROM read_parquet('${join(DATA, 'agg', 'plv3_day.parquet')}')`);
  const from = new Date(new Date(last_date).getTime() - (DAYS - 1) * 86400_000).toISOString().slice(0, 10);
  const rocFrom = `${Number(from.slice(0, 4)) - 1911}.${from.slice(5, 7)}.${from.slice(8, 10)}`;

  // 品種級的量與加權均價。confidence 門檻與聚合層同一套，否則這裡會多出聚合層看不到的品種
  const rows = await q(con, `
    SELECT m.tc_type, m.plv3_key, any_value(m.plv3) AS plv3, t."作物名稱" AS variety, t."作物代號" AS code,
           sum(t."交易量") AS volume,
           sum(t."平均價" * t."交易量") / nullif(sum(t."交易量"), 0) AS price,
           count(DISTINCT t."交易日期") AS days
      FROM ${readL1()} t
      JOIN read_parquet('${MAP}') m
        ON m.crop_code = t."作物代號" AND m.tc_type = coalesce(t."種類代碼", '')
     WHERE t."作物代號" <> 'rest' AND t."交易量" > 0
       AND t."交易日期" >= '${rocFrom}'
       AND m.confidence >= 0.8 AND m.plv3_key IS NOT NULL
     GROUP BY 1, 2, 4, 5`);

  const byCrop = new Map();
  for (const r of rows) {
    const key = `${r.tc_type}|${r.plv3_key}`;
    if (!byCrop.has(key)) byCrop.set(key, { tcType: r.tc_type, plv3Key: r.plv3_key, plv3: r.plv3, list: [] });
    byCrop.get(key).list.push({
      variety: r.variety, code: r.code,
      volume: Number(r.volume), price: Number(r.price), days: num(r.days),
      // 行情站自己在名稱上標「進口」，不是我們猜的
      isImport: String(r.variety ?? '').includes('進口'),
    });
  }

  const out = {};
  for (const [key, c] of byCrop) {
    const total = c.list.reduce((s, x) => s + x.volume, 0);
    if (!total) continue;
    const sorted = [...c.list].sort((a, b) => b.volume - a.volume);
    const main = sorted[0];
    const shown = sorted.filter((x) => x.volume / total >= MIN_SHARE).slice(0, MAX_LIST);
    const importVol = c.list.filter((x) => x.isImport).reduce((s, x) => s + x.volume, 0);
    // 價差只看「列得出來的、而且是真的品種」：
    //   一年賣幾筆的規格價格常常離譜（已被 MIN_SHARE 擋掉）
    //   「其他」是統包桶不是品種，把它算進去會虛報價差（西瓜原本算出 225%，其中一半
    //    來自佔 1.1% 的「其他」）
    const prices = shown.filter((x) => !x.variety.includes('其他')).map((x) => x.price).filter((p) => p > 0);
    const spreadPct = prices.length > 1 ? Math.round((Math.max(...prices) / Math.min(...prices) - 1) * 100) : null;
    out[key] = {
      tcType: c.tcType, plv3Key: c.plv3Key, plv3: c.plv3,
      varietyCount: c.list.length,
      // 品種名去掉重複的作物名前綴（「甘藍-初秋」→「初秋」），但一定要連著連字號才切：
      // 只切作物名會把「柿子-甜柿」切成「子-甜柿」（plv3 是「柿」）。
      varieties: shown.map((x) => ({
        name: stripPrefix(x.variety, c.plv3),
        raw: x.variety, code: x.code,
        share: rd((x.volume / total) * 100),
        price: rd(x.price),
        vsMainPct: main.price > 0 ? Math.round((x.price / main.price - 1) * 100) : null,
        isImport: x.isImport, days: x.days,
      })),
      mainVariety: shown.length ? stripPrefix(shown[0].variety, c.plv3) : null,
      spreadPct,
      importPct: rd((importVol / total) * 100),
      // 「幾乎都是進口」的品項，本地天氣與產季對它的價格幾乎沒有意義
      importLevel: importVol / total >= 0.8 ? 'mostly' : importVol / total >= 0.2 ? 'some' : 'little',
    };
  }

  await writeFile(join(PAGE, 'crop-variety.json'), JSON.stringify({
    builtAt: new Date().toISOString(), lastDate: last_date, from, days: DAYS,
    definition: { minShare: MIN_SHARE, maxList: MAX_LIST, importRule: '行情站的作物名稱含「進口」' },
    byCrop: out,
  }));

  const list = Object.values(out);
  const multi = list.filter((c) => c.varieties.length > 1);
  console.error(`品種與進口：${list.length} 個作物（近 ${DAYS} 天，${from} 起）`
    + `，其中 ${multi.length} 個有兩個以上品種在交易`);
  const imp = list.filter((c) => c.importLevel !== 'little').sort((a, b) => b.importPct - a.importPct);
  console.error(`  進口佔兩成以上的 ${imp.length} 個：${imp.slice(0, 8).map((c) => `${c.plv3} ${c.importPct}%`).join('、')}`);
  for (const c of multi.sort((a, b) => (b.spreadPct ?? 0) - (a.spreadPct ?? 0)).slice(0, 5)) {
    console.error(`  ${c.plv3.padEnd(8)} ${c.varieties.length} 個品種、最貴比最便宜貴 ${c.spreadPct}%`
      + `：${c.varieties.slice(0, 4).map((v) => `${v.name} ${v.share}% ${v.price}`).join('、')}`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
