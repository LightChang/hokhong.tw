// 收錄遲滯（transform/index-hysteresis.mjs）：進場用原門檻、已在索引的頁跌破退出門檻才出。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { INDEX_OUT, decideIndex, parseState, formatState, loadState, saveState } from '../transform/index-hysteresis.mjs';

test('進場：過進場門檻就收錄，不管之前在不在索引', () => {
  assert.deepEqual(decideIndex({ entry: true, wasIndexed: false, days90: 30, volume90: 10_000 }), { indexable: true, by: 'entry' });
  assert.deepEqual(decideIndex({ entry: true, wasIndexed: true, days90: 30, volume90: 10_000 }), { indexable: true, by: 'entry' });
});

test('進場：沒在索引裡的頁，只過退出門檻不夠', () => {
  assert.deepEqual(decideIndex({ entry: false, wasIndexed: false, days90: 29, volume90: 9_999 }), { indexable: false, by: null });
});

test('維持：已在索引、介於退出與進場門檻之間就留著', () => {
  assert.deepEqual(decideIndex({ entry: false, wasIndexed: true, days90: 20, volume90: 5_000 }), { indexable: true, by: 'hold' });
  // 剛好等於退出門檻也算留著
  assert.deepEqual(decideIndex({ entry: false, wasIndexed: true, ...INDEX_OUT }), { indexable: true, by: 'hold' });
});

test('退出：已在索引、交易日或交易量任一跌破退出門檻就出', () => {
  assert.equal(decideIndex({ entry: false, wasIndexed: true, days90: INDEX_OUT.days90 - 1, volume90: 50_000 }).indexable, false);
  assert.equal(decideIndex({ entry: false, wasIndexed: true, days90: 60, volume90: INDEX_OUT.volume90 - 1 }).indexable, false);
});

test('狀態檔可來回轉換，路徑排序', () => {
  const s = parseState(formatState('2026-10-07', new Set(['/market/n04-109', '/crop/a'])));
  assert.equal(s.asOf, '2026-10-07');
  assert.deepEqual([...s.paths], ['/crop/a', '/market/n04-109']);
});

test('寫回狀態：記下進出；資料比狀態舊就不寫', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'idx-'));
  const stateFile = join(dir, 'indexed.txt'), logFile = join(dir, 'log.ndjson');
  await writeFile(stateFile, formatState('2026-10-06', new Set(['/crop/a', '/crop/b'])));
  const prev = await loadState(stateFile);
  const metrics = new Map([['/crop/b', { days90: 10, volume90: 100, by: null }], ['/crop/c', { days90: 40, volume90: 20_000, by: 'volume' }]]);
  const r = await saveState({ stateFile, logFile, prev, asOf: '2026-10-07', paths: new Set(['/crop/a', '/crop/c']), metrics });
  assert.equal(r.written, true);
  const log = (await readFile(logFile, 'utf-8')).trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(log.map((x) => [x.path, x.change]), [['/crop/c', 'in'], ['/crop/b', 'out']]);
  assert.equal(log[1].days90, 10);
  assert.deepEqual([...(await loadState(stateFile)).paths], ['/crop/a', '/crop/c']);

  const stale = await saveState({ stateFile, logFile, prev: await loadState(stateFile), asOf: '2026-10-05', paths: new Set(), metrics });
  assert.equal(stale.written, false);
  assert.equal((await loadState(stateFile)).asOf, '2026-10-07');
});

test('同一天重跑同一份資料：不產生新的進出記錄', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'idx-'));
  const stateFile = join(dir, 'indexed.txt'), logFile = join(dir, 'log.ndjson');
  await writeFile(stateFile, formatState('2026-10-07', new Set(['/crop/a'])));
  const r = await saveState({ stateFile, logFile, prev: await loadState(stateFile), asOf: '2026-10-07', paths: new Set(['/crop/a']), metrics: new Map() });
  assert.deepEqual(r.changes, []);
});
