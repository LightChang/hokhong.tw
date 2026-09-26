// 品項的兩個長期性格：什麼時候是產季、價格穩不穩
//
// 回答兩個常被搜尋、但站上原本答不出來的問題：
//   「現在有絲瓜嗎、什麼時候最便宜」 → 產季月份與最便宜的月份（GSC 實際查詢有這類問法）
//   「要不要等幾天再買」             → 十天內的價格變動幅度。天天在跳的品項才值得等
//
// 產季用「量」定義而不是「有沒有交易」：進口與冷藏讓幾乎每個品項全年都有一點量，
// 用「有交易」算會得到「全年都是產季」。改用各月佔全年量的比例，取累積到 80% 的月份。
//
// 波動度用相鄰旬的變動中位絕對值，不用標準差：標準差會被一次颱風拉高，中位數才代表
// 「平常會不會跳」。等待決策是平常的事，不是颱風時的事。
//
// 產出 data/page/crop-profile.json：
//   { years, byCrop: { <tc>|<plv3_key>: { season: {...}, swing: {...} } } }
//
// 用法：node transform/crop-profile.mjs
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect, q, DATA } from './_db.mjs';

const PAGE = join(DATA, 'page');
const AGG = join(DATA, 'agg');
const YEARS = 5;             // 產季與最便宜月看最近幾個完整年
const SEASON_COVER = 0.8;    // 產季＝量累積到這個比例的月份
const SWING_YEARS = 3;       // 波動度看最近幾年
const MIN_XUN = 30;          // 至少幾個相鄰旬才給波動度
// 中文與數字之間留半形空白，跟全站其他地方一致
const MONTHS = ['1 月', '2 月', '3 月', '4 月', '5 月', '6 月', '7 月', '8 月', '9 月', '10 月', '11 月', '12 月'];
// 產季超過這麼多個月就不講「幾月到幾月」（那會變成「產季 10–7 月」這種沒有資訊的說法），
// 改成講「全年都有，哪幾個月最少」。實測全站分佈：9 個月以上的作物有 124 個。
const YEAR_ROUND_MONTHS = 9;
// 波動度級距：照 2026-09-26 的全站實際分佈訂（p33 = 10.4%、p67 = 16.1%），
// 這樣「穩／一般／會跳」各約三分之一。級距是設計常數，不隨資料重算。
const SWING_STEADY = 10, SWING_JUMPY = 16;

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};
const rd = (v, n = 1) => (v == null ? null : +Number(v).toFixed(n));

// 連續的月份收成「3–6 月」這種講法；跨年（11,12,1,2）也要講得對
const monthRanges = (months) => {
  if (!months.length) return '';
  const set = new Set(months);
  // 從一個「前一個月不在集合裡」的月份開始繞，跨年才不會被切成兩段
  let start = months[0];
  for (const m of months) {
    const prev = m === 1 ? 12 : m - 1;
    if (!set.has(prev)) { start = m; break; }
  }
  const out = [];
  let cur = start, runStart = start, count = 0;
  while (count < 12) {
    const next = cur === 12 ? 1 : cur + 1;
    if (!set.has(next)) {
      out.push(runStart === cur ? `${runStart} 月` : `${runStart}–${cur} 月`);
      // 找下一段的起點
      let n = next, guard = 0;
      while (!set.has(n) && guard++ < 12) n = n === 12 ? 1 : n + 1;
      if (!set.has(n) || n === start) break;
      runStart = n; cur = n; count++;
      continue;
    }
    cur = next; count++;
    if (cur === start) { out.push(runStart === cur ? `${runStart} 月` : `${runStart}–${cur} 月`); break; }
  }
  return out.join('、');
};

