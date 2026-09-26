// 畜禽行情：raw → 正規化長表 → 聚合 → 頁面 JSON。
//
// 為什麼不走 farm-trans 那條管線：來源形狀完全不同。蔬果是「一列一筆交易」，
// 畜禽是「一列一天、每個品項各一欄」（家禽）或「一列一天一市場、依重量級距分欄」（毛豬），
// 而且沒有作物代碼可以對到 CROP_UID，所以不進 L1，也不經過 identify。
//
// 正規化後的長表欄位：date, group, item, slug, region, price, unit, volume（僅毛豬有頭數）
//
// 產出：
//   data/agg/animal_day.parquet    品項 × 地區 × 日
//   data/agg/animal_month.parquet  品項 × 月（全國）
//   data/page/meat/index.json      /meat 清單頁
//   data/page/meat/<slug>.json     每個品項一頁
//
// 用法：node transform/animal.mjs
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect, one, q, DATA, RAW, ROOT, J, num } from './_db.mjs';

const AGG = join(DATA, 'agg');
const PAGE = join(DATA, 'page', 'meat');
const CATTY = 0.6;              // 1 台斤 = 0.6 公斤（毛豬是元/公斤，要換才可比）
const RETAIL_DAYS = 30;         // 零售取近幾個訪價日
const OUTLIER_RATIO = 3;        // 某市場中位價超過全體中位這麼多倍就剔除該市場

// 家禽是寬表：一個欄位就是一個品項。slug 要穩定（會變成網址），所以寫死不由中文推導。
const POULTRY = {
  'animal-chicken-egg': [
    { col: '白肉雞(2.0Kg以上)', item: '白肉雞（2 公斤以上）', slug: 'broiler-2kg', group: '雞' },
    { col: '白肉雞(1.75-1.95Kg)', item: '白肉雞（1.75–1.95 公斤）', slug: 'broiler-18kg', group: '雞' },
    { col: '白肉雞(門市價高屏)', item: '白肉雞（高屏門市價）', slug: 'broiler-retail-kp', group: '雞' },
    { col: '雞蛋(產地價)', item: '雞蛋（產地價）', slug: 'egg-farm', group: '蛋' },
    { col: '雞蛋(大運輸價)', item: '雞蛋（大運輸價）', slug: 'egg-wholesale', group: '蛋' },
  ],
  'animal-goose-duck': [
    { col: '肉鵝(白羅曼)', item: '肉鵝（白羅曼）', slug: 'goose', group: '鵝鴨' },
    { col: '正番鴨(公)', item: '正番鴨（公）', slug: 'muscovy-duck', group: '鵝鴨' },
    { col: '土番鴨(75天)', item: '土番鴨（75 天）', slug: 'mule-duck', group: '鵝鴨' },
    { col: '鴨蛋(新蛋)(台南)', item: '鴨蛋（台南新蛋）', slug: 'duck-egg', group: '蛋' },
  ],
  'animal-red-chicken': [
    { col: '紅羽土雞北區(公)', item: '紅羽土雞北區（公）', slug: 'red-chicken-n-m', group: '雞' },
    { col: '紅羽土雞北區(母)', item: '紅羽土雞北區（母）', slug: 'red-chicken-n-f', group: '雞' },
    { col: '紅羽土雞中區(公)', item: '紅羽土雞中區（公）', slug: 'red-chicken-c-m', group: '雞' },
    { col: '紅羽土雞中區(母)', item: '紅羽土雞中區（母）', slug: 'red-chicken-c-f', group: '雞' },
    { col: '紅羽土雞南雞(公)', item: '紅羽土雞南區（公）', slug: 'red-chicken-s-m', group: '雞' },
    { col: '紅羽土雞南雞(母)', item: '紅羽土雞南區（母）', slug: 'red-chicken-s-f', group: '雞' },
  ],
};

// 來源的價格欄位是字串，實測出現過這些非數字值：
//   '休市'、'-'、'議價'  → 當天沒有價格，null
//   '41-42'             → 報價區間，取中點（來源就是這樣公告的）
//   '31..8'             → 打錯的小數點，無法還原，null
const parsePrice = (v) => {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s || s === '休市' || s === '-' || s === '議價') return null;
  const range = s.match(/^(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)$/);
  if (range) return (Number(range[1]) + Number(range[2])) / 2;
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? n : null;
};

const readRaw = async (id) => JSON.parse(gunzipSync(await readFile(join(RAW, `${id}.json.gz`))));

const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };
const quant = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))] : null; };
const rd1 = (v) => (v == null ? null : +Number(v).toFixed(1));

