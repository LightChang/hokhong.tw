// 產地價 → data/parquet/origin_price.parquet
//
// 來源是農糧署產地價格查報，36.8 萬筆，欄位全是字串：
//   AVGPRICE / PRODUCTNAME / ORGNAME / YEAR / MONTH / PERIOD
//
// PERIOD 有三種：'上旬|中旬|下旬'、''（月價）、'01'–'31'（日價）。
// ORGNAME 有三種：'_'（全國平均）、'當日平均價'（日價的全國）、'縣市_鄉鎮'（查報單位）。
//
// ⚠ 產地價比批發價晚約一個月：批發已到 2026-09-11 時，產地旬價最新只到 2026-08 下旬。
//    所以三層對照的基準旬要以「產地有資料的最新旬」為準，不能用批發的最新旬。
//
// 用法：node transform/origin-price.mjs
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect, one, q, RAW, DATA, J } from './_db.mjs';

const SRC = join(RAW, 'origin-price.json.gz');
const OUT = join(DATA, 'parquet');
const FILE = join(OUT, 'origin_price.parquet');

async function main() {
  const con = await connect();
  await mkdir(OUT, { recursive: true });

  const SELECT = `SELECT
      CAST("YEAR" AS INT)                                   AS year,
      CASE WHEN "MONTH" = '' THEN NULL ELSE CAST("MONTH" AS INT) END AS month,
      CASE "PERIOD" WHEN '上旬' THEN 1 WHEN '中旬' THEN 2 WHEN '下旬' THEN 3 ELSE NULL END AS xun,
      CASE
        WHEN "PERIOD" IN ('上旬', '中旬', '下旬') THEN 'xun'
        WHEN "PERIOD" = '' THEN 'month'
        ELSE 'day'
      END                                                   AS period_type,
      CASE WHEN "PERIOD" NOT IN ('上旬', '中旬', '下旬') AND "PERIOD" <> ''
           THEN CAST("PERIOD" AS INT) END                   AS day,
      "PRODUCTNAME"                                         AS product_name,
      "ORGNAME"                                             AS org_name,
      ("ORGNAME" = '_' OR "ORGNAME" = '當日平均價')          AS is_national,
      CASE WHEN "ORGNAME" LIKE '%\\_%' ESCAPE '\\' AND "ORGNAME" <> '_'
           THEN split_part("ORGNAME", '_', 1) END           AS county,
      CASE WHEN "ORGNAME" LIKE '%\\_%' ESCAPE '\\' AND "ORGNAME" <> '_'
           THEN split_part("ORGNAME", '_', 2) END           AS town,
      TRY_CAST("AVGPRICE" AS DOUBLE)                        AS price
    FROM read_json_auto('${SRC}')`;

  await con.run(`COPY (${SELECT}) TO '${FILE}' (FORMAT parquet, COMPRESSION zstd)`);

  const P = `read_parquet('${FILE}')`;
  const total = await one(con, `SELECT count(*)::VARCHAR n, count(DISTINCT product_name)::VARCHAR products,
      count(DISTINCT county)::VARCHAR counties, sum(CASE WHEN price IS NULL THEN 1 ELSE 0 END)::VARCHAR null_price FROM ${P}`);
  const byType = await q(con, `SELECT period_type, count(*)::VARCHAR n, min(year)::VARCHAR y0, max(year)::VARCHAR y1 FROM ${P} GROUP BY 1 ORDER BY 1`);
  const latestXun = await one(con, `SELECT year, month, xun FROM ${P}
    WHERE period_type = 'xun' AND is_national ORDER BY year DESC, month DESC, xun DESC LIMIT 1`);
  const natCount = await one(con, `SELECT count(DISTINCT product_name)::VARCHAR n FROM ${P}
    WHERE period_type = 'xun' AND is_national AND year = ${latestXun.year} AND month = ${latestXun.month} AND xun = ${latestXun.xun}`);

  console.error(`產地價 → ${FILE}`);
  console.error(`  ${total.n} 列 / ${total.products} 個品名 / ${total.counties} 個縣市 / 價格為空 ${total.null_price} 列`);
  for (const t of byType) console.error(`  ${t.period_type.padEnd(6)} ${String(t.n).padStart(8)} 列  ${t.y0}–${t.y1}`);
  console.error(`  最新的全國旬價：${latestXun.year}-${String(latestXun.month).padStart(2, '0')} 第 ${latestXun.xun} 旬，${natCount.n} 個品名`);

  await writeFile(join(OUT, 'origin_price.meta.json'), JSON.stringify({
    builtAt: new Date().toISOString(),
    rows: total.n, products: total.products, counties: total.counties,
    byPeriodType: Object.fromEntries(byType.map((t) => [t.period_type, t.n])),
    latestNationalXun: { year: Number(latestXun.year), month: Number(latestXun.month), xun: Number(latestXun.xun), products: natCount.n },
  }, null, 1) + '\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
