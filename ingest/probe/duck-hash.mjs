// 驗證 observation 層 append-only 的成本：
//   1. 對 1,469 萬列算 contentHash（價格四欄 + 交易量）要多久
//   2. 與「前一版」比對出變更列（anti-join）要多久
//   3. observation 現值表（鍵 + hash + 三個時間欄）存成 Parquet 有多大
// 用法：node ingest/probe/duck-hash.mjs [暫存目錄]
import { mkdir, rm, stat } from 'node:fs/promises';
import { DuckDBInstance } from '@duckdb/node-api';

const DIR = process.argv[2] ?? '/tmp/hokhong-hash';
await rm(DIR, { recursive: true, force: true });
await mkdir(DIR, { recursive: true });

const ALL = `read_json_auto('ingest/raw/farm-trans/*/*.json.gz', union_by_name=true)`;
const J = (x) => JSON.stringify(x, (k, v) => (typeof v === 'bigint' ? v.toString() : v));

const inst = await DuckDBInstance.create(':memory:');
const con = await inst.connect();

async function q(label, sql) {
  const t = Date.now();
  try {
    const rows = (await con.runAndReadAll(sql)).getRowObjects();
    console.log(`${label}: ${J(rows).slice(0, 300)}  ${Date.now() - t}ms`);
    return rows;
  } catch (e) {
    console.log(`${label} 失敗: ${e.message.split('\n')[0]}  ${Date.now() - t}ms`);
  }
}

// observation 的鍵：(交易日期, 種類代碼, 市場代號, 作物代號)；內容：四個價格 + 交易量
const OBS = `SELECT
    "交易日期" AS trans_date, coalesce("種類代碼", '') AS tc_type,
    "市場代號" AS market_code, "作物代號" AS crop_code,
    md5(concat_ws('|', "上價", "中價", "下價", "平均價", "交易量")) AS content_hash
  FROM ${ALL}`;

await q('1 算 14.7M 列的 contentHash', `SELECT count(*)::VARCHAR n, count(DISTINCT content_hash)::VARCHAR uniq FROM (${OBS})`);

await q('2 寫出 observation 現值表 Parquet', `COPY (
  SELECT *, '2026-09-12' AS first_observed_at, '2026-09-12' AS last_verified_at, '2026-09-12' AS last_changed_at
  FROM (${OBS})
) TO '${DIR}/observation.parquet' (FORMAT parquet, COMPRESSION zstd)`);
console.log('   observation.parquet 大小:', ((await stat(`${DIR}/observation.parquet`)).size / 1048576).toFixed(1), 'MB');

// 模擬隔日：把今天重抓的 7 天與現值表比對，找出 hash 不同的列（事後修正）
const OBS7 = OBS.replace(`'ingest/raw/farm-trans/*/*.json.gz'`, `'ingest/raw/farm-trans/2026/2026-09-0[4-9].json.gz'`);
await q('3 重抓 7 天 vs 現值表 找變更列', `SELECT count(*)::VARCHAR changed FROM (${OBS7}) t
  JOIN read_parquet('${DIR}/observation.parquet') o USING (trans_date, tc_type, market_code, crop_code)
  WHERE t.content_hash <> o.content_hash`);

await q('4 重抓 7 天 找新增列（現值表沒有的鍵）', `SELECT count(*)::VARCHAR added FROM (${OBS7}) t
  LEFT JOIN read_parquet('${DIR}/observation.parquet') o USING (trans_date, tc_type, market_code, crop_code)
  WHERE o.content_hash IS NULL`);

await q('5 全量比對（最壞情況：14.7M vs 14.7M）', `SELECT count(*)::VARCHAR changed FROM (${OBS}) t
  JOIN read_parquet('${DIR}/observation.parquet') o USING (trans_date, tc_type, market_code, crop_code)
  WHERE t.content_hash <> o.content_hash`);
