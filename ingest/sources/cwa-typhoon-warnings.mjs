// 中央氣象署颱風資料庫：歷年發布警報之颱風列表（1958 起，含海上警報起訖時間）。
// 氣象署 opendata API 需會員金鑰；這個是颱風資料庫網頁自己用的 JSON，免金鑰，但要帶 XHR header。
// 用法：node ingest/sources/cwa-typhoon-warnings.mjs → ingest/raw/cwa-typhoon-warnings.json.gz
import { fileURLToPath } from 'node:url';
import { save } from './_moa.mjs';

export const meta = {
  id: 'cwa-typhoon-warnings',
  name: '颱風資料庫－發布警報之颱風列表',
  org: '交通部中央氣象署',
  homepage: 'https://rdc28.cwa.gov.tw/TDB/public/warning_typhoon_list/',
  license: '政府網站資料開放宣告',
  updateFreq: '每次颱風警報',
  format: 'json',
  entity: 'event',
  endpoints: ['https://rdc28.cwa.gov.tw/TDB/public/warning_typhoon_list/get_warning_typhoon'],
  recordCount: 455,
  verifiedAt: '2026-09-11',
};

export async function fetchRaw() {
  const res = await fetch(meta.endpoints[0], {
    method: 'POST',
    headers: {
      'X-Requested-With': 'XMLHttpRequest',
      Referer: meta.homepage,
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'hokhong.tw-ingest/0.1 (+https://hokhong.tw)',
    },
    body: 'year=all',
    signal: AbortSignal.timeout(90_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return JSON.parse((await res.text()).replace(/^﻿/, ''));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await save(meta.id, await fetchRaw());
