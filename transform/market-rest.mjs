// 休市：接下來哪幾天不開秤，以及休市過後價格到底會不會漲
//
// 回答兩個人的兩個問題：
//   買菜的人 → 休市隔天要不要提前買？（結論：不必，價格幾乎不動）
//   出貨的人 → 接下來哪幾天不能送？（未來的休市日官方已經公告到年底）
//
// 這是全站唯一「講未來」的資料：其他頁都只能講已經發生的交易。
//
// 來源 ingest/raw/market-rest-farm.json.gz 有三個要擋的坑（2026-09-26 實查）：
//   1. 日期有零補與不零補兩種（`03、07` 與 `5、12`）
//   2. 14 個空 token（尾隨或連續的頓號）
//   3. 1 個非法日：宜蘭市 109 年 9 月寫了「46」
// 壞資料逐筆指名跳過，不讓整批死（判準見 /root/.claude/doctrine）。
//
// 產出 data/page/market-rest.json：
//   { builtAt, lastDate, upcoming: { <market_code>: { tcTypes, dates[] } },
//     effect: { byRunLen: [...], basis }, counts }
//
// 用法：node transform/market-rest.mjs
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect, q, RAW, DATA, today } from './_db.mjs';

const PAGE = join(DATA, 'page');
const AGG = join(DATA, 'agg');
const TC_OF = { 蔬菜: 'N04', 水果: 'N05', 花卉: 'N06' };
const BASIS_DAYS = 28;     // 平常水準的比較窗：復市首日前後各 28 天
const UPCOMING_MAX = 8;    // 每個市場最多列幾個未來休市日

const pad = (n) => String(n).padStart(2, '0');
const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

// 民國年月 + ClosedDate → ISO 日期陣列。壞 token 回報而不丟例外。
function parseClosed(yearMonth, closedDate, bad) {
  const roc = Number(yearMonth.slice(0, 3));
  const month = Number(yearMonth.slice(3));
  if (!roc || !month || month < 1 || month > 12) { bad.push(`年月無法解析：${yearMonth}`); return []; }
  const year = roc + 1911;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const out = [];
  for (const tok of String(closedDate ?? '').split('、')) {
    const t = tok.trim();
    if (!t) continue;                       // 坑 2：空 token，正常略過不必記
    const d = Number(t);
    if (!Number.isInteger(d) || d < 1 || d > daysInMonth) {
      bad.push(`${yearMonth} 的休市日「${t}」不是這個月的日期（該月 ${daysInMonth} 天）`);
      continue;                             // 坑 3：非法日
    }
    out.push(`${year}-${pad(month)}-${pad(d)}`);   // 坑 1：零補與不零補都走 Number
  }
  return out;
}

