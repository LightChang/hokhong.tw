// 聚合層：L1 × 作物身分 → data/agg/*.parquet
//
// 這是 README §6 指出的、seh.tw 沒有的需求：每日 build 不能重算 14 年 × 300 作物 × 20 市場。
// 聚合粒度對齊三層價格（見 ingest/probe/sources.md §6）：
//   批發是品種層（LA1 甘藍-初秋），產地價與 CPI 是作物層 → 一律先彙總到 PLV3（CROP_UID 前 11 碼）
//   產地價主要是「旬」，CPI 是「月」→ 所以要有旬與月兩個表
//
// 產出：
//   data/agg/plv3_day.parquet     作物 × 市場 × 日
//   data/agg/plv3_xun.parquet     作物 × 市場 × 旬
//   data/agg/plv3_month.parquet   作物 × 市場 × 月（market_code='ALL' 為全國）
//   data/agg/market_day.parquet   市場 × 日（市場頁、健康檢查用）
//
// 用法：node transform/aggregate.mjs [--report]
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect, one, q, DATA, readL1, J } from './_db.mjs';

const AGG = join(DATA, 'agg');
const MAP = join(DATA, 'identity', 'crop-map.parquet');

// 民國 "115.09.08" → DATE 2026-09-08
const TO_DATE = `make_date(CAST(substr(t."交易日期", 1, 3) AS INT) + 1911, CAST(substr(t."交易日期", 5, 2) AS INT), CAST(substr(t."交易日期", 8, 2) AS INT))`;
// 旬：1–10 上旬、11–20 中旬、21– 下旬
const XUN = `CASE WHEN CAST(substr(t."交易日期", 8, 2) AS INT) <= 10 THEN 1
                  WHEN CAST(substr(t."交易日期", 8, 2) AS INT) <= 20 THEN 2 ELSE 3 END`;

async function main() {
  const report = process.argv.includes('--report');
  const con = await connect();
  await mkdir(AGG, { recursive: true });

  // 交易列 × 作物身分。只取 confidence >= 0.8 的對應（其餘留在 review queue，見 identify.mjs）
  await con.run(`CREATE TEMP TABLE base AS
    SELECT ${TO_DATE} AS trans_date,
           CAST(substr(t."交易日期", 1, 3) AS INT) + 1911 AS year,
           CAST(substr(t."交易日期", 5, 2) AS INT) AS month,
           ${XUN} AS xun,
           coalesce(t."種類代碼", '') AS tc_type,
           t."市場代號" AS market_code,
           t."作物代號" AS crop_code,
           m.plv3_key, m.plv3, m.crop_uid,
           t."平均價" AS price, t."交易量" AS volume, t."上價" AS upper_price, t."下價" AS lower_price
      FROM ${readL1()} t
      LEFT JOIN read_parquet('${MAP}') m
        ON m.crop_code = t."作物代號" AND m.tc_type = coalesce(t."種類代碼", '')
     WHERE t."作物代號" <> 'rest'
       AND t."交易量" > 0
       AND m.confidence >= 0.8
       -- other-bucket（OX1 其他、91 其他…）的 confidence 是 1.0 但沒有作物身分：
       -- 它們是「其他」收攏桶，不該聚合成一個沒有名字的作物（實測會產出 name=null 的頁面）
       AND m.plv3_key IS NOT NULL`);

  const src = await one(con, `SELECT count(*)::VARCHAR n, count(DISTINCT plv3_key)::VARCHAR crops, count(DISTINCT market_code)::VARCHAR markets FROM base`);
  console.error(`聚合來源：${src.n} 列 / ${src.crops} 個 PLV3 作物 / ${src.markets} 個市場代號`);

  // 加權平均：交易量加權，不是價格的算術平均（不同品種的量差很大）
  const WAVG = `sum(price * volume) / nullif(sum(volume), 0)`;
  const tables = {
    plv3_day: `SELECT trans_date, tc_type, plv3_key, any_value(plv3) AS plv3, market_code,
        round(${WAVG}, 2) AS wavg_price, sum(volume) AS volume,
        round(min(lower_price), 2) AS min_price, round(max(upper_price), 2) AS max_price,
        count(DISTINCT crop_code) AS n_codes
      FROM base GROUP BY 1, 2, 3, 5`,
    // 與 plv3_month 一樣要有 market_code='ALL' 的全國列：
    // 「現在什麼便宜」是拿本旬全國均價比近三年同旬，沒有 ALL 就撈不到東西（實測踩過）
    plv3_xun: `SELECT year, month, xun, tc_type, plv3_key, any_value(plv3) AS plv3, market_code,
        round(${WAVG}, 2) AS wavg_price, sum(volume) AS volume, count(DISTINCT trans_date) AS n_days
      FROM base GROUP BY 1, 2, 3, 4, 5, 7
      UNION ALL
      SELECT year, month, xun, tc_type, plv3_key, any_value(plv3), 'ALL',
        round(${WAVG}, 2), sum(volume), count(DISTINCT trans_date)
      FROM base GROUP BY 1, 2, 3, 4, 5`,
    // market_code='ALL' 是全國（跨市場加權），與各市場列並存，供「全國均價」直接讀
    plv3_month: `SELECT year, month, tc_type, plv3_key, any_value(plv3) AS plv3, market_code,
        round(${WAVG}, 2) AS wavg_price, sum(volume) AS volume, count(DISTINCT trans_date) AS n_days
      FROM base GROUP BY 1, 2, 3, 4, 6
      UNION ALL
      SELECT year, month, tc_type, plv3_key, any_value(plv3), 'ALL',
        round(${WAVG}, 2), sum(volume), count(DISTINCT trans_date)
      FROM base GROUP BY 1, 2, 3, 4`,
    market_day: `SELECT trans_date, tc_type, market_code,
        sum(volume) AS volume, round(${WAVG}, 2) AS wavg_price,
        count(DISTINCT crop_code) AS n_codes, count(DISTINCT plv3_key) AS n_crops
      FROM base GROUP BY 1, 2, 3`,
  };

  const meta = { builtAt: new Date().toISOString(), source: { rows: src.n, crops: src.crops, markets: src.markets }, tables: {} };
  for (const [name, sql] of Object.entries(tables)) {
    const t0 = Date.now();
    const file = join(AGG, `${name}.parquet`);
    if (!report) await con.run(`COPY (${sql}) TO '${file}' (FORMAT parquet, COMPRESSION zstd)`);
    const n = await one(con, `SELECT count(*)::VARCHAR n FROM (${sql})`);
    meta.tables[name] = { rows: n.n, ms: Date.now() - t0 };
    console.error(`  ${name.padEnd(12)} ${String(n.n).padStart(9)} 列  ${Date.now() - t0}ms`);
  }

  // 抽樣自我檢查：高麗菜（甘藍）在台北一的近三個月月均價，人眼看得出合不合理
  const sample = await q(con, `SELECT year, month, market_code, wavg_price, volume::VARCHAR volume, n_days
    FROM (${tables.plv3_month}) WHERE plv3 = '甘藍' AND market_code IN ('109', 'ALL')
    ORDER BY year DESC, month DESC, market_code LIMIT 6`);
  console.error(`抽樣（甘藍 月均價）：${J(sample)}`);

  if (!report) await writeFile(join(AGG, 'agg.meta.json'), JSON.stringify(meta, null, 1) + '\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