async function main() {
  const con = await connect();
  await mkdir(PAGE, { recursive: true });

  const [{ last_year, last_date }] = await q(con, `SELECT max(year)::INT AS last_year,
      (SELECT max(trans_date)::VARCHAR FROM read_parquet('${join(AGG, 'plv3_day.parquet')}')) AS last_date
    FROM read_parquet('${join(AGG, 'plv3_month.parquet')}')`);
  // 只用完整年：今年還沒過完，把它算進產季會讓下半年的月份被低估
  const fromYear = Number(last_year) - YEARS;
  const toYear = Number(last_year) - 1;

  const monthly = await q(con, `SELECT tc_type, plv3_key, plv3, year::INT AS year, month::INT AS month, wavg_price, volume
      FROM read_parquet('${join(AGG, 'plv3_month.parquet')}')
     WHERE market_code = 'ALL' AND volume > 0 AND wavg_price > 0
       AND year BETWEEN ${fromYear} AND ${toYear}`);

  const crops = new Map();
  for (const r of monthly) {
    const key = `${r.tc_type}|${r.plv3_key}`;
    if (!crops.has(key)) crops.set(key, { tcType: r.tc_type, plv3Key: r.plv3_key, plv3: r.plv3, byMonth: new Map() });
    const m = crops.get(key).byMonth;
    if (!m.has(r.month)) m.set(r.month, { vol: 0, prices: [] });
    const e = m.get(r.month);
    e.vol += Number(r.volume);
    e.prices.push(Number(r.wavg_price));
  }

  // 波動度：相鄰旬的變動
  const xun = await q(con, `SELECT tc_type, plv3_key, year::INT AS year, month::INT AS month, xun::INT AS xun, wavg_price
      FROM read_parquet('${join(AGG, 'plv3_xun.parquet')}')
     WHERE market_code = 'ALL' AND wavg_price > 0
       AND year >= ${Number(last_year) - SWING_YEARS}
     ORDER BY year, month, xun`);
  const xunByCrop = new Map();
  for (const r of xun) {
    const key = `${r.tc_type}|${r.plv3_key}`;
    if (!xunByCrop.has(key)) xunByCrop.set(key, []);
    xunByCrop.get(key).push({ t: r.year * 36 + r.month * 3 + r.xun, p: Number(r.wavg_price) });
  }

  const byCrop = {};
  for (const [key, c] of crops) {
    const total = [...c.byMonth.values()].reduce((s, x) => s + x.vol, 0);
    if (!total) continue;
    const shares = [...c.byMonth].map(([month, x]) => ({ month, share: x.vol / total, price: median(x.prices) }));
    // 產季：量最大的月份依序累積到 80%
    const sorted = [...shares].sort((a, b) => b.share - a.share);
    const peak = [];
    let acc = 0;
    for (const s of sorted) { peak.push(s); acc += s.share; if (acc >= SEASON_COVER) break; }
    const peakMonths = peak.map((x) => x.month).sort((a, b) => a - b);
    // 最便宜／最貴的月份只在產季裡找：產季外的均價常常是少量高價，講出來會誤導
    const inSeason = shares.filter((s) => peakMonths.includes(s.month) && s.price != null);
    const cheapest = inSeason.length ? inSeason.reduce((a, b) => (b.price < a.price ? b : a)) : null;
    const dearest = inSeason.length ? inSeason.reduce((a, b) => (b.price > a.price ? b : a)) : null;

    // 波動度
    const s = xunByCrop.get(key) ?? [];
    const diffs = [];
    for (let i = 1; i < s.length; i++) {
      if (s[i].t - s[i - 1].t !== 1) continue;        // 只比相鄰旬
      diffs.push(Math.abs(s[i].p / s[i - 1].p - 1) * 100);
    }
    const swingPct = diffs.length >= MIN_XUN ? rd(median(diffs)) : null;

    byCrop[key] = {
      tcType: c.tcType, plv3Key: c.plv3Key, plv3: c.plv3,
      season: {
        months: peakMonths,
        yearRound: peakMonths.length >= YEAR_ROUND_MONTHS,
        // 全年型的作物講「淡季是哪幾個月」比講產季有用
        offMonths: peakMonths.length >= YEAR_ROUND_MONTHS
          ? [...Array(12).keys()].map((i) => i + 1).filter((m) => !peakMonths.includes(m)) : [],
        label: monthRanges(peakMonths),
        cover: rd(acc * 100, 0),
        share: Object.fromEntries(shares.map((x) => [x.month, rd(x.share * 100)])),
        cheapestMonth: cheapest && { month: cheapest.month, label: MONTHS[cheapest.month - 1], price: rd(cheapest.price) },
        dearestMonth: dearest && { month: dearest.month, label: MONTHS[dearest.month - 1], price: rd(dearest.price) },
        yearsFrom: fromYear, yearsTo: toYear,
      },
      swing: swingPct == null ? null : {
        pct: swingPct, samples: diffs.length, years: SWING_YEARS,
        // 級距是設計常數（看 2026-09-26 的全站分佈訂的），不隨資料變
        level: swingPct < SWING_STEADY ? 'steady' : swingPct < SWING_JUMPY ? 'normal' : 'jumpy',
      },
    };
  }

  const out = {
    builtAt: new Date().toISOString(), lastDate: last_date,
    definition: { seasonYears: [fromYear, toYear], seasonCover: SEASON_COVER, swingYears: SWING_YEARS, swingGrain: '旬' },
    byCrop,
  };
  await writeFile(join(PAGE, 'crop-profile.json'), JSON.stringify(out));

  const list = Object.values(byCrop);
  const withSwing = list.filter((c) => c.swing);
  console.error(`品項性格：${list.length} 個作物有產季（${fromYear}–${toYear} 完整年）、${withSwing.length} 個有波動度`);
  const lv = withSwing.reduce((m, c) => ((m[c.swing.level] = (m[c.swing.level] ?? 0) + 1), m), {});
  console.error(`  波動度分佈：穩 ${lv.steady ?? 0}、一般 ${lv.normal ?? 0}、會跳 ${lv.jumpy ?? 0}（中位 ${median(withSwing.map((c) => c.swing.pct))}%）`);
  console.error(`  產季型態：全年型 ${list.filter((c) => c.season.yearRound).length} 個、有明顯產季 ${list.filter((c) => !c.season.yearRound).length} 個`);
  for (const c of list.slice(0, 5)) {
    console.error(`  ${c.plv3.padEnd(8)} ${c.season.yearRound ? `全年（淡季 ${c.season.offMonths.map((m) => m + ' 月').join('、') || '無'}）` : `產季 ${c.season.label}`}（佔全年量 ${c.season.cover}%）`
      + `　最便宜 ${c.season.cheapestMonth?.label ?? '—'}　十天波動 ${c.swing ? `${c.swing.pct}%` : '—'}`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
