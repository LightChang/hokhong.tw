// 排程執行器：依各來源的更新頻次算出「下次該抓的時間」，只跑到期的來源。
//
// 設計理由：cron 硬編時間的話，主機沒開機／跑失敗的那次就永久漏掉。這支把「下次到期時間」
// 存成狀態，cron 只要每小時叫一次它，漏掉的會在下一次自動補跑。
//
// 用法：
//   node ingest/run.mjs              # 跑所有到期的來源
//   node ingest/run.mjs --list       # 只列出每個來源的到期狀況，不執行
//   node ingest/run.mjs --force <id> # 不管到期與否，強制跑某支
//   node ingest/run.mjs --dry        # 印出會執行什麼，但不真的執行
//
// cron 只需要一行：  0 * * * * cd <專案> && node ingest/run.mjs >> ingest/log/run.log 2>&1
import { execFile } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { promisify } from 'node:util';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const STATE = join(ROOT, 'ingest', 'state.json');
const CERT = 'ingest/certs/twca-secure-ssl-2023g3.pem';

// 頻次：daily | weekly（週一）| monthly（每月 N 日）。時間一律台北時間。
// critical: 來源是滾動視窗，漏跑會永久掉資料（見 ingest/SCHEDULE.md §1）
export const jobs = [
  { id: 'tap-trans', freq: 'daily', at: 2, critical: true, args: ['ingest/sources/moa-reference.mjs', 'tap-trans'] },
  { id: 'taichung-retail', freq: 'daily', at: 2, critical: true, args: ['ingest/sources/retail.mjs', 'taichung-retail'], cert: true },
  { id: 'farm-trans', freq: 'daily', at: 2, args: ['ingest/sources/farm-trans.mjs', '--refetch', '--recent', '7'] },
  { id: 'origin-price', freq: 'daily', at: 2, args: ['ingest/sources/moa-reference.mjs', 'origin-price'] },
  { id: 'cwa-typhoon-warnings', freq: 'daily', at: 2, args: ['ingest/sources/cwa-typhoon-warnings.mjs'] },
  // 畜禽：四支都是一次回全部歷史（合計約 16 萬列、每次約 110 秒），每天整份覆蓋，不會掉資料
  { id: 'animal-trans', freq: 'daily', at: 2, args: ['ingest/sources/animal-trans.mjs'] },
  { id: 'market-rest-farm', freq: 'weekly', at: 3, args: ['ingest/sources/moa-reference.mjs', 'market-rest-farm'] },
  { id: 'crop-forecast', freq: 'weekly', at: 3, args: ['ingest/sources/moa-reference.mjs', 'crop-forecast'] },
  { id: 'crop-codes', freq: 'monthly', day: 1, at: 4, args: ['ingest/sources/moa-reference.mjs', 'crop-unified', 'crop-crosswalk'] },
  { id: 'origin-monthly', freq: 'monthly', day: 1, at: 4, args: ['ingest/sources/moa-reference.mjs', 'origin-price-monthly', 'peak-season-origin'] },
  { id: 'amis-product-changed', freq: 'monthly', day: 1, at: 4, args: ['ingest/sources/amis-product-changed.mjs'] },
  { id: 'dgbas-cpi-items', freq: 'monthly', day: 6, at: 4, args: ['ingest/sources/retail.mjs', 'dgbas-cpi-items'], cert: true },
];

const TZ = 8 * 3600_000;                                    // 台北時間 = UTC+8
const tpe = (d) => new Date(d.getTime() + TZ);              // 轉成「台北掛鐘」的 UTC 視圖
const fromTpe = (d) => new Date(d.getTime() - TZ);
const iso = (d) => d.toISOString();

// 從 `from` 之後的下一個到期時刻
export function nextDue(job, from) {
  const t = tpe(from);
  const at = job.at ?? 2;
  const d = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate(), at, 0, 0));
  const bump = () => {
    if (job.freq === 'daily') d.setUTCDate(d.getUTCDate() + 1);
    else if (job.freq === 'weekly') d.setUTCDate(d.getUTCDate() + 1);
    else d.setUTCDate(d.getUTCDate() + 1);
  };
  // 先推到 from 之後，再滿足「星期一」或「每月 N 日」的條件
  while (d <= t || (job.freq === 'weekly' && d.getUTCDay() !== 1) || (job.freq === 'monthly' && d.getUTCDate() !== job.day)) bump();
  return fromTpe(d);
}

const loadState = async () => JSON.parse(await readFile(STATE, 'utf8').catch(() => '{}'));

async function main() {
  const argv = process.argv.slice(2);
  const list = argv.includes('--list');
  const dry = argv.includes('--dry');
  const force = argv[argv.indexOf('--force') + 1];
  const forced = argv.includes('--force') ? jobs.filter((j) => j.id === force) : null;
  if (argv.includes('--force') && !forced.length) throw new Error(`--force 找不到來源：${force}（可用：${jobs.map((j) => j.id).join(', ')}）`);

  const state = await loadState();
  const now = new Date();
  const due = forced ?? jobs.filter((j) => !state[j.id]?.nextDueAt || new Date(state[j.id].nextDueAt) <= now);

  if (list) {
    for (const j of jobs) {
      const s = state[j.id] ?? {};
      const overdue = !s.nextDueAt || new Date(s.nextDueAt) <= now;
      console.log([
        overdue ? '到期' : '未到',
        j.critical ? '關鍵' : '　　',
        j.id.padEnd(22),
        `頻次=${j.freq}${j.day ? `(${j.day}日)` : ''}`,
        `上次成功=${s.lastSuccessAt ?? '—'}`,
        `下次=${s.nextDueAt ?? '立即'}`,
        s.lastError ? `上次錯誤=${s.lastError}` : '',
      ].join('  '));
    }
    return;
  }

  console.error(`[${iso(now)}] 到期 ${due.length} 支：${due.map((j) => j.id).join(', ') || '無'}`);
  let failed = 0;
  for (const j of due) {
    if (dry) { console.error(`[dry] node ${j.args.join(' ')}`); continue; }
    const t0 = Date.now();
    const env = { ...process.env, ...(j.cert ? { NODE_EXTRA_CA_CERTS: CERT } : {}) };
    try {
      const { stderr } = await run(process.execPath, j.args, { cwd: ROOT, env, timeout: 3 * 3600_000, maxBuffer: 64 * 1024 * 1024 });
      state[j.id] = {
        lastAttemptAt: iso(new Date()), lastSuccessAt: iso(new Date()),
        nextDueAt: iso(nextDue(j, new Date())), lastError: null,
        lastOutput: (stderr ?? '').trim().split('\n').slice(-2).join(' | '),
      };
      console.error(`  OK   ${j.id} ${((Date.now() - t0) / 1000).toFixed(1)}s → 下次 ${state[j.id].nextDueAt}`);
    } catch (e) {
      failed++;
      const prev = state[j.id] ?? {};
      // 失敗不推遲到期時間：下一次呼叫會再試（關鍵來源尤其不能等到明天）
      state[j.id] = { ...prev, lastAttemptAt: iso(new Date()), lastError: (e.stderr || e.message || '').trim().split('\n').pop().slice(0, 300) };
      console.error(`  FAIL ${j.id} ${((Date.now() - t0) / 1000).toFixed(1)}s：${state[j.id].lastError}`);
    }
  }
  if (!dry) {
    await mkdir(dirname(STATE), { recursive: true });
    await writeFile(STATE, JSON.stringify(state, null, 1) + '\n');
  }
  if (failed) process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
