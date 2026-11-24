// 水果「今年這一季跟去年比」：椪柑、柳丁、茂谷柑、草莓這類有明確產季的水果，
// 買的人與寫新聞的人要的是一句「今年這一季比去年貴還是便宜、差多少」。
//
// 站上原本只有「最近一個月跟去年同月比」，產季一跨月就看不出整季的樣子，
// 頁面也看不到年份。這一支以「產季」為單位：
//   這一季：今年產季第一個月的 1 日 → 最近交易日
//   去年同一段：去年同月同日 → 去年同一個日期
// 兩段都是全國各市場按交易量加權的日均價，再按交易量加權成一段的均價。
//
// 品種層而不是作物層：行情站的「寬皮柑」把椪柑、茂谷柑、桶柑、進口柑橘加在一起，
// 「甜橙」有兩成多是進口。問「今年椪柑」的人要的是椪柑，所以這四樣直接用品種代號（VARIETIES）。
// 其他水果用作物層，但一律去掉品名有「進口」的代號——進口貨沒有本地產季。
//
// 產季的算法跟 crop-profile.mjs 同一套（近 5 個完整年各月佔全年量的比例，累積到 80%），
// 只是改在品種層算，並把產季前一個量已經不小（佔全年 5% 以上）的月份也算進來；產季超過 9 個月的當作全年都有，改比「最近 28 天」對「去年同 28 天」。
//
// 擋門（設計常數，不每天重算）：
//   這一季、去年同一段都要至少 MIN_DAYS 個交易日；不到就只講「產季幾月起」，不給比較
//   產季還沒開始的品項：給去年整季的均價與價格區間（那是已經發生的事實），不給今年的
//
// 另外替 /festival/cny/ 挑「除夕前後當季」的水果：除夕前 30 天到除夕落在哪幾個月，
// 那幾個月近 5 年佔全年量 25% 以上（平均一個月 8.3%，兩個月 16.7%，取 1.5 倍）、
// 一年本地量 1,000 公噸以上。2026-11-24 實算：印度棗 66.8%、草莓 47.9%、寬皮柑 38.3%、
// 甜橙 33.6%、釋迦 33.5%、楊桃 28.2%、蓮霧 26.7% 過門；小果番茄 23.8% 沒過。
// 拜拜常擺的水果不由這裡決定，讀 overrides/festival-menu.json 送神、天公生的「水果」「五果」
// （那兩道菜有文化來源），兩份清單共用同一組品項。
//
// 產出 data/page/season-yoy.json
//
// 用法：node transform/season-yoy.mjs
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect, q, DATA, ROOT, readL1 } from './_db.mjs';

const PAGE = join(DATA, 'page');
const MAP = join(DATA, 'identity', 'crop-map.parquet');
const SEASON_YEARS = 5;
const SEASON_COVER = 0.8;
const YEAR_ROUND_MONTHS = 9;
const EDGE_SHARE = 5;         // 產季前一個月佔全年量幾 % 以上也算產季
const ROUND_WINDOW = 28;      // 全年型：比最近幾天
const MIN_DAYS = 10;          // 一段至少幾個交易日才比
const CNY_SHARE = 25;         // 除夕前後那幾個月佔全年量（%）
const CNY_MIN_TONS = 1000;    // 一年本地量（公噸）
const CNY_LEAD = 30;          // 除夕前幾天算採買期

// 用品種代號算的四樣（作物層會混到別的品種或進口）。page＝掛在哪一頁
const VARIETIES = [
  { id: 'ponkan', name: '椪柑', tc: 'N05', codes: ['C1'], plv3Key: '00301053003' },
  { id: 'murcott', name: '茂谷柑', tc: 'N05', codes: ['C2'], plv3Key: '00301053003' },
  { id: 'orange', name: '柳丁', tc: 'N05', codes: ['E1'], plv3Key: '00301053004' },
  { id: 'strawberry', name: '草莓', tc: 'N05', codes: ['45'], plv3Key: '00208167011' },
];
const SPLIT = new Set(VARIETIES.map((v) => v.plv3Key));

