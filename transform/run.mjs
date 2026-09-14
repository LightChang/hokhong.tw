// 轉換層入口：把五支依序跑完，任一步失敗就停。
//
// 為什麼要有這支：轉換有順序相依（L1 → 身分 → 聚合 → 頁面），手動跑容易漏掉中間一步，
// 而漏掉的後果是「頁面用舊的身分表」這種不會報錯、只會靜靜產出錯資料的狀況。
//
// 用法：
//   node transform/run.mjs                 # 每日：只轉近 7 天，其餘全量重算（聚合 12 秒，不值得做增量）
//   node transform/run.mjs --full          # 全量：L1 全部重轉（首次或懷疑 L1 壞了）
//   node transform/run.mjs --from identify # 從某一步開始（前面的產物沿用）
//   node transform/run.mjs --list          # 只列出步驟
//
// 每日排程（主機）：ingest/run.mjs 抓完資料後接著跑這支。
import { execFile, exec } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const sh = promisify(exec);        // 給 astro build 這種不是 node 腳本的步驟用
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// 順序有相依：typhoon 要 aggregate 的日價與 identify 的身分表；emit-page 要產地價與聚合；
// build 要 emit-page 產出的 page-state.ndjson（sitemap 靠它決定收錄哪些頁）。
export const steps = [
  { id: 'to-parquet', daily: ['transform/to-parquet.mjs', '--recent', '7'], full: ['transform/to-parquet.mjs'], why: 'raw → L1 Parquet' },
  { id: 'observe', daily: ['transform/observe.mjs', '--recent', '7'], full: ['transform/observe.mjs', '--all'], why: '偵測事後修正，寫 observation' },
  { id: 'identify', daily: ['transform/identify.mjs'], why: '作物代碼 → CROP_UID' },
  { id: 'check-coverage', daily: ['transform/check-coverage.mjs'], why: '完整性對帳，數字異常要人看' },
  { id: 'origin-price', daily: ['transform/origin-price.mjs'], why: '產地價 → Parquet（價格鏈用）' },
  { id: 'aggregate', daily: ['transform/aggregate.mjs'], why: '旬／月／日聚合' },
  { id: 'typhoon', daily: ['transform/typhoon.mjs'], why: '颱風影響與回穩天數' },
  { id: 'emit-page', daily: ['transform/emit-page.mjs'], why: '產出 per-page JSON' },
  { id: 'build', cmd: 'npx astro build', why: '產出靜態站台 dist/' },
];

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--list')) {
    for (const s of steps) console.log(`${s.id.padEnd(16)} ${s.why}`);
    return;
  }
  const full = argv.includes('--full');
  const fromIdx = argv.indexOf('--from');
  let todo = steps;
  if (fromIdx >= 0) {
    const from = argv[fromIdx + 1];
    const i = steps.findIndex((s) => s.id === from);
    if (i < 0) throw new Error(`--from 找不到步驟：${from}（可用：${steps.map((s) => s.id).join(', ')}）`);
    todo = steps.slice(i);
  }

  console.error(`[${new Date().toISOString()}] 轉換層 ${full ? '全量' : '每日'}模式，${todo.length} 步`);
  const t0 = Date.now();
  for (const s of todo) {
    const args = (full && s.full) ? s.full : s.daily;
    const st = Date.now();
    try {
      const opts = { cwd: ROOT, timeout: 6 * 3600_000, maxBuffer: 64 * 1024 * 1024 };
      const { stderr } = s.cmd ? await sh(s.cmd, opts) : await run(process.execPath, args, opts);
      const tail = (stderr ?? '').trim().split('\n').slice(-2).join(' | ');
      console.error(`  OK   ${s.id.padEnd(16)} ${((Date.now() - st) / 1000).toFixed(1)}s  ${tail}`);
    } catch (e) {
      console.error(`  FAIL ${s.id.padEnd(16)} ${((Date.now() - st) / 1000).toFixed(1)}s`);
      console.error((e.stderr || e.message || '').trim().split('\n').slice(-5).join('\n'));
      console.error(`→ 停在 ${s.id}。修好後可用 --from ${s.id} 續跑。`);
      process.exitCode = 1;
      return;
    }
  }
  console.error(`完成，共 ${((Date.now() - t0) / 1000).toFixed(1)} 秒`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
