// 從統一設計系統同步 token 檔。改 token 請改上游，不要改 src/styles/tokens.css。
// 與 seh.tw/scripts/sync-tokens.mjs 同一套做法，來源同一份檔案。
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

// 來源是另一個 repo 的檔案，路徑因人而異：用環境變數指定，預設當作與本專案同層。
//   DESIGN_TOKENS_SRC=/path/to/templates/styles.css npm run sync:tokens
const SRC = process.env.DESIGN_TOKENS_SRC
  ?? new URL('../../agent.system-integration-quality-control/templates/styles.css', import.meta.url).pathname;
const DEST = new URL('../src/styles/tokens.css', import.meta.url);
const HEADER = `/* ============================================================
 * 本檔為統一設計系統的副本，請勿直接編輯。
 *
 * 來源：agent.system-integration-quality-control/templates/styles.css
 * 同步：npm run sync:tokens
 *
 * 需要新增樣式時寫在 src/styles/site.css，不要改這裡；
 * 需要調整 token 值時改上游來源檔再同步回來。
 * ============================================================ */

`;

const css = await readFile(SRC, 'utf-8');
await mkdir(dirname(DEST.pathname), { recursive: true });
await writeFile(DEST, HEADER + css, 'utf-8');
process.stderr.write(`tokens 已同步：${css.length} bytes\n`);
