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
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect, one, q, DATA, RAW, J, num } from './_db.mjs';

const AGG = join(DATA, 'agg');
const PAGE = join(DATA, 'page', 'meat');

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
  const list = items.map((r) => ({
    slug: r.slug, item: r.item, group: r.group, unit: r.unit,
    price: num(r.price), refPrice: num(r.ref_price), refYears: num(r.ref_years),
    changePct: r.change_pct == null ? null : num(r.change_pct), days: num(r.n_days),
  }));

  await writeFile(join(PAGE, 'index.json'), J({ lastDate, xunLabel, items: list }) + '\n');
  for (const it of list) {
    await writeFile(join(PAGE, `${it.slug}.json`),
      J({ ...it, lastDate, xunLabel, monthly: mSeries[it.slug] ?? [], daily: dSeries[it.slug] ?? [] }) + '\n');
  }

  const meta = { builtAt: new Date().toISOString(), rows: src.n, items: src.items, from: src.f, to: src.l };
  await writeFile(join(AGG, 'animal.meta.json'), JSON.stringify(meta, null, 1) + '\n');
  console.error(`  ${list.length} 個品項 → data/page/meat/ | 本旬 ${xunLabel}，最後日期 ${lastDate}`);
  console.error(`  抽樣：${J(list.slice(0, 3))}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
