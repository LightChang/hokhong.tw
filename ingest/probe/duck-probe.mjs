// DuckDB 儲存方案實測：gz 直讀、schema 推斷、轉 Parquet、Parquet 查詢速度、每日增量寫入行為。
// 用法：node ingest/probe/duck-probe.mjs [輸出目錄]   預設輸出到 /tmp/hokhong-parquet
// 這支只做量測，不寫進 data/。
import { rm, readdir } from 'node:fs/promises';
import { DuckDBInstance } from '@duckdb/node-api';

const OUT = process.argv[2] ?? '/tmp/hokhong-parquet';
const ALL = `read_json_auto('ingest/raw/farm-trans/*/*.json.gz', union_by_name=true)`;
const PQ = `read_parquet('${OUT}/**/*.parquet', hive_partitioning=true)`;
const J = (x) => JSON.stringify(x, (k, v) => (typeof v === 'bigint' ? v.toString() : v));
const YEAR = `CAST(substr("交易日期", 1, 3) AS INT) + 1911`;

const inst = await DuckDBInstance.create(':memory:');
const con = await inst.connect();

async function q(label, sql) {
  const t = Date.now();
  try {
    const rows = (await con.runAndReadAll(sql)).getRowObjects();
    console.log(`${label}: ${J(rows).slice(0, 500)}  ${Date.now() - t}ms`);
    return rows;
  } catch (e) {
    console.log(`${label} 失敗: ${e.message.split('\n')[0]}  ${Date.now() - t}ms`);
  }
}
const ls = async (dir) => (await readdir(dir).catch(() => [])).sort();

await rm(OUT, { recursive: true, force: true });

// "rows" 是 DuckDB 保留字，別名要避開
await q('1 全史筆數與天數', `SELECT count(*)::VARCHAR n_rows, count(DISTINCT "交易日期")::VARCHAR n_days FROM ${ALL}`);
await q('2 schema 推斷', `SELECT column_name, column_type FROM (DESCRIBE SELECT * FROM ${ALL})`);
await q('3 種類代碼為 null', `SELECT count(*)::VARCHAR n FROM ${ALL} WHERE "種類代碼" IS NULL`);
await q('4 按種類聚合（直接掃 gz）', `SELECT "種類代碼" tc, count(*)::VARCHAR n FROM ${ALL} WHERE "作物代號" <> 'rest' GROUP BY 1 ORDER BY 1`);
await q('5 按年分區轉 Parquet', `COPY (SELECT *, ${YEAR} AS year FROM ${ALL})
  TO '${OUT}' (FORMAT parquet, PARTITION_BY (year), COMPRESSION zstd, OVERWRITE_OR_IGNORE)`);
await q('6 查詢 LA1×109 全史', `SELECT count(*)::VARCHAR n, min("交易日期") f, max("交易日期") l, round(avg("平均價"), 2) p
  FROM ${PQ} WHERE "作物代號" = 'LA1' AND "市場代號" = '109'`);
await q('7 查詢 年×種類 全史聚合', `SELECT year, "種類代碼" tc, count(*)::VARCHAR n FROM ${PQ}
  WHERE "作物代號" <> 'rest' GROUP BY 1, 2 ORDER BY 1 DESC, 2 LIMIT 6`);
await q('8 查詢 LA1 月加權均價', `SELECT substr("交易日期", 1, 6) ym, round(sum("平均價" * "交易量") / sum("交易量"), 2) wavg
  FROM ${PQ} WHERE "作物代號" = 'LA1' GROUP BY 1 ORDER BY 1 DESC LIMIT 3`);
await q('9 查詢 單日全市場（首頁用）', `SELECT count(*)::VARCHAR n FROM ${PQ} WHERE "交易日期" = '115.09.08'`);

// ── 每日增量：一天的資料寫進既有的 year=2026 分區，會覆蓋整個分區還是新增檔案？
console.log('\n[增量寫入測試]');
console.log('寫入前 year=2026 檔案:', J(await ls(`${OUT}/year=2026`)));
const before = await q('10a 增量前 2026 筆數', `SELECT count(*)::VARCHAR n FROM ${PQ} WHERE year = 2026`);
await q('10b 單日 COPY 進既有分區（PARTITION_BY + OVERWRITE_OR_IGNORE）',
  `COPY (SELECT *, ${YEAR} AS year FROM read_json_auto('ingest/raw/farm-trans/2026/2026-09-08.json.gz'))
   TO '${OUT}' (FORMAT parquet, PARTITION_BY (year), COMPRESSION zstd, OVERWRITE_OR_IGNORE)`);
console.log('寫入後 year=2026 檔案:', J(await ls(`${OUT}/year=2026`)));
const after = await q('10c 增量後 2026 筆數', `SELECT count(*)::VARCHAR n FROM ${PQ} WHERE year = 2026`);
console.log(`→ 判定: 增量前 ${before?.[0]?.n} → 後 ${after?.[0]?.n}（相同=整個分區被覆蓋成單日；變多=檔案並存需自行去重）`);

// 直接指定檔名寫單一檔案（不用 PARTITION_BY），是否安全地只新增一個檔
await q('11 單日寫成獨立檔（不用 PARTITION_BY）',
  `COPY (SELECT *, ${YEAR} AS year FROM read_json_auto('ingest/raw/farm-trans/2026/2026-09-09.json.gz'))
   TO '${OUT}/year=2026/d-2026-09-09.parquet' (FORMAT parquet, COMPRESSION zstd)`);
console.log('寫入後 year=2026 檔案:', J(await ls(`${OUT}/year=2026`)));
await q('11b 讀回 2026 筆數', `SELECT count(*)::VARCHAR n FROM ${PQ} WHERE year = 2026`);
