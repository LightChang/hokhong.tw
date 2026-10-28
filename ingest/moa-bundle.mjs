// tw8（台灣主機）代抓農業部資料後打包上傳。2026-10-22 起 data.moa.gov.tw、amis.afa.gov.tw 只讓台灣 IP 連，
// GitHub runner 抓不到，改由 tw8 每天台北 04:30 前跑：
//
//   git pull && node ingest/run.mjs --moa && node ingest/moa-bundle.mjs --upload
//
// 產出 moa-raw.tar.gz：路徑與 ingest/raw/ 完全相同（daily.yml 直接在 repo 根目錄解開），內容是各來源原本的寫法
// （多頁合併成一個陣列、gzip），外加 ingest/raw/moa-manifest.json：每個來源在 tw8 上次成功的時間。
// daily.yml 的 run.mjs 只認 MOA_FRESH_HOURS 內（每日 30 小時、每週 8 天、每月 32 天）成功的來源，舊的照舊自己試並留註記。
// --upload 把它放到 data-current release（覆蓋），需要 gh 已登入、對 LightChang/hokhong.tw 有寫入權。
import { execFileSync } from 'node:child_process';
import { readFile, readdir, writeFile, stat } from 'node:fs/promises';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { jobs } from './run.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RAW = 'ingest/raw';
const OUT = join(ROOT, 'moa-raw.tar.gz');
const FARM_DAYS = 60;       // 跟 run.mjs 的 farm-trans --recent 60 一致：恢復時中間斷的天數一起帶過去
const TAP_FILES = 14;       // 產銷履歷按抓取日分檔，帶最近兩週（runner 那邊漏的補得回來）
// 單檔來源：檔名就是 ingest/sources/*.mjs 存檔用的 id
const SINGLE = ['origin-price', 'market-rest-farm', 'crop-forecast', 'animal-hog', 'animal-chicken-egg', 'animal-goose-duck',
  'animal-red-chicken', 'crop-unified', 'crop-crosswalk', 'origin-price-monthly', 'peak-season-origin', 'amis-product-changed'];

const exists = (p) => stat(join(ROOT, p)).then(() => true, () => false);
const state = JSON.parse(await readFile(join(ROOT, 'ingest', 'state.json'), 'utf8').catch(() => '{}'));

const files = [];
for (const id of SINGLE) if (await exists(`${RAW}/${id}.json.gz`)) files.push(`${RAW}/${id}.json.gz`);
const tap = (await readdir(join(ROOT, RAW, 'tap-trans')).catch(() => [])).filter((f) => f.endsWith('.json.gz')).sort().slice(-TAP_FILES);
files.push(...tap.map((f) => `${RAW}/tap-trans/${f}`));
const since = new Date(Date.now() - FARM_DAYS * 86400_000).toISOString().slice(0, 10);
for (const y of (await readdir(join(ROOT, RAW, 'farm-trans')).catch(() => [])).filter((d) => /^\d{4}$/.test(d))) {
  for (const f of (await readdir(join(ROOT, RAW, 'farm-trans', y))).filter((f) => f.endsWith('.json.gz') && f.slice(0, 10) >= since)) {
    files.push(`${RAW}/farm-trans/${y}/${f}`);
  }
}

const sources = {};
for (const j of jobs.filter((j) => j.moa)) {
  const s = state[j.id];
  if (s?.lastSuccessAt) sources[j.id] = { lastSuccessAt: s.lastSuccessAt, lastOutput: s.lastOutput ?? '' };
}
const manifest = { builtAt: new Date().toISOString(), host: hostname(), files: files.length, sources };
await writeFile(join(ROOT, RAW, 'moa-manifest.json'), JSON.stringify(manifest, null, 1) + '\n');
files.push(`${RAW}/moa-manifest.json`);

execFileSync('tar', ['-czf', OUT, ...files], { cwd: ROOT });
const size = (await stat(OUT)).size;
console.error(`moa-raw.tar.gz：${files.length} 個檔案、${(size / 1e6).toFixed(1)} MB`);
for (const [id, s] of Object.entries(sources)) console.error(`  ${id.padEnd(22)} ${s.lastSuccessAt}`);
const stale = jobs.filter((j) => j.moa && j.freq === 'daily' && !(Date.now() - new Date(sources[j.id]?.lastSuccessAt ?? 0) < 30 * 3600_000));
if (stale.length) console.error(`⚠️ 超過 30 小時沒成功的每日來源：${stale.map((j) => j.id).join(', ')}（runner 不會認這些）`);

if (process.argv.includes('--upload')) {
  execFileSync('gh', ['release', 'upload', 'data-current', OUT, '--clobber', '--repo', 'LightChang/hokhong.tw'], { cwd: ROOT, stdio: 'inherit' });
  console.error('已上傳到 data-current（覆蓋 moa-raw.tar.gz）');
}
