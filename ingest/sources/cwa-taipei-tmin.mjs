// 中央氣象署 臺北氣象站（466920）每日最低氣溫：寒流判定用。
//
// 為什麼是臺北站：氣象署的寒流定義就是看這一站——「當臺北市的最低溫度降至 10℃ 或以下時，
// 臺灣即受『寒流』或『寒潮』之侵襲」（氣象署數位科普網〈小石虎的寒流問題〉，DEFINITION_URL）。
// 資料來自氣象署「氣候觀測資料查詢服務」CODiS 的月報表（網頁自己用的 JSON，免金鑰）。
//
// 兩種用法：
//   node ingest/sources/cwa-taipei-tmin.mjs            → 只抓這個月與上個月，寫 ingest/raw/cwa-taipei-tmin.json.gz（每日排程）
//   node ingest/sources/cwa-taipei-tmin.mjs --history  → 2011-11 起每年 11–3 月，寫 overrides/cwa-taipei-tmin.json（進版控，冬天過完重跑一次）
// 轉換層 transform/coldwave.mjs 把兩份合起來用（同一天以 raw 為準）。
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { save } from './_moa.mjs';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
export const STATION = '466920';
export const DEFINITION_URL = 'https://edu.cwa.gov.tw/PopularScience/pr/pr_6.html';
export const meta = {
  id: 'cwa-taipei-tmin',
  name: '臺北氣象站每日最低氣溫（CODiS 月報表）',
  org: '交通部中央氣象署',
  homepage: 'https://codis.cwa.gov.tw/StationData',
  license: '政府網站資料開放宣告',
  updateFreq: '每日',
  format: 'json',
  entity: 'observation',
  endpoints: ['https://codis.cwa.gov.tw/api/station'],
  verifiedAt: '2026-11-24',
};
const COLD_MONTHS = [11, 12, 1, 2, 3];

const pad = (n) => String(n).padStart(2, '0');
const lastDay = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();

export async function fetchMonth(y, m) {
  const body = new URLSearchParams({
    type: 'report_month', stn_ID: STATION, stn_type: 'cwb', more: '',
    start: `${y}-${pad(m)}-01T00:00:00`, end: `${y}-${pad(m)}-${pad(lastDay(y, m))}T00:00:00`,
  });
  const res = await fetch(meta.endpoints[0], {
    method: 'POST',
    headers: {
      'X-Requested-With': 'XMLHttpRequest',
      Referer: meta.homepage,
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'hokhong.tw-ingest/0.1 (+https://hokhong.tw)',
    },
    body,
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}（${y}-${pad(m)}）`);
  const j = await res.json();
  if (j.code !== 200) throw new Error(`CODiS ${j.code}：${j.message}（${y}-${pad(m)}）`);
  const rows = j.data?.[0]?.dts ?? [];
  // 只留日期與最低氣溫（與發生時間）；缺測值（null）照實留 null
  return rows.map((r) => ({
    date: r.DataDate.slice(0, 10),
    min: r.AirTemperature?.Minimum ?? null,
    minTime: r.AirTemperature?.MinimumTime ?? null,
  }));
}

async function recent() {
  const now = new Date(Date.now() + 8 * 3600_000);
  const y = now.getUTCFullYear(), m = now.getUTCMonth() + 1;
  const prev = m === 1 ? [y - 1, 12] : [y, m - 1];
  const rows = [...await fetchMonth(...prev), ...await fetchMonth(y, m)].filter((r) => r.min != null);
  await save(meta.id, rows);
}

async function history() {
  const now = new Date(Date.now() + 8 * 3600_000);
  const endY = now.getUTCFullYear(), endM = now.getUTCMonth() + 1;
  const days = [];
  for (let y = 2011; y <= endY; y++) {
    for (const m of [1, 2, 3, 11, 12]) {
      if (y === 2011 && m < 11) continue;
      if (y > endY || (y === endY && m > endM)) continue;
      const rows = await fetchMonth(y, m);
      days.push(...rows.filter((r) => r.min != null));
      console.error(`${y}-${pad(m)}：${rows.length} 天，最低 ${Math.min(...rows.filter((r) => r.min != null).map((r) => r.min))}℃`);
      await new Promise((r) => setTimeout(r, 800));
    }
  }
  days.sort((a, b) => a.date.localeCompare(b.date));
  await writeFile(join(ROOT, 'overrides', 'cwa-taipei-tmin.json'), JSON.stringify({
    _what: '中央氣象署臺北氣象站（466920）每年 11–3 月的每日最低氣溫，寒流判定用（寒流＝臺北站最低氣溫 ≤ 10℃）',
    _source: meta.homepage,
    _definition: DEFINITION_URL,
    _generatedAt: new Date().toISOString(),
    _maintain: '冬天過完（4 月）重跑 node ingest/sources/cwa-taipei-tmin.mjs --history；每日排程另抓這兩個月到 ingest/raw',
    station: STATION, months: COLD_MONTHS,
    days,
  }, null, 0) + '\n');
  console.error(`寫入 ${days.length} 天`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--history')) await history(); else await recent();
}
