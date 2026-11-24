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
// 歷年同期新低／新高（2026-11-24 站主拍板）：「這次高麗菜是不是十幾年來最便宜」。
// 比的是「這個月 1 日到最近交易日」的全國加權均價，對每一年同月同一段日子（不是整月：
// 月初跟月底在產季裡的價差很大，拿半個月比整個月會失真）。這個月交易日太少（月初）就改比上個月整月。
// 擋門：至少 RANK_MIN_YEARS 個年份可比、每一年那一段至少 RANK_MIN_DAYS 個交易日；
// 今年那一段的量不到歷年中位數的 RANK_MIN_VOL_RATIO 就不講（產季外零星成交的價格不算「新高」）。
// 只講第一名（最低或最高），名次不是預測。
const RANK_MIN_YEARS = 10, RANK_MIN_DAYS = 8, RANK_MIN_VOL_RATIO = 0.3;

// 月曆：「往年幾月有貨、幾月最便宜」（站主 2026-11-24）。用 plv3_month 全部完整年（2012 起），
// 不是上面產季那 5 年——要講「往年通常」，年數越多越不會被某一年的颱風或寒流帶走。
// 每一年各自算「這個月比當年均價便宜／貴幾 %」再取各年中位數，不直接比元：14 年間物價漲了，
// 直接拿 2012 和 2025 的元平均，會變成「越晚的月份越貴」這種假結論。
// 「有貨」＝那個月的量至少是當年月平均量的 CAL_AVAIL_SHARE，而且一半以上的年份都這樣。
// 門檻照 2026-11-24 全站分佈訂（355 個作物、8 年以上 309 個）：最便宜與最貴月份的差距
// p10 = 15、p25 = 28、中位 49 個百分點；最便宜那個月落在當年最便宜三個月內的年份比例
// p25 = 57%、中位 71%。差距不到 CAL_MIN_SPREAD、或一半以上的年份不在最便宜三個月內，
// 就不講「幾月最便宜」（每年不固定，講出來是誤導）。
const CAL_MIN_YEARS = 8;
const CAL_AVAIL_SHARE = 0.25;
const CAL_MIN_SPREAD = 20;      // 百分點
const CAL_MIN_HIT = 0.5;
const CAL_FLAT = 5;             // 月份比全年均價差不到 5% 講「差不多」

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

  // 月曆用全部完整年（今年還沒過完不算）
  const allMonthly = await q(con, `SELECT tc_type, plv3_key, year::INT AS year, month::INT AS month, wavg_price, volume
      FROM read_parquet('${join(AGG, 'plv3_month.parquet')}')
     WHERE market_code = 'ALL' AND volume > 0 AND wavg_price > 0 AND year <= ${toYear}`);
  const calYears = new Map();
  for (const r of allMonthly) {
    const key = `${r.tc_type}|${r.plv3_key}`;
    if (!calYears.has(key)) calYears.set(key, new Map());
    const ys = calYears.get(key);
    if (!ys.has(r.year)) ys.set(r.year, new Map());
    ys.get(r.year).set(r.month, { p: Number(r.wavg_price), v: Number(r.volume) });
  }
  const calendarOf = (key) => {
    const ys = calYears.get(key);
    if (!ys) return null;
    const rel = Array.from({ length: 12 }, () => []);
    const shares = Array.from({ length: 12 }, () => []);
    const avail = Array(12).fill(0), low3 = Array(12).fill(0);
    let years = 0, y0 = null, y1 = null;
    for (const [y, ms] of ys) {
      const tv = [...ms.values()].reduce((s, e) => s + e.v, 0);
      const ok = [...ms].filter(([, e]) => e.v >= (tv / 12) * CAL_AVAIL_SHARE);
      if (ok.length < 3) continue;          // 一年只有一兩個月有像樣的量，比不出月份差
      years++;
      y0 = y0 == null ? y : Math.min(y0, y); y1 = y1 == null ? y : Math.max(y1, y);
      const mean = ok.reduce((s, [, e]) => s + e.p * e.v, 0) / ok.reduce((s, [, e]) => s + e.v, 0);
      for (const [m, e] of ok) { avail[m - 1]++; rel[m - 1].push(e.p / mean); }
      for (const [m, e] of ms) shares[m - 1].push(e.v / tv);
      [...ok].sort((a, b) => a[1].p - b[1].p).slice(0, 3).forEach(([m]) => low3[m - 1]++);
    }
    if (years < CAL_MIN_YEARS) return null;
    const months = Array.from({ length: 12 }, (_, i) => {
      const has = avail[i] >= years / 2 && rel[i].length > 0;
      return {
        month: i + 1, avail: has,
        pct: has ? Math.round((median(rel[i]) - 1) * 100) : null,
        share: rd(median([...shares[i], ...Array(years - shares[i].length).fill(0)]) * 100),
      };
    });
    const on = months.filter((m) => m.avail);
    if (on.length < 2) return null;
    const lo = on.reduce((a, b) => (b.pct < a.pct ? b : a));
    const hi = on.reduce((a, b) => (b.pct > a.pct ? b : a));
    const spread = hi.pct - lo.pct;
    const hit = low3[lo.month - 1];
    const verdict = spread < CAL_MIN_SPREAD ? 'flat' : hit / years < CAL_MIN_HIT ? 'varies' : 'clear';
    return {
      years, from: y0, to: y1,
      months: months.map((m) => ({ ...m, flat: m.pct != null && Math.abs(m.pct) < CAL_FLAT })),
      availMonths: on.map((m) => m.month),
      // 跨年的一段寫「11 月到隔年 1 月」，不寫「11–1 月」
      availLabel: on.length === 12 ? '' : monthRanges(on.map((m) => m.month))
        .replace(/(\d+)–(\d+) 月/g, (all, a, b) => (Number(a) > Number(b) ? `${a} 月到隔年 ${b} 月` : all)),
      verdict, spread,
      cheapest: verdict === 'clear' ? { month: lo.month, label: MONTHS[lo.month - 1], pct: lo.pct, hit } : null,
      dearest: verdict === 'clear' ? { month: hi.month, label: MONTHS[hi.month - 1], pct: hi.pct } : null,
    };
  };

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

  // 歷年同期（見 RANK_*）
  const ld = String(last_date);
  let rMonth = Number(ld.slice(5, 7)), rDay = Number(ld.slice(8, 10)), rYear = Number(ld.slice(0, 4));
  const [{ n: mtdDays }] = await q(con, `SELECT count(DISTINCT trans_date)::INT AS n FROM read_parquet('${join(AGG, 'plv3_day.parquet')}')
     WHERE year(trans_date) = ${rYear} AND month(trans_date) = ${rMonth}`);
  if (Number(mtdDays) < RANK_MIN_DAYS) {           // 月初：改比上個月整月
    rMonth = rMonth === 1 ? 12 : rMonth - 1; if (rMonth === 12) rYear -= 1; rDay = 31;
  }
  const rankRows = await q(con, `SELECT tc_type, plv3_key, year(trans_date)::INT AS year,
        sum(wavg_price * volume) / sum(volume) AS p, sum(volume) AS v, count(DISTINCT trans_date)::INT AS n
      FROM read_parquet('${join(AGG, 'plv3_day.parquet')}')
     WHERE month(trans_date) = ${rMonth} AND day(trans_date) <= ${rDay} AND year(trans_date) <= ${rYear}
       AND volume > 0 AND wavg_price > 0
     GROUP BY 1, 2, 3`);
  const rankBy = new Map();
  for (const r of rankRows) {
    const key = `${r.tc_type}|${r.plv3_key}`;
    if (!rankBy.has(key)) rankBy.set(key, []);
    rankBy.get(key).push({ year: Number(r.year), p: Number(r.p), v: Number(r.v), n: Number(r.n) });
  }
  const rankOf = (key) => {
    const ys = (rankBy.get(key) ?? []).filter((y) => y.n >= RANK_MIN_DAYS);
    const cur = ys.find((y) => y.year === rYear);
    const past = ys.filter((y) => y.year < rYear);
    if (!cur || past.length + 1 < RANK_MIN_YEARS) return null;
    if (cur.v < (median(past.map((y) => y.v)) ?? 0) * RANK_MIN_VOL_RATIO) return null;
    const lowPast = past.reduce((a, b) => (b.p < a.p ? b : a));
    const highPast = past.reduce((a, b) => (b.p > a.p ? b : a));
    const kind = cur.p < lowPast.p ? 'low' : cur.p > highPast.p ? 'high' : null;
    return {
      year: rYear, month: rMonth, toDay: rDay,
      fullMonth: Number(mtdDays) < RANK_MIN_DAYS, years: past.length + 1, fromYear: Math.min(...past.map((y) => y.year)),
      price: rd(cur.p), kind,
      // 被比下去的那一年（原本的最低／最高）
      prev: kind === 'low' ? { year: lowPast.year, price: rd(lowPast.p) } : kind === 'high' ? { year: highPast.year, price: rd(highPast.p) } : null,
    };
  };

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

    // 波動度
    const s = xunByCrop.get(key) ?? [];
    const diffs = [];
    for (let i = 1; i < s.length; i++) {
      if (s[i].t - s[i - 1].t !== 1) continue;        // 只比相鄰旬
      diffs.push(Math.abs(s[i].p / s[i - 1].p - 1) * 100);
    }
    const swingPct = diffs.length >= MIN_XUN ? rd(median(diffs)) : null;
    const calendar = calendarOf(key);

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
        // 「最便宜／最貴的月份」全站只用月曆那一份（14 年、各年相對價的中位數），
        // 首頁、/season/、品項頁才不會各講一個月份。月曆擋掉的（年數不夠、各月差不多、
        // 每年不固定）就是沒有，不退回 5 年的算法。
        cheapestMonth: calendar?.cheapest ?? null,
        dearestMonth: calendar?.dearest ?? null,
        yearsFrom: fromYear, yearsTo: toYear,
      },
      rank: rankOf(key),
      calendar,
      swing: swingPct == null ? null : {
        pct: swingPct, samples: diffs.length, years: SWING_YEARS,
        // 級距是設計常數（看 2026-09-26 的全站分佈訂的），不隨資料變
        level: swingPct < SWING_STEADY ? 'steady' : swingPct < SWING_JUMPY ? 'normal' : 'jumpy',
      },
    };
  }

  const out = {
    builtAt: new Date().toISOString(), lastDate: last_date,
    definition: {
      seasonYears: [fromYear, toYear], seasonCover: SEASON_COVER, swingYears: SWING_YEARS, swingGrain: '旬',
      rank: { minYears: RANK_MIN_YEARS, minDays: RANK_MIN_DAYS, minVolRatio: RANK_MIN_VOL_RATIO },
      calendar: { minYears: CAL_MIN_YEARS, availShare: CAL_AVAIL_SHARE, minSpread: CAL_MIN_SPREAD, minHit: CAL_MIN_HIT, flat: CAL_FLAT, toYear },
    },
    byCrop,
  };
  await writeFile(join(PAGE, 'crop-profile.json'), JSON.stringify(out));

  const list = Object.values(byCrop);
  const withSwing = list.filter((c) => c.swing);
  console.error(`品項性格：${list.length} 個作物有產季（${fromYear}–${toYear} 完整年）、${withSwing.length} 個有波動度`);
  const lv = withSwing.reduce((m, c) => ((m[c.swing.level] = (m[c.swing.level] ?? 0) + 1), m), {});
  console.error(`  波動度分佈：穩 ${lv.steady ?? 0}、一般 ${lv.normal ?? 0}、會跳 ${lv.jumpy ?? 0}（中位 ${median(withSwing.map((c) => c.swing.pct))}%）`);
  const cal = list.filter((c) => c.calendar);
  const cv = cal.reduce((m, c) => ((m[c.calendar.verdict] = (m[c.calendar.verdict] ?? 0) + 1), m), {});
  console.error(`  月曆：${cal.length} 個作物有 ${CAL_MIN_YEARS} 年以上（講得出最便宜月 ${cv.clear ?? 0}、各月差不多 ${cv.flat ?? 0}、每年不固定 ${cv.varies ?? 0}）`);
  console.error(`  產季型態：全年型 ${list.filter((c) => c.season.yearRound).length} 個、有明顯產季 ${list.filter((c) => !c.season.yearRound).length} 個`);
  const rk = list.filter((c) => c.rank?.kind);
  console.error(`  歷年同期：可比 ${list.filter((c) => c.rank).length} 個；新低 ${rk.filter((c) => c.rank.kind === 'low').map((c) => c.plv3).join('、') || '無'}；新高 ${rk.filter((c) => c.rank.kind === 'high').map((c) => c.plv3).join('、') || '無'}`);
  for (const c of list.slice(0, 5)) {
    console.error(`  ${c.plv3.padEnd(8)} ${c.season.yearRound ? `全年（淡季 ${c.season.offMonths.map((m) => m + ' 月').join('、') || '無'}）` : `產季 ${c.season.label}`}（佔全年量 ${c.season.cover}%）`
      + `　最便宜 ${c.season.cheapestMonth?.label ?? '—'}　十天波動 ${c.swing ? `${c.swing.pct}%` : '—'}`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