// 臺中市公有零售市場的肉蛋欄位 → 每個 slug 的零售實測。
// 兩件事在這裡處理掉：
//   1. 少數市場在水產欄位報的是整籃／整尾價。判準是「該市場中位價 > 全體中位 × 3」，
//      剔除那個市場並逐筆印出來（壞資料指名跳過，不是整批丟掉也不是默默吃下去）。
//   2. 價帶用 p25–p75，不用 min–max：跟蔬果同一套判準。
async function retailByslug() {
  const map = JSON.parse(await readFile(join(ROOT, 'overrides', 'meat-retail-map.json'), 'utf-8'));
  const dir = join(RAW, 'taichung-retail');
  const files = (await readdir(dir).catch(() => [])).filter((f) => f.endsWith('.json.gz')).sort();
  if (!files.length) return { bySlug: new Map(), dropped: [], days: 0, markets: 0 };
  // 每個抓取檔都含來源近一年全量，合併去重（市場＋訪價日）
  const seen = new Map();
  for (const f of files) {
    for (const r of JSON.parse(gunzipSync(await readFile(join(dir, f))))) seen.set(`${r['市場名稱']}|${r['訪價日期']}`, r);
  }
  const all = [...seen.values()];
  const days = [...new Set(all.map((r) => r['訪價日期']))].sort().slice(-RETAIL_DAYS);
  const recent = all.filter((r) => days.includes(r['訪價日期']));

  const bySlug = new Map();
  const dropped = [];
  for (const [col, cfg] of Object.entries(map.columns)) {
    const byMkt = new Map();
    for (const r of recent) {
      const v = Number(r[col]);
      if (v > 0) {
        if (!byMkt.has(r['市場名稱'])) byMkt.set(r['市場名稱'], []);
        byMkt.get(r['市場名稱']).push(v);
      }
    }
    if (!byMkt.size) continue;
    const mktMed = [...byMkt].map(([m, vs]) => ({ m, med: median(vs) }));
    const overall = median(mktMed.map((x) => x.med));
    const keep = [];
    for (const { m, med: mm } of mktMed) {
      if (overall && (mm > overall * OUTLIER_RATIO || mm < overall / OUTLIER_RATIO)) {
        dropped.push(`${col}／${m}：中位 ${mm}，全體中位 ${overall}（報的應該不是元/台斤）`);
        continue;
      }
      keep.push(m);
    }
    const vals = keep.flatMap((m) => byMkt.get(m));
    if (!vals.length) continue;
    const rec = {
      column: col, perCatty: rd1(median(vals)), p25: rd1(quant(vals, 0.25)), p75: rd1(quant(vals, 0.75)),
      markets: keep.length, samples: vals.length, days: days.length, lastVisit: days.at(-1),
      cut: cfg.cut ?? null, approx: cfg.approx === true,
    };
    for (const slug of [cfg.slug, ...(cfg.also ?? [])]) {
      if (!bySlug.has(slug)) bySlug.set(slug, []);
      bySlug.get(slug).push(rec);
    }
  }
  return { bySlug, dropped, days: days.length, markets: new Set(recent.map((r) => r['市場名稱'])).size };
}

// 民國 1150915 → 2026-09-15
const rocToIso = (s) => {
  const t = String(s).trim();
  if (!/^\d{7}$/.test(t)) return null;
  return `${Number(t.slice(0, 3)) + 1911}-${t.slice(3, 5)}-${t.slice(5, 7)}`;
};

