// 收錄遲滯（站主 2026-10-07 核可）：進場與退出用不同門檻，避免頁面因 90 天窗口滑動每天進出 sitemap。
//
//   進場：沒在索引裡的頁，要過原本的收錄門檻（emit-page.mjs 的 INDEX_IN／DEMAND_IN／DEMAND_CM，依頁型）。
//   維持：已在索引裡的頁，沒過進場門檻、但近 90 天仍有 INDEX_OUT.days90 個交易日且交易量 ≥ INDEX_OUT.volume90，
//         就留著（quality.indexBy = 'hold'）。
//   退出：已在索引裡、而且連退出門檻都跌破，才轉成 noindex。
//
// 「目前在不在索引」的來源是 repo 裡進版控的 index-state/indexed.txt：每天 daily.yml 部署成功後連同
// 時間戳一起 commit，所以它永遠等於「上一次成功部署的 sitemap 收了哪些門檻頁」。不靠當次 build、
// 不靠線上抓 sitemap（runner 每次都是乾淨的，data/ 不進 git）。
// 每次進出寫一行到 index-state/log.ndjson（append-only），加上 git 歷史，哪一天哪一頁為什麼進出都查得到。
import { readFile, writeFile, appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

export const INDEX_OUT = { days90: 15, volume90: 3_000 };

// entry：這頁今天過不過進場門檻（各頁型自己算好傳進來）
// wasIndexed：上一次部署時它在不在索引裡
export function decideIndex({ entry, wasIndexed, days90, volume90 }) {
  if (entry) return { indexable: true, by: 'entry' };
  if (wasIndexed && days90 >= INDEX_OUT.days90 && volume90 >= INDEX_OUT.volume90) return { indexable: true, by: 'hold' };
  return { indexable: false, by: null };
}

// 狀態檔格式：第一行 `# asOf=YYYY-MM-DD`（算出這份狀態的資料最後交易日），其餘每行一個路徑（排序過，diff 好讀）。
export function parseState(text) {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const asOf = lines.find((l) => l.startsWith('# asOf='))?.slice('# asOf='.length) ?? null;
  return { asOf, paths: new Set(lines.filter((l) => !l.startsWith('#'))) };
}

export function formatState(asOf, paths) {
  return `# asOf=${asOf}\n` + [...paths].sort().join('\n') + '\n';
}

export async function loadState(file) {
  try { return parseState(await readFile(file, 'utf-8')); } catch { return null; }
}

// 比對前後兩份狀態，產出進出記錄。metrics：path → { days90, volume90, by }
export function diffState(prevPaths, nextPaths, date, metrics) {
  const out = [];
  for (const p of [...nextPaths].sort()) if (!prevPaths.has(p)) out.push({ date, path: p, change: 'in', ...metrics.get(p) });
  for (const p of [...prevPaths].sort()) if (!nextPaths.has(p)) out.push({ date, path: p, change: 'out', ...metrics.get(p) });
  return out;
}

// 寫回狀態。資料比狀態舊（本機 checkout 落後線上）時不寫，免得把舊判斷蓋回進版控的狀態檔。
export async function saveState({ stateFile, logFile, prev, asOf, paths, metrics }) {
  if (prev?.asOf && asOf < prev.asOf) {
    return { written: false, reason: `資料最後交易日 ${asOf} 早於狀態檔 ${prev.asOf}，不寫回` };
  }
  // 沒有狀態檔＝第一次建立：只記一行 init，不把上千頁逐一記成「進場」
  const changes = prev ? diffState(prev.paths, paths, asOf, metrics) : [];
  const lines = prev ? changes : [{ date: asOf, change: 'init', count: paths.size }];
  await mkdir(dirname(stateFile), { recursive: true });
  await writeFile(stateFile, formatState(asOf, paths));
  if (lines.length) await appendFile(logFile, lines.map((c) => JSON.stringify(c)).join('\n') + '\n');
  return { written: true, changes };
}
