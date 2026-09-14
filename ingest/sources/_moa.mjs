// 農業資料開放平臺共用取得函式。只取原始資料，不改欄位、不轉型。
import { mkdir, writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const RAW = join(dirname(fileURLToPath(import.meta.url)), '..', 'raw');
export const SERVICE = 'https://data.moa.gov.tw/Service/OpenData';
const UA = 'hokhong.tw-ingest/0.1 (+https://hokhong.tw)';

export async function getJson(url) {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(180_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      if (Array.isArray(body) && body.length === 1 && body[0].errMsg) throw new Error(body[0].errMsg);
      return body;
    } catch (e) {
      if (attempt >= 4) throw new Error(`${url}: ${e.message}`);
      await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
    }
  }
}

// $top/$skip 分頁（單次上限 10000）。不支援分頁的端點會重複回同一批，用首筆比對擋掉。
export async function getPaged(url, page = 10000) {
  const rows = [];
  let first;
  for (let skip = 0; ; skip += page) {
    const sep = url.includes('?') ? '&' : '?';
    const batch = await getJson(`${url}${sep}$top=${page}&$skip=${skip}`);
    const key = JSON.stringify(batch[0]);
    if (skip > 0 && key === first) break;
    first ??= key;
    rows.push(...batch);
    if (batch.length < page) break;
  }
  return rows;
}

export async function save(id, rows) {
  const file = join(RAW, `${id}.json.gz`);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, gzipSync(JSON.stringify(rows)));
  console.error(`${id}: ${rows.length} rows → ${file}`);
}