async function main() {
  const con = await connect();
  await mkdir(PAGE, { recursive: true });

  const raw = JSON.parse(gunzipSync(await readFile(join(RAW, 'market-rest-farm.json.gz'))).toString());
  const bad = [];
  // key = 市場 + 類別，值 = 休市日 Set
  const rest = new Map();
  for (const r of raw) {
    const tc = TC_OF[r.MarketType];
    if (!tc) { bad.push(`未知的市場類別「${r.MarketType}」（${r.MarketNo}／${r.YearMonth}）`); continue; }
    const key = `${r.MarketNo}|${tc}`;
    if (!rest.has(key)) rest.set(key, new Set());
    for (const d of parseClosed(r.YearMonth, r.ClosedDate, bad)) rest.get(key).add(d);
  }

  const [{ last_date }] = await q(con, `SELECT max(trans_date)::VARCHAR AS last_date FROM read_parquet('${join(AGG, 'market_day.parquet')}')`);
  const from = today();     // 未來＝從今天起（不是從最後交易日起：使用者問的是「接下來」）

  // ── 接下來的休市日：同一個市場的蔬菜／水果／花卉常常同一天休，合併起來講
  const upcoming = {};
  for (const [key, days] of rest) {
    const [code, tc] = key.split('|');
    for (const d of days) {
      if (d < from) continue;
      const m = (upcoming[code] ??= { tcTypes: [], dates: {} });
      if (!m.tcTypes.includes(tc)) m.tcTypes.push(tc);
      (m.dates[d] ??= []).push(tc);
    }
  }
  for (const code of Object.keys(upcoming)) {
    const m = upcoming[code];
    m.dates = Object.entries(m.dates)
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(0, UPCOMING_MAX)
      .map(([date, tcTypes]) => ({ date, tcTypes: tcTypes.sort() }));
  }

  // ── 休市過後價格會不會漲：連續休市 run → 復市首日 vs 平常水準
  // 平常水準用「同市場同類別、復市首日前後 28 天、同一個星期」的中位數：
  // 休市日集中在固定星期（多數市場週一休），不控星期會把「週二本來就量大」算成休市效應。
  const trading = new Map();      // key → Map(date → {volume, price})
  for (const r of await q(con, `SELECT trans_date::VARCHAR AS d, market_code, tc_type, volume, wavg_price
      FROM read_parquet('${join(AGG, 'market_day.parquet')}') WHERE volume > 0 AND wavg_price > 0`)) {
    const key = `${r.market_code}|${r.tc_type}`;
    if (!trading.has(key)) trading.set(key, new Map());
    trading.get(key).set(r.d, { volume: Number(r.volume), price: Number(r.wavg_price) });
  }

  const shift = (iso, n) => {
    const d = new Date(`${iso}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  };
  const dow = (iso) => new Date(`${iso}T00:00:00Z`).getUTCDay();

  const samples = [];            // { runLen, volRatio, priceRatio }
  for (const [key, days] of rest) {
    const t = trading.get(key);
    if (!t) continue;
    const sorted = [...days].sort();
    // 連續休市切段
    const runs = [];
    for (const d of sorted) {
      const prev = runs.at(-1);
      if (prev && shift(prev.end, 1) === d) prev.end = d, prev.len++;
      else runs.push({ start: d, end: d, len: 1 });
    }
    for (const run of runs) {
      // 復市首日：休市結束後第一個有交易的日子，且必須緊接著（隔太久是資料斷掉，不是休市）
      let reopen = null;
      for (let i = 1; i <= 3; i++) {
        const d = shift(run.end, i);
        if (t.has(d)) { reopen = d; break; }
      }
      if (!reopen) continue;
      const cur = t.get(reopen);
      // 平常水準：同星期、前後 28 天，排除所有復市首日（否則基準被自己汙染）
      const reopenDays = new Set(runs.map((r) => shift(r.end, 1)));
      const vols = [], prices = [];
      for (let i = -BASIS_DAYS; i <= BASIS_DAYS; i++) {
        const d = shift(reopen, i);
        if (d === reopen || reopenDays.has(d)) continue;
        if (dow(d) !== dow(reopen)) continue;
        const v = t.get(d);
        if (v) { vols.push(v.volume); prices.push(v.price); }
      }
      const bv = median(vols), bp = median(prices);
      if (!bv || !bp) continue;
      samples.push({ runLen: run.len, volRatio: cur.volume / bv, priceRatio: cur.price / bp });
    }
  }

  const bucket = (len) => (len === 1 ? '1' : len === 2 ? '2' : '3+');
  const byRunLen = ['1', '2', '3+'].map((b) => {
    const rows = samples.filter((s) => bucket(s.runLen) === b);
    return {
      runLen: b,
      samples: rows.length,
      volumePct: rows.length ? Math.round((median(rows.map((s) => s.volRatio)) - 1) * 100) : null,
      pricePct: rows.length ? Math.round((median(rows.map((s) => s.priceRatio)) - 1) * 100) : null,
    };
  }).filter((b) => b.samples > 0);

  const out = {
    builtAt: new Date().toISOString(),
    lastDate: last_date,
    from,
    upcoming,
    effect: {
      byRunLen,
      basisDays: BASIS_DAYS,
      // 判讀口徑要跟著數字走，否則引用的人會講成「休市後會漲」
      basis: `復市首日與「同市場同類別、同一個星期、前後 ${BASIS_DAYS} 天」的中位數相比`,
    },
    counts: {
      marketTcPairs: rest.size,
      restDays: [...rest.values()].reduce((s, v) => s + v.size, 0),
      upcomingMarkets: Object.keys(upcoming).length,
      effectSamples: samples.length,
    },
    badRows: bad.slice(0, 20),
    badCount: bad.length,
  };
  await writeFile(join(PAGE, 'market-rest.json'), JSON.stringify(out));

  console.error(`休市 ${out.counts.restDays} 個「市場×類別×日」／${out.counts.marketTcPairs} 組；`
    + `${from} 起還有休市日的市場 ${out.counts.upcomingMarkets} 個`);
  for (const b of byRunLen) {
    console.error(`  連休 ${b.runLen} 天 → 復市首日 到貨量 ${b.volumePct > 0 ? '+' : ''}${b.volumePct}%、`
      + `均價 ${b.pricePct > 0 ? '+' : ''}${b.pricePct}%（${b.samples} 個樣本）`);
  }
  if (bad.length) {
    console.error(`來源壞資料 ${bad.length} 筆，已逐筆跳過：`);
    for (const b of bad.slice(0, 5)) console.error(`  ${b}`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
