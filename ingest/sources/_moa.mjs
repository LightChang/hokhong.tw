// 農業資料開放平臺共用取得函式。只取原始資料，不改欄位、不轉型。
import { mkdir, writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const RAW = join(dirname(fileURLToPath(import.meta.url)), '..', 'raw');
export const SERVICE = 'https://data.moa.gov.tw/Service/OpenData';
const UA = 'hokhong.tw-ingest/0.1 (+https://hokhong.tw)';

// 2026-10-22 起 data.moa.gov.tw、amis.afa.gov.tw 只讓台灣 IP 連，GitHub runner 改走 GCP 台灣機房的轉發
// （relay/moa/）。MOA_RELAY＝https://<cloud run 網址>/<金鑰>，放在 GitHub secret；沒設就直連（本機在台灣時照舊）。
// 錯誤訊息一律印原始網址，不印轉發網址（金鑰在裡面）。
const RELAY_HOSTS = new Set(['data.moa.gov.tw', 'amis.afa.gov.tw']);
export const viaRelay = (url) => {
  const relay = process.env.MOA_RELAY?.replace(/\/$/, '');
  if (!relay) return url;
  const u = new URL(url);
  return RELAY_HOSTS.has(u.host) ? `${relay}/${u.host}${u.pathname}${u.search}` : url;
};

export async function getJson(url) {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(viaRelay(url), { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(180_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      if (Array.isArray(body) && body.length === 1 && body[0].errMsg) throw new Error(body[0].errMsg);
      return body;
    } catch (e) {
      // fetch failed 本身看不出原因（逾時、被拒、DNS），把底層的 cause 一起帶上
      if (attempt >= 4) throw new Error(`${url}: ${e.message}${e.cause ? `（${e.cause.code ?? e.cause.message}）` : ''}`);
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
