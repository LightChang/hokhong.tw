// 驗證：每日重抓時，把同一天重新寫進同一個 Parquet 檔名，是覆蓋、追加還是報錯？
// 這決定「每日重抓近 7 天」能不能冪等。
// 用法：node ingest/probe/duck-overwrite.mjs [暫存目錄]
import { mkdir, rm } from 'node:fs/promises';
import { DuckDBInstance } from '@duckdb/node-api';

const DIR = process.argv[2] ?? '/tmp/hokhong-overwrite';
await rm(DIR, { recursive: true, force: true });
await mkdir(DIR, { recursive: true });

const inst = await DuckDBInstance.create(':memory:');
const con = await inst.connect();
const file = `${DIR}/d-test.parquet`;
const read = async () => {
  const rows = (await con.runAndReadAll(`SELECT count(*) n, sum(v) s FROM read_parquet('${file}')`)).getRowObjects();
  return JSON.stringify(rows, (k, v) => (typeof v === 'bigint' ? v.toString() : v));
};

await con.run(`COPY (SELECT unnest([1, 2, 3]) AS v) TO '${file}' (FORMAT parquet, COMPRESSION zstd)`);
console.log('第一次寫入（3 列，和 6）:', await read());

try {
  await con.run(`COPY (SELECT unnest([10, 20]) AS v) TO '${file}' (FORMAT parquet, COMPRESSION zstd)`);
  console.log('同名再寫入（2 列，和 30）:', await read());
  console.log('→ 判定: 若為 n=2 s=30 則是「覆蓋」，重抓同一天冪等；若 n=5 則是追加，需自行去重');
} catch (e) {
  console.log('同名再寫入失敗:', e.message.split('\n')[0], '→ 需要先刪檔或加 OVERWRITE 選項');
}
