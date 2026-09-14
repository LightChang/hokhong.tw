// L0 → L1：ingest/raw/farm-trans/YYYY/*.json.gz → data/parquet/farm_trans/year=YYYY/d-YYYY-MM-DD.parquet
//
// 一天一檔。同名檔是覆蓋（實測），所以重跑同一天是冪等的，不會產生重複列。
// 不要改用 PARTITION_BY 做增量：實測會把整個年分區清成單日（見 transform/STORAGE.md §4）。
//
// 用法：
//   node transform/to-parquet.mjs              # 只轉還沒轉的、或 raw 比 parquet 新的
//   node transform/to-parquet.mjs --rebuild     # 全部重轉
//   node transform/to-parquet.mjs --recent 7    # 只轉最近 7 天（每日排程用）
import { mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect, one, q, RAW, PARQUET, L1_SELECT, readL1, num, today } from './_db.mjs';

const FARM = join(RAW, 'farm-trans');

async function rawDays() {
  const out = [];
  for (const y of (await readdir(FARM)).filter((n) => /^\d{4}$/.test(n)).sort())
    for (const f of (await readdir(join(FARM, y))).sort().filter((n) => n.endsWith('.json.gz')))
      out.push({ date: f.slice(0, 10), year: y, src: join(FARM, y, f), dst: join(PARQUET, `year=${y}`, `d-${f.slice(0, 10)}.parquet`) });
  return out;
}

const mtime = async (p) => (await stat(p).catch(() => null))?.mtimeMs ?? null;

async function main() {
  const argv = process.argv.slice(2);
  const rebuild = argv.includes('--rebuild');
  const recentIdx = argv.indexOf('--recent');
  const con = await connect();

  let days = await rawDays();
  if (recentIdx >= 0) {
    const n = Number(argv[recentIdx + 1]);
    if (!Number.isInteger(n) || n < 1) throw new Error('--recent 要接天數');
    const from = new Date(`${today()}T00:00:00Z`);
    from.setUTCDate(from.getUTCDate() - (n - 1));
    const fromIso = from.toISOString().slice(0, 10);
    days = days.filter((d) => d.date >= fromIso);
  }

  let written = 0, skipped = 0, empty = 0;
  const emptyDays = [];
  for (const d of days) {
    if (!rebuild) {
      const [ms, md] = [await mtime(d.src), await mtime(d.dst)];
      if (md !== null && ms !== null && md >= ms) { skipped++; continue; }
    }
    await mkdir(join(PARQUET, `year=${d.year}`), { recursive: true });
    try {
      await con.run(`COPY (${L1_SELECT} FROM read_json_auto('${d.src}')) TO '${d.dst}' (FORMAT parquet, COMPRESSION zstd)`);
      written++;
    } catch (e) {
      // 休市／無資料日的 raw 是 []，read_json_auto 推不出 schema。記錄後跳過，不是錯誤。
      if (/No files found|Could not|schema|empty|Binder Error|Invalid Input/i.test(e.message)) { empty++; emptyDays.push(d.date); continue; }
      throw new Error(`${d.date}: ${e.message.split('\n')[0]}`);
    }
    if (written % 500 === 0) console.error(`  已轉 ${written} 天…`);
  }

  // "days" 與 "rows" 都是 DuckDB 保留字，別名要避開
  const total = await one(con, `SELECT count(*)::VARCHAR n, count(DISTINCT "交易日期")::VARCHAR n_days, min("交易日期") f, max("交易日期") l FROM ${readL1()}`);
  const byYear = await q(con, `SELECT year, count(*)::VARCHAR n FROM ${readL1()} GROUP BY 1 ORDER BY 1`);
  console.error(`寫入 ${written} 天、略過 ${skipped} 天、空檔 ${empty} 天（${emptyDays.join(', ') || '無'}）`);
  console.error(`L1 現況：${total.n} 列 / ${total.n_days} 個交易日 / ${total.f} ~ ${total.l}`);

  await writeFile(join(PARQUET, '..', 'farm_trans.meta.json'), JSON.stringify({
    builtAt: new Date().toISOString(), rows: total.n, days: total.n_days, first: total.f, last: total.l,
    emptyRawDays: emptyDays, byYear: Object.fromEntries(byYear.map((r) => [num(r.year), r.n])),
  }, null, 1) + '\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
