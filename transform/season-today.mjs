// 當季蔬果（/season/、/season/<月>/）與今日菜價（/today/）的資料。站主 2026-09-28 核可這兩種新頁型。
//
// 兩頁回答的是搜尋框裡實際在打的問題（Google 自動完成 2026-09-28）：
//   「當季水果」「當季水果表」「10月 水果 產季」「當季蔬菜有哪些」  → /season/<月>/
//   「今日菜價查詢」「菜價查詢」「高麗菜 一斤多少錢」              → /today/
// 跟 /cheap/ 的分工：/cheap/ 是「跟常年比最便宜／最貴」的排行（只收比得出漲跌的品項），
// /today/ 是全部可收錄品項的查價表（不排名、比不出漲跌的也列，照分類與名稱排）。
//
// 當季的定義用農糧署盛產表（ingest/raw/peak-season-origin，逐月逐產地），不是 crop-profile 的「量累積 80%」：
// 後者有一百多個品項全年都算產季，拿來回答「10 月當季水果有哪些」會把整張表列滿，沒有資訊。
// 盛產表的作物名對到站上品項的規則跟 emit-page 的「當季」標籤同一套（overrides/season-name-map.json）。
//
// 每個月的表：
//   資料所在的月份（全站最後交易日的月份）：最近交易日的全國批發價、最近完整旬跟近三年同旬比、台中零售
//   其他月份：往年這個月的全國批發均價（crop-profile 同一段完整年、至少 MIN_YEARS 年有量才給）、
//             一年裡最便宜的月份（crop-profile 算好的）
// 算不出來的欄一律空著（頁面顯示「—」），不補估計值。
//
// 產出 data/page/season.json、data/page/today.json。
// 用法：node transform/season-today.mjs（要在 emit-page、crop-profile、animal 之後）
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA, RAW, ROOT, connect, q } from './_db.mjs';

const PAGE = join(DATA, 'page');
const MIN_YEARS = 3;   // 往年同月均價至少要幾個完整年有量
// /today/ 的「小吃店常用佐料」：固定一組，不隨行情換（站主 2026-11-24 核可，依據見 seo-ops
// notes/hokhong-feature-ideas-2026-11-24.md 第 3 項：香菜、九層塔、蒜苗、蔥價這類查詢）。
// 用 plv3_key 對，不用名稱——名稱會改俗名。蒜用「蒜頭」：有台中零售實測、交易量也比「大蒜」大。
const CONDIMENTS = [
  ['N04', '00202029003'],   // 青蔥（蔥）
  ['N04', '00202029002'],   // 蒜頭
  ['N04', '00203166008'],   // 薑
  ['N04', '00208075002'],   // 辣椒
  ['N04', '00201170031'],   // 香菜（芫荽）
  ['N04', '00201077045'],   // 九層塔（羅勒）
  ['N04', '00201170030'],   // 芹菜
];
const VOL_BASE_YEARS = 3;   // 到貨量跟近幾年同一旬比；三年都要有量才比，跟價格的「常年同旬」同一個口徑
const rd = (v, n = 1) => (v == null ? null : +Number(v).toFixed(n));
const readJson = async (p, fb) => JSON.parse(await readFile(p, 'utf-8').catch((e) => {
  if (fb !== undefined) return JSON.stringify(fb);
  throw e;
}));

// 一個品項最近一個有成交的日子，全國（各市場交易量加權）均價
function dayPrice(daily90) {
  const rows = (daily90 ?? []).filter((r) => r.price > 0 && r.volume > 0);
  if (!rows.length) return null;
  const d = rows.reduce((m, r) => (r.d > m ? r.d : m), rows[0].d);
  const on = rows.filter((r) => r.d === d);
  const vol = on.reduce((s, r) => s + r.volume, 0);
  return { date: d, price: rd(on.reduce((s, r) => s + r.price * r.volume, 0) / vol, 1), volume: Math.round(vol), markets: on.length };
}