async function buildRows() {
  const rows = [];

  // 毛豬：一列一天一市場。價格用「成交頭數-平均價格」（元/公斤），量是頭數。
  // 各縣市與各市場並存（來源同時有「高雄旗山」與「旗山區」這種新舊名），一律照原樣當地區，
  // 不做合併——合併需要一份對照表，那是猜的。全國均價在 SQL 端用頭數加權算。
  for (const r of await readRaw('animal-hog')) {
    const date = rocToIso(r['交易日期']);
    const price = parsePrice(r['成交頭數-平均價格']);
    const heads = Number(r['成交頭數-總數']);
    if (!date || price == null || !(heads > 0)) continue;
    rows.push({ date, group: '豬', item: '毛豬', slug: 'hog', region: String(r['市場名稱']).trim(),
      price, unit: '元/公斤', volume: heads });
  }

  // 家禽：寬表 → 長表。來源是產地價，沒有交易量，全國只有一個報價。
  for (const [id, cols] of Object.entries(POULTRY)) {
    for (const r of await readRaw(id)) {
      const date = String(r['日期'] ?? '').trim().replace(/\//g, '-');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
      for (const c of cols) {
        const price = parsePrice(r[c.col]);
        if (price == null) continue;
        rows.push({ date, group: c.group, item: c.item, slug: c.slug, region: '全國',
          price, unit: '元/台斤', volume: null });
      }
    }
  }
  return rows;
}

async function main() {
  const con = await connect();
  await mkdir(AGG, { recursive: true });
  await mkdir(PAGE, { recursive: true });

  const rows = await buildRows();
  const ndjson = join(AGG, 'animal_raw.ndjson');
  await writeFile(ndjson, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  await con.run(`CREATE TEMP TABLE base AS
    SELECT CAST(date AS DATE) AS trans_date, "group", item, slug, region,
           CAST(price AS DOUBLE) AS price, unit, CAST(volume AS DOUBLE) AS volume
      FROM read_json('${ndjson}', columns={date:'VARCHAR', "group":'VARCHAR', item:'VARCHAR',
                     slug:'VARCHAR', region:'VARCHAR', price:'DOUBLE', unit:'VARCHAR', volume:'DOUBLE'},
                     format='newline_delimited')`);

  const src = await one(con, `SELECT count(*)::VARCHAR n, count(DISTINCT slug)::VARCHAR items,
    min(trans_date)::VARCHAR f, max(trans_date)::VARCHAR l FROM base`);
  console.error(`畜禽來源：${src.n} 列 / ${src.items} 品項 / ${src.f} ~ ${src.l}`);

  // 有頭數的（毛豬）用頭數加權，沒有的（家禽產地價）就是當天那一個報價
  const WAVG = `CASE WHEN sum(volume) > 0 THEN sum(price * volume) / sum(volume) ELSE avg(price) END`;
  const day = `SELECT trans_date, "group", slug, any_value(item) AS item, any_value(unit) AS unit,
      round(${WAVG}, 2) AS price, sum(volume) AS volume, count(DISTINCT region) AS n_regions
    FROM base GROUP BY 1, 2, 3`;
  const month = `SELECT year(trans_date) AS year, month(trans_date) AS month, "group", slug,
      any_value(item) AS item, any_value(unit) AS unit,
      round(${WAVG}, 2) AS price, count(DISTINCT trans_date) AS n_days
    FROM base GROUP BY 1, 2, 3, 4`;

  await con.run(`COPY (${day}) TO '${join(AGG, 'animal_day.parquet')}' (FORMAT parquet, COMPRESSION zstd)`);
  await con.run(`COPY (${month}) TO '${join(AGG, 'animal_month.parquet')}' (FORMAT parquet, COMPRESSION zstd)`);

  // ── 頁面資料 ──────────────────────────────
  // 主數字與蔬果一致：本旬價 vs 近三年同旬。旬（上／中／下）沿用 aggregate.mjs 的切法。
  const XUN = `CASE WHEN day(trans_date) <= 10 THEN 1 WHEN day(trans_date) <= 20 THEN 2 ELSE 3 END`;
  const last = await one(con, `SELECT max(trans_date)::VARCHAR d FROM base`);
  const cur = await one(con, `SELECT year(CAST('${last.d}' AS DATE)) y, month(CAST('${last.d}' AS DATE)) m,
    CASE WHEN day(CAST('${last.d}' AS DATE)) <= 10 THEN 1 WHEN day(CAST('${last.d}' AS DATE)) <= 20 THEN 2 ELSE 3 END x`);

  const items = await q(con, `
    WITH xun AS (
      SELECT slug, any_value(item) AS item, any_value("group") AS "group", any_value(unit) AS unit,
             year(trans_date) AS y, month(trans_date) AS m, ${XUN} AS x,
             round(${WAVG}, 2) AS price, count(DISTINCT trans_date) AS n_days
        FROM base GROUP BY slug, y, m, x
    ),
    now AS (SELECT slug, item, "group", unit, price, n_days FROM xun
             WHERE y = ${num(cur.y)} AND m = ${num(cur.m)} AND x = ${num(cur.x)}),
    ref AS (SELECT slug, round(avg(price), 2) AS ref_price, count(*) AS ref_years FROM xun
             WHERE m = ${num(cur.m)} AND x = ${num(cur.x)} AND y BETWEEN ${num(cur.y) - 3} AND ${num(cur.y) - 1}
             GROUP BY slug)
    SELECT n.slug, n.item, n."group", n.unit, n.price, n.n_days,
           r.ref_price, r.ref_years,
           CASE WHEN r.ref_price > 0 THEN round((n.price - r.ref_price) / r.ref_price * 100, 1) END AS change_pct
      FROM now n LEFT JOIN ref r USING (slug)
     ORDER BY change_pct NULLS LAST`);

  const monthly = await q(con, `SELECT slug, year, month, price FROM read_parquet('${join(AGG, 'animal_month.parquet')}')
    ORDER BY slug, year, month`);
  const daily = await q(con, `SELECT slug, trans_date::VARCHAR d, price FROM read_parquet('${join(AGG, 'animal_day.parquet')}')
    WHERE trans_date >= CAST('${last.d}' AS DATE) - INTERVAL 90 DAY ORDER BY slug, trans_date`);

  const byItem = (rows, key) => rows.reduce((m, r) => ((m[r.slug] ??= []).push(key(r)), m), {});
  const mSeries = byItem(monthly, (r) => ({ x: `${num(r.year)}-${String(num(r.month)).padStart(2, '0')}`, y: num(r.price) }));
  const dSeries = byItem(daily, (r) => ({ x: r.d, y: num(r.price) }));

  const lastDate = last.d;
  const xunLabel = `${num(cur.y)}-${String(num(cur.m)).padStart(2, '0')} ${['上', '中', '下'][num(cur.x) - 1]}旬`;
  // 零售實測：肉蛋原本只有產地價／批發價，那不是買菜的人付的價
  const retail = await retailByslug();
  const list = items.map((r) => {
    const slug = r.slug;
    const price = num(r.price);
    const cuts = (retail.bySlug.get(slug) ?? []).map((x) => {
      // 毛豬是元/公斤，零售是元/台斤：先把來源價換成台斤才可比（紅線：單位不可混算）
      const basePerCatty = r.unit === '元/公斤' ? price * CATTY : price;
      return {
        ...x,
        // 近似對應（仿雞）不給倍率：那條倍率會被當成結論讀，但它的分母不是同一種雞
        ratio: x.approx || !basePerCatty ? null : +(x.perCatty / basePerCatty).toFixed(2),
        basePerCatty: rd1(basePerCatty),
      };
    });
    // 部位順序照攤子上的講法排，不要照字串排（照字串排會變成五花、後腿、里肌）
    const CUT_ORDER = ['里肌', '後腿', '五花'];
    cuts.sort((a, b) => {
      const ia = CUT_ORDER.indexOf(a.cut ?? ''), ib = CUT_ORDER.indexOf(b.cut ?? '');
      if (ia !== ib) return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
      // 近似對應的排後面，不要被當成主要那一欄
      return (a.approx ? 1 : 0) - (b.approx ? 1 : 0);
    });
    return {
      slug, item: r.item, group: r.group, unit: r.unit,
      price, refPrice: num(r.ref_price), refYears: num(r.ref_years),
      changePct: r.change_pct == null ? null : num(r.change_pct), days: num(r.n_days),
      // 一個品項可能對到多個零售欄（毛豬 → 里肌／後腿／五花）
      retail: cuts.length ? cuts : null,
      retailMeta: cuts.length ? { days: retail.days, marketsAll: retail.markets } : null,
    };
  });

  await writeFile(join(PAGE, 'index.json'), J({ lastDate, xunLabel, items: list }) + '\n');
  for (const it of list) {
    await writeFile(join(PAGE, `${it.slug}.json`),
      J({ ...it, lastDate, xunLabel, monthly: mSeries[it.slug] ?? [], daily: dSeries[it.slug] ?? [] }) + '\n');
  }

  const meta = { builtAt: new Date().toISOString(), rows: src.n, items: src.items, from: src.f, to: src.l };
  await writeFile(join(AGG, 'animal.meta.json'), JSON.stringify(meta, null, 1) + '\n');
  console.error(`  ${list.length} 個品項 → data/page/meat/ | 本旬 ${xunLabel}，最後日期 ${lastDate}`);
  const withRetail = list.filter((x) => x.retail);
  console.error(`  零售實測：${withRetail.length} 個品項對到臺中公有市場（近 ${retail.days} 個訪價日）`
    + `；${withRetail.slice(0, 4).map((x) => `${x.item.replace(/（.*/, '')} ${x.retail[0].perCatty} 元/台斤${x.retail[0].ratio ? `（${x.retail[0].ratio} 倍）` : ''}`).join('、')}`);
  if (retail.dropped.length) {
    console.error(`  剔除 ${retail.dropped.length} 個市場×欄位（單位不是元/台斤）：`);
    for (const d of retail.dropped) console.error(`    ${d}`);
  }
  console.error(`  抽樣：${J(list.slice(0, 3))}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
