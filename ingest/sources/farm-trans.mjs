// 農產品交易行情（蔬菜 N04／水果 N05／花卉 N06）逐日回補。
// 只取原始資料，不改欄位、不轉型。每天一檔：ingest/raw/farm-trans/YYYY/YYYY-MM-DD.json.gz
// 另寫 ingest/raw/farm-trans/manifest.jsonl：每次取得一行 {date, count, pages, bytes, ms, fetchedAt}
//
// 用法：
//   node ingest/sources/farm-trans.mjs                       # 2012-01-01 → 今天，已存在的日期略過
//   node ingest/sources/farm-trans.mjs 2026-09-01 2026-09-11 # 指定區間
//   node ingest/sources/farm-trans.mjs --refetch 2026-09-08 2026-09-11  # 覆寫（抓事後修正用）
//   node ingest/sources/farm-trans.mjs --refetch --recent 7            # 覆寫最近 7 天（每日排程用）

import { mkdir, writeFile, access, appendFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const meta = {
  id: 'farm-trans',
  name: '農產品交易行情',
  org: '農業部農糧署',
  homepage: 'https://data.moa.gov.tw/open_detail.aspx?id=037',
  license: '政府資料開放授權條款-第1版',
  updateFreq: '每日',
  format: 'json',
  entity: 'observation',
  endpoints: [
    'https://data.moa.gov.tw/Service/OpenData/FromM/FarmTransData.aspx?$top=10000&$skip=0&StartDate=115.09.08&EndDate=115.09.08',
  ],
  // 實測：單次回傳上限 10000 筆，超過回 [{errMsg}]；最早資料 101.01.03（100 年整年為 0 筆）
  verifiedAt: '2026-09-11',
};

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'raw', 'farm-trans');
const BASE = 'https://data.moa.gov.tw/Service/OpenData/FromM/FarmTransData.aspx';
const PAGE = 10000;
const CONCURRENCY = 3;
const UA = 'hokhong.tw-ingest/0.1 (+https://hokhong.tw)';

const roc = (d) => `${d.getUTCFullYear() - 1911}.${String(d.getUTCMonth() + 1).padStart(2, '0')}.${String(d.getUTCDate()).padStart(2, '0')}`;
const iso = (d) => d.toISOString().slice(0, 10);

async function getJson(url) {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(180_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      if (Array.isArray(body) && body.length === 1 && body[0].errMsg) throw new Error(body[0].errMsg);
      return body;
    } catch (e) {
      if (attempt >= 4) throw e;
      await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
    }
  }
}

export async function fetchDay(d) {
  const day = roc(d);
  const rows = [];
  let pages = 0;
  for (let skip = 0; ; skip += PAGE) {
    const page = await getJson(`${BASE}?$top=${PAGE}&$skip=${skip}&StartDate=${day}&EndDate=${day}`);
    pages++;
    rows.push(...page);
    if (page.length < PAGE) break;
  }
  return { rows, pages };
}

async function exists(p) {
  try { await access(p); return true; } catch { return false; }
}

async function main() {
  const args = process.argv.slice(2);
  const refetch = args.includes('--refetch');
  const recentIdx = args.indexOf('--recent');
  const today = iso(new Date(Date.now() + 8 * 3600_000));
  let [from = '2012-01-01', to = today] = args.filter((a, i) => !a.startsWith('--') && i - 1 !== recentIdx);
  if (recentIdx >= 0) {
    const days = Number(args[recentIdx + 1]);
    if (!Number.isInteger(days) || days < 1) throw new Error('--recent 要接天數，例如 --recent 7');
    const start = new Date(`${today}T00:00:00Z`);
    start.setUTCDate(start.getUTCDate() - (days - 1));
    [from, to] = [iso(start), today];
  }

  const days = [];
  for (let d = new Date(`${from}T00:00:00Z`); iso(d) <= to; d.setUTCDate(d.getUTCDate() + 1)) days.push(new Date(d));

  await mkdir(ROOT, { recursive: true });
  const manifest = join(ROOT, 'manifest.jsonl');
  let done = 0, skipped = 0, failed = 0;

  const queue = [...days];
  async function worker() {
    for (let d; (d = queue.shift()); ) {
      const file = join(ROOT, String(d.getUTCFullYear()), `${iso(d)}.json.gz`);
      if (!refetch && (await exists(file))) { skipped++; continue; }
      const t0 = Date.now();
      try {
        const { rows, pages } = await fetchDay(d);
        const buf = gzipSync(JSON.stringify(rows));
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, buf);
        await appendFile(manifest, JSON.stringify({ date: iso(d), count: rows.length, pages, bytes: buf.length, ms: Date.now() - t0, fetchedAt: new Date().toISOString() }) + '\n');
        done++;
      } catch (e) {
        failed++;
        console.error(`FAIL ${iso(d)} ${e.message}`);
      }
      if ((done + failed) % 50 === 0) console.error(`progress done=${done} skipped=${skipped} failed=${failed} remaining=${queue.length}`);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  console.error(`finished done=${done} skipped=${skipped} failed=${failed} of ${days.length}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