const rd = (v, n = 1) => (v == null ? null : +Number(v).toFixed(n));
const addDays = (iso, n) => new Date(Date.parse(iso) + n * 86_400_000).toISOString().slice(0, 10);
const minusYear = (iso) => {
  const y = Number(iso.slice(0, 4)) - 1;
  const md = iso.slice(5) === '02-29' ? '02-28' : iso.slice(5);
  return `${y}-${md}`;
};
const quantile = (xs, p) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const i = (s.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i);
  return s[lo] + (s[hi] - s[lo]) * (i - lo);
};
// 產季月份切成連續的幾段（跨年也算連續）：釋迦是 11–4 月、8 月兩段
const nextM = (m) => (m === 12 ? 1 : m + 1);
const prevM = (m) => (m === 1 ? 12 : m - 1);
const runsOf = (months) => {
  const set = new Set(months);
  if (set.size >= 12) return [{ start: 1, end: 12 }];
  return months.filter((m) => !set.has(prevM(m))).sort((x, y) => x - y).map((start) => {
    let end = start;
    while (set.has(nextM(end))) end = nextM(end);
    return { start, end };
  });
};
const runText = (r) => (r.start === r.end ? `${r.start} 月` : `${r.start}–${r.end} 月`);
const inRun = (r, m) => (r.start <= r.end ? m >= r.start && m <= r.end : m >= r.start || m <= r.end);
const lastDayOf = (y, m) => `${y}-${String(m).padStart(2, '0')}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;

async function main() {
  const con = await connect();
  await mkdir(PAGE, { recursive: true });
  const menu = JSON.parse(await readFile(join(ROOT, 'overrides', 'festival-menu.json'), 'utf-8'));
  const cal = JSON.parse(await readFile(join(ROOT, 'overrides', 'lunar-calendar.json'), 'utf-8'));
  const idx = JSON.parse(await readFile(join(PAGE, 'index.json'), 'utf-8'));

  // 交易列：水果、本地品名（不含「進口」），全國各市場
  await con.run(`CREATE TEMP TABLE b AS
    SELECT make_date(CAST(substr(t."交易日期", 1, 3) AS INT) + 1911, CAST(substr(t."交易日期", 5, 2) AS INT), CAST(substr(t."交易日期", 8, 2) AS INT)) AS d,
           t."作物代號" AS code, m.plv3_key, m.plv3, t."平均價" AS price, t."交易量" AS volume
      FROM ${readL1()} t
      JOIN read_parquet('${MAP}') m ON m.crop_code = t."作物代號" AND m.tc_type = coalesce(t."種類代碼", '')
     WHERE t."種類代碼" = 'N05' AND t."交易量" > 0 AND t."平均價" > 0
       AND m.confidence >= 0.8 AND m.plv3_key IS NOT NULL AND m.crop_name NOT LIKE '%進口%'`);
  const [{ last }] = await q(con, `SELECT max(d)::VARCHAR AS last FROM b`);
  const lastYear = Number(last.slice(0, 4));
  const fromY = lastYear - SEASON_YEARS, toY = lastYear - 1;

  // 項目：四個品種＋其他作物層（拆成品種的作物不再算作物層）
  const items = VARIETIES.map((v) => ({ ...v, key: `v:${v.id}`, kind: 'variety', where: `code IN (${v.codes.map((c) => `'${c}'`).join(',')}) AND plv3_key = '${v.plv3Key}'` }));
  const plv3s = await q(con, `SELECT plv3_key, any_value(plv3) AS plv3, sum(volume) / ${SEASON_YEARS} / 1000 AS tons
      FROM b WHERE year(d) BETWEEN ${fromY} AND ${toY} GROUP BY 1`);
  const byKey = new Map(idx.crops.filter((c) => c.tcType === 'N05').map((c) => [c.plv3Key, c]));
  for (const p of plv3s) {
    if (SPLIT.has(p.plv3_key)) continue;
    const c = byKey.get(p.plv3_key);
    if (!c) continue;
    items.push({ id: c.slug, name: c.name, tc: 'N05', plv3Key: p.plv3_key, key: `c:${p.plv3_key}`, kind: 'crop', tons: Number(p.tons), where: `plv3_key = '${p.plv3_key}'` });
  }
  for (const v of items) v.slug = byKey.get(v.plv3Key)?.slug ?? null;

  // 各項目各月的量（產季）與日均價
  const monthShare = async (where) => {
    const rows = await q(con, `SELECT month(d)::INT AS m, sum(volume) AS v FROM b WHERE ${where} AND year(d) BETWEEN ${fromY} AND ${toY} GROUP BY 1`);
    const tot = rows.reduce((s, r) => s + Number(r.v), 0);
    return { tot, share: Object.fromEntries(rows.map((r) => [r.m, tot ? Number(r.v) / tot * 100 : 0])) };
  };
  const daily = async (where, from, to) => (await q(con, `SELECT d::VARCHAR AS d, sum(price * volume) / sum(volume) AS p, sum(volume) AS v
      FROM b WHERE ${where} AND d BETWEEN '${from}' AND '${to}' GROUP BY 1 ORDER BY 1`)).map((r) => ({ d: r.d, p: Number(r.p), v: Number(r.v) }));
  const stat = (rows, from, to) => {
    if (!rows.length) return { from, to, days: 0 };
    const vol = rows.reduce((s, r) => s + r.v, 0);
    return {
      from, to, days: rows.length,
      price: rd(rows.reduce((s, r) => s + r.p * r.v, 0) / vol),
      low: rd(quantile(rows.map((r) => r.p), 0.25)), high: rd(quantile(rows.map((r) => r.p), 0.75)),
      volume: Math.round(vol),
    };
  };

  const thisMonth = Number(last.slice(5, 7));
  const out = {};
  for (const it of items) {
    const { tot, share } = await monthShare(it.where);
    if (!tot) continue;
    const sorted = Object.entries(share).map(([m, s]) => ({ m: Number(m), s })).sort((a, b) => b.s - a.s);
    const months = [];
    let acc = 0;
    for (const x of sorted) { months.push(x.m); acc += x.s; if (acc >= SEASON_COVER * 100) break; }
    // 產季初：每一段的前一個月若也佔全年 EDGE_SHARE% 以上，算進產季
    // （草莓 12 月佔 11.1%、椪柑 10 月佔 13.1%，那時候市場上已經大量有貨）
    for (let guard = 0; guard < 3 && months.length < YEAR_ROUND_MONTHS; guard++) {
      const add = runsOf(months).map((r) => prevM(r.start)).filter((m) => !months.includes(m) && (share[m] ?? 0) >= EDGE_SHARE);
      if (!add.length) break;
      months.push(...new Set(add));
    }
    months.sort((a, b) => a - b);
    const yearRound = months.length >= YEAR_ROUND_MONTHS;
    const runs = runsOf(months);
    const r = {
      key: it.key, id: it.id, kind: it.kind, name: it.name, plv3Key: it.plv3Key, slug: it.slug,
      tons: it.tons != null ? Math.round(it.tons) : Math.round(tot / SEASON_YEARS / 1000),
      months, label: yearRound ? '全年' : runs.map(runText).join('、'), yearRound,
      share: Object.fromEntries(Object.entries(share).map(([m, s]) => [m, rd(s)])),
    };
    // 這一季從哪天起算
    let curFrom = null;
    const curRun = yearRound ? null : runs.find((x) => inRun(x, thisMonth));
    if (yearRound) {
      curFrom = addDays(last, -(ROUND_WINDOW - 1));
      r.status = 'on';
    } else if (curRun) {
      const y = thisMonth >= curRun.start ? lastYear : lastYear - 1;
      curFrom = `${y}-${String(curRun.start).padStart(2, '0')}-01`;
      r.status = 'on';
      r.seasonYear = y;
      r.startMonth = curRun.start;
    } else {
      r.status = 'pre';
      // 下一段產季的起點，與去年同一段（已經發生的事實）
      const dist = (m) => (m - thisMonth + 12) % 12;
      const nx = [...runs].sort((x, z) => dist(x.start) - dist(z.start))[0];
      const y = nx.start > thisMonth ? lastYear : lastYear + 1;
      r.startMonth = nx.start;
      r.nextStart = `${y}-${String(nx.start).padStart(2, '0')}-01`;
      const pFrom = `${y - 1}-${String(nx.start).padStart(2, '0')}-01`;
      const pTo = lastDayOf(nx.end >= nx.start ? y - 1 : y, nx.end);
      const pr = stat(await daily(it.where, pFrom, pTo), pFrom, pTo);
      r.lastSeason = pr.days >= MIN_DAYS ? { ...pr, seasonYear: y - 1 } : null;
    }
    if (curFrom) {
      const cur = stat(await daily(it.where, curFrom, last), curFrom, last);
      const pFrom = minusYear(curFrom), pTo = minusYear(last);
      const prev = stat(await daily(it.where, pFrom, pTo), pFrom, pTo);
      r.cur = cur;
      r.prev = prev;
      r.window = yearRound ? 'recent' : 'season';
      r.ready = cur.days >= MIN_DAYS && prev.days >= MIN_DAYS && cur.price > 0 && prev.price > 0;
      r.changePct = r.ready ? rd((cur.price / prev.price - 1) * 100) : null;
    }
    out[it.key] = r;
  }

  // 除夕前後當季：除夕前 CNY_LEAD 天到除夕碰到的月份
  const eve = cal.lunar.filter((x) => x.id === 'eve').map((x) => x.date).sort().find((d) => d >= last) ?? null;
  let cny = null;
  if (eve) {
    const ms = new Set();
    for (let i = 0; i <= CNY_LEAD; i++) ms.add(Number(addDays(eve, -i).slice(5, 7)));
    const cnyMonths = [...ms];
    const inSeason = Object.values(out)
      .filter((r) => !r.yearRound && r.tons >= CNY_MIN_TONS)
      .map((r) => ({ r, s: cnyMonths.reduce((a, m) => a + (r.share[m] ?? 0), 0) }))
      .filter((x) => x.s >= CNY_SHARE)
      .sort((a, b) => b.s - a.s)
      .map((x) => ({ key: x.r.key, sharePct: rd(x.s) }));
    // 拜拜常擺的水果：送神、天公生的水果類菜色（有文化來源）
    const nameTo = new Map();
    for (const r of Object.values(out).filter((x) => x.kind === 'crop')) {
      nameTo.set(r.name, r.key);
      const off = byKey.get(r.plv3Key)?.official;
      if (off && !nameTo.has(off)) nameTo.set(off, r.key);
    }
    const offering = [];
    const sources = [];
    for (const f of menu.festivals.filter((x) => ['songshen', 'tiangong'].includes(x.id))) {
      for (const d of f.dishes.filter((x) => /水果|五果/.test(x.dish))) {
        sources.push({ festival: f.name, dish: d.dish, source: d.source, sourceOrg: d.sourceOrg ?? null });
        for (const n of d.have) {
          const k = nameTo.get(n);
          if (!k) throw new Error(`拜拜水果「${n}」對不到本地水果品項`);
          if (!offering.includes(k)) offering.push(k);
        }
      }
    }
    cny = { eve, months: cnyMonths.sort((a, b) => a - b), share: CNY_SHARE, minTons: CNY_MIN_TONS, lead: CNY_LEAD, inSeason, offering, sources };
  }

  // 掛在品項頁：四個品種掛在所屬作物頁
  const byPage = {};
  for (const v of VARIETIES) (byPage[v.plv3Key] ??= []).push(`v:${v.id}`);

  await writeFile(join(PAGE, 'season-yoy.json'), JSON.stringify({
    builtAt: new Date().toISOString(), lastDate: last,
    definition: { seasonYears: [fromY, toY], seasonCover: SEASON_COVER, edgeShare: EDGE_SHARE, yearRoundMonths: YEAR_ROUND_MONTHS, roundWindow: ROUND_WINDOW, minDays: MIN_DAYS },
    items: out, byPage, cny,
  }));

  console.error(`水果產季比去年：${Object.keys(out).length} 項，資料到 ${last}`);
  for (const v of VARIETIES) {
    const r = out[`v:${v.id}`];
    if (!r) { console.error(`  ${v.name}：沒有資料`); continue; }
    console.error(`  ${v.name.padEnd(4)} 產季 ${r.label}　${r.status === 'pre' ? `還沒開始（${r.nextStart} 起）；去年整季 ${r.lastSeason?.price ?? '—'} 元`
      : `${r.cur.from}～${r.cur.to} ${r.cur.days} 天 ${r.cur.price} 元（${r.cur.low}–${r.cur.high}）；去年同一段 ${r.prev.price} 元 ${r.prev.days} 天 → ${r.changePct ?? '不比'}%`}`);
  }
  if (cny) console.error(`  除夕 ${cny.eve}（採買月 ${cny.months.join('、')}）當季：${cny.inSeason.map((x) => `${out[x.key].name} ${x.sharePct}%`).join('、')}；拜拜：${cny.offering.map((k) => out[k].name).join('、')}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