export async function main() {
  await mkdir(PAGE, { recursive: true });
  const idx = await readJson(join(PAGE, 'index.json'));
  const prof = await readJson(join(PAGE, 'crop-profile.json'), null);
  const meatIdx = await readJson(join(PAGE, 'meat', 'index.json'), { items: [] });
  const season = JSON.parse(gunzipSync(await readFile(join(RAW, 'peak-season-origin.json.gz'))).toString());
  const seasonNameMap = (await readJson(join(ROOT, 'overrides', 'season-name-map.json'), { names: {} })).names ?? {};
  const lastDate = idx.lastDate;
  const dataMonth = Number(lastDate.slice(5, 7));

  // 盛產表作物名 → 站上官方名（規則同 emit-page 的 seasonNamesOf）
  const namesOf = (row) => {
    const m = seasonNameMap[row.crop];
    if (m === undefined) return [row.crop];
    if (m === null) return [];
    if (m === '@variety') return String(row.variety ?? '').split('、').map((x) => x.trim()).filter(Boolean);
    return Array.isArray(m) ? m : [m];
  };

  // 同一個官方名可能有多筆實體（紅龍果在花卉也有一筆、水果有一筆只交易幾天的）：
  // 只取蔬果、可收錄優先、再取近 90 天交易日多的那筆——跟 emit-page 的代表實體同一個想法
  const docs = new Map();
  const cropDoc = async (slug) => {
    if (!docs.has(slug)) docs.set(slug, await readJson(join(PAGE, 'crop', `${slug}.json`)));
    return docs.get(slug);
  };
  const byOfficial = new Map();
  for (const c of idx.crops) {
    if (c.tcType === 'N06') continue;
    const d = await cropDoc(c.slug);
    const cand = { c, days: d.quality?.days90 ?? 0 };
    const prev = byOfficial.get(c.official);
    if (!prev || (c.indexable && !prev.c.indexable) || (c.indexable === prev.c.indexable && cand.days > prev.days)) {
      byOfficial.set(c.official, cand);
    }
  }

  // 月 → 官方名 → 產地縣市（照盛產表原文，縣市數多的排前面）
  const monthMap = new Map();
  for (const s of season) {
    const m = Number(String(s.month ?? '').trim());
    if (!(m >= 1 && m <= 12)) continue;
    for (const n of namesOf(s)) {
      if (!byOfficial.has(n)) continue;
      if (!monthMap.has(m)) monthMap.set(m, new Map());
      const counties = monthMap.get(m).get(n) ?? new Map();
      if (s.county) counties.set(s.county, (counties.get(s.county) ?? 0) + 1);
      monthMap.get(m).set(n, counties);
    }
  }

  const years = prof?.definition?.seasonYears ?? null;   // [起, 迄] 完整年，跟產季、最便宜月份同一段
  const typicalOf = (doc, m) => {
    if (!years) return null;
    const pts = (doc.monthly ?? []).filter((p) => Number(p.ym.slice(5, 7)) === m
      && Number(p.ym.slice(0, 4)) >= years[0] && Number(p.ym.slice(0, 4)) <= years[1] && p.price > 0);
    if (pts.length < MIN_YEARS) return null;
    return { price: rd(pts.reduce((s, p) => s + p.price, 0) / pts.length, 1), years: pts.length };
  };

  const months = [];
  for (let m = 1; m <= 12; m++) {
    const items = [];
    for (const [official, counties] of monthMap.get(m) ?? []) {
      const { c } = byOfficial.get(official);
      const doc = await cropDoc(c.slug);
      const p = prof?.byCrop?.[`${c.tcType}|${c.plv3Key}`]?.season ?? null;
      const isNow = m === dataMonth;
      const day = isNow ? dayPrice(doc.daily90) : null;
      items.push({
        slug: c.slug, name: c.name, official: c.official, tcType: c.tcType, indexable: c.indexable,
        counties: [...counties].sort((a, b) => b[1] - a[1]).map(([k]) => k).slice(0, 3),
        // 這個月佔全年交易量的比例（crop-profile 的 share），拿來排「這個月最當令」的順序
        share: p?.share?.[m] ?? null,
        typical: typicalOf(doc, m),
        cheapestMonth: p?.cheapestMonth ? { month: p.cheapestMonth.month, label: p.cheapestMonth.label } : null,
        now: isNow ? {
          price: day?.price ?? null, date: day?.date ?? null,
          changePct: doc.change?.changePct ?? null, baseline3y: doc.change?.baseline3y ?? null,
          retail: doc.retail?.perCatty ?? null,
        } : null,
      });
    }
    // 資料月：比常年便宜的排前面（當季又便宜才是真的該買）；其他月：這個月量佔比高的排前面
    items.sort(m === dataMonth
      ? (a, b) => (a.now.changePct ?? Infinity) - (b.now.changePct ?? Infinity) || (b.share ?? 0) - (a.share ?? 0)
      : (a, b) => (b.share ?? -1) - (a.share ?? -1) || a.name.localeCompare(b.name, 'zh-Hant'));
    months.push({
      month: m, isDataMonth: m === dataMonth,
      fruit: items.filter((x) => x.tcType === 'N05'),
      veg: items.filter((x) => x.tcType === 'N04'),
    });
  }
  const seasonDoc = {
    lastDate, dataMonth, xun: (await readJson(join(PAGE, 'cheap-now.json'), {})).targetXun ?? null,
    typicalYears: years, minYears: MIN_YEARS,
    source: '農業部農糧署 農產品盛產月份及產地資訊（盛產表）；價格為農產品交易行情',
    months,
  };

  // ── 今日菜價：全部可收錄的蔬果＋肉蛋
  const today = { lastDate, groups: [] };
  const CAT = { N04: '蔬菜', N05: '水果' };
  for (const tc of ['N04', 'N05']) {
    const rows = [];
    for (const c of idx.crops.filter((x) => x.tcType === tc && x.indexable)) {
      const d = await cropDoc(c.slug);
      const day = dayPrice(d.daily90);
      rows.push({
        slug: c.slug, name: c.name, official: c.official, also: d.also ?? [],
        price: day?.price ?? null, date: day?.date ?? null,
        changePct: d.change?.changePct ?? null, retail: d.retail?.perCatty ?? null,
      });
    }
    rows.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hant'));
    today.groups.push({ id: tc === 'N04' ? 'veg' : 'fruit', label: CAT[tc], unit: '元/公斤', rows });
  }
  const meatRows = [];
  for (const m of meatIdx.items ?? []) {
    const d = await readJson(join(PAGE, 'meat', `${m.slug}.json`), null);
    const lastPt = (d?.daily ?? []).at(-1) ?? null;
    meatRows.push({
      slug: m.slug, name: m.item, group: m.group, unit: m.unit,
      // 毛豬是批發市場成交價，家禽與蛋是產地價——頁面要講明是哪一種
      kind: m.unit === '元/公斤' ? '批發' : '產地',
      price: lastPt?.y ?? null, date: lastPt?.x ?? null,
      changePct: m.changePct ?? null,
      retail: m.retail?.[0] ? { column: m.retail[0].column, perCatty: m.retail[0].perCatty } : null,
    });
  }
  today.groups.push({ id: 'meat', label: '肉蛋', unit: null, rows: meatRows });
  today.xun = seasonDoc.xun;

  // ── 小吃店常用佐料：價格與漲跌跟上面蔬菜表同一筆（同一個 dayPrice、同一個 change），
  // 另外補「到貨量跟近三年同旬比」，旬跟漲跌用的旬相同（cheap-now 的 targetXun，一定是過完的旬）。
  const xm = /^(\d{4})-(\d{2}) ([上中下])旬$/.exec(seasonDoc.xun ?? '');
  const volBy = new Map();
  if (xm) {
    const [ty, tm, tx] = [Number(xm[1]), Number(xm[2]), '上中下'.indexOf(xm[3]) + 1];
    const con = await connect();
    const keys = CONDIMENTS.map(([tc, k]) => `('${tc}','${k}')`).join(',');
    const vr = await q(con, `SELECT tc_type, plv3_key, year::INT AS year, volume
        FROM read_parquet('${join(DATA, 'agg', 'plv3_xun.parquet')}')
       WHERE market_code = 'ALL' AND volume > 0 AND month = ${tm} AND xun = ${tx}
         AND year BETWEEN ${ty - VOL_BASE_YEARS} AND ${ty} AND (tc_type, plv3_key) IN (${keys})`);
    for (const [tc, k] of CONDIMENTS) {
      const mine = vr.filter((r) => r.tc_type === tc && r.plv3_key === k);
      const cur = mine.find((r) => Number(r.year) === ty);
      const base = mine.filter((r) => Number(r.year) < ty).map((r) => Number(r.volume));
      if (!cur || base.length < VOL_BASE_YEARS) continue;
      const avg = base.reduce((a, b) => a + b, 0) / base.length;
      volBy.set(`${tc}|${k}`, { volume: Math.round(Number(cur.volume)), baseVolume: Math.round(avg), volPct: rd(((Number(cur.volume) - avg) / avg) * 100, 1) });
    }
  }
  const vegRows = today.groups.find((g) => g.id === 'veg').rows;
  const condRows = [];
  for (const [tc, k] of CONDIMENTS) {
    const c = idx.crops.find((x) => x.tcType === tc && x.plv3Key === k && x.indexable);
    const r = c && vegRows.find((x) => x.slug === c.slug);
    if (!r) continue;
    const v = volBy.get(`${tc}|${k}`) ?? null;
    condRows.push({ ...r, xunVolume: v?.volume ?? null, volBase: v?.baseVolume ?? null, volPct: v?.volPct ?? null });
  }
  today.condiments = { label: '小吃店常用佐料', xun: seasonDoc.xun, volBaseYears: VOL_BASE_YEARS, rows: condRows };

  await writeFile(join(PAGE, 'season.json'), JSON.stringify(seasonDoc));
  await writeFile(join(PAGE, 'today.json'), JSON.stringify(today));
  const now = months[dataMonth - 1];
  console.error(`當季：${months.map((x) => `${x.month}月 ${x.fruit.length}果${x.veg.length}菜`).join('、')}`
    + ` | 資料月 ${dataMonth} 月有今日價 ${[...now.fruit, ...now.veg].filter((x) => x.now.price != null).length} 項`
    + ` | 今日菜價 ${today.groups.map((g) => `${g.label} ${g.rows.length}`).join('、')}`
    + ` | 佐料 ${today.condiments.rows.length}/${CONDIMENTS.length} 項（到貨量可比 ${today.condiments.rows.filter((r) => r.volPct != null).length}）`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
