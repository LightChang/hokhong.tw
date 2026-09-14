// 轉換層共用：DuckDB 連線與路徑。
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DuckDBInstance } from '@duckdb/node-api';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const RAW = join(ROOT, 'ingest', 'raw');
export const DATA = join(ROOT, 'data');
export const PARQUET = join(DATA, 'parquet', 'farm_trans');
export const OBS = join(DATA, 'observation');

// 台北時間的今天（來源都是台北時間的營業日）
export const today = () => new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);

export async function connect() {
  const inst = await DuckDBInstance.create(':memory:');
  return await inst.connect();
}

export async function q(con, sql) {
  return (await con.runAndReadAll(sql)).getRowObjects();
}

export async function one(con, sql) {
  const rows = await q(con, sql);
  return rows[0];
}

// BigInt 不能直接 JSON.stringify
export const J = (x) => JSON.stringify(x, (k, v) => (typeof v === 'bigint' ? v.toString() : v));
export const num = (v) => (typeof v === 'bigint' ? Number(v) : v);

// 讀 L1：year 由 hive 分區帶入
export const readL1 = (glob = '**/*.parquet') => `read_parquet('${PARQUET}/${glob}', hive_partitioning=true, union_by_name=true)`;

// L1 的欄位型別寫死，不依賴 read_json_auto 的逐檔推斷
// （某一天若某欄全為 null，推斷型別會與其他天不同，之後 union 會炸）
export const L1_SELECT = `SELECT
    CAST("交易日期" AS VARCHAR)  AS "交易日期",
    CAST("種類代碼" AS VARCHAR)  AS "種類代碼",
    CAST("作物代號" AS VARCHAR)  AS "作物代號",
    CAST("作物名稱" AS VARCHAR)  AS "作物名稱",
    CAST("市場代號" AS VARCHAR)  AS "市場代號",
    CAST("市場名稱" AS VARCHAR)  AS "市場名稱",
    CAST("上價"    AS DOUBLE)   AS "上價",
    CAST("中價"    AS DOUBLE)   AS "中價",
    CAST("下價"    AS DOUBLE)   AS "下價",
    CAST("平均價"  AS DOUBLE)   AS "平均價",
    CAST("交易量"  AS DOUBLE)   AS "交易量"`;

// observation 的鍵與內容雜湊。hash() 是 DuckDB 內建 64-bit，比 md5 省 4 倍空間
// （md5 實測讓現值表膨脹到 246 MB，比主資料還大；碰撞後果只是漏偵測一次修正）
export const OBS_SELECT = `SELECT
    "交易日期"                      AS trans_date,
    coalesce("種類代碼", '')        AS tc_type,
    "市場代號"                      AS market_code,
    "作物代號"                      AS crop_code,
    hash(concat_ws('|', "上價", "中價", "下價", "平均價", "交易量"))::UBIGINT AS content_hash`;
export const OBS_KEY = ['trans_date', 'tc_type', 'market_code', 'crop_code'];
