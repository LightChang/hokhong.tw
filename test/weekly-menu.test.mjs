// 每週菜單（站主 2026-09-28）：52 週每週都有主題與至少 3 道有來源的菜。
// 需要 data/page/festival-menu.json（先跑 node transform/run.mjs）；沒有資料時略過。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

const FILE = new URL('../data/page/festival-menu.json', import.meta.url);
const has = existsSync(FILE);
const data = has ? JSON.parse(readFileSync(FILE, 'utf-8')) : null;

test('52 週，從這週一起連續、每週一到週日', { skip: !has && '沒有 data/page' }, () => {
  assert.equal(data.weeks.length, 52);
  assert.equal(data.weeks.filter((w) => w.thisWeek).length, 1);
  for (let i = 0; i < data.weeks.length; i++) {
    const w = data.weeks[i];
    assert.equal(new Date(`${w.start}T00:00:00Z`).getUTCDay(), 1, `${w.iso} 不是週一開始`);
    if (i) assert.equal(Date.parse(w.start) - Date.parse(data.weeks[i - 1].start), 7 * 86_400_000, `${w.iso} 不連續`);
  }
});

test('每週都有主題、主題頁存在、至少 3 道有來源的菜', { skip: !has && '沒有 data/page' }, () => {
  const pages = new Set(data.festivals.map((f) => f.id));
  for (const w of data.weeks) {
    assert.ok(w.name, `${w.iso} 沒有主題`);
    assert.ok(pages.has(w.page), `${w.iso} 的主題頁 ${w.page} 不存在`);
    const sourced = w.dishes.filter((d) => /^https?:\/\//.test(d.source ?? ''));
    assert.ok(sourced.length >= 3, `${w.iso}（${w.name}）只有 ${sourced.length} 道有來源的菜`);
    assert.equal(new Set(w.dishes.map((d) => d.dish)).size, w.dishes.length, `${w.iso} 同一週有重複的菜`);
  }
});

test('相鄰的當季週不重複（前兩個當季週出現過的菜）', { skip: !has && '沒有 data/page' }, () => {
  const seasonal = data.weeks.filter((w) => w.dishes.every((d) => d.from === 'season'));
  const clashes = [];
  for (let i = 1; i < seasonal.length; i++) {
    const prev = new Set(seasonal.slice(Math.max(0, i - 2), i).flatMap((w) => w.dishes.map((d) => d.dish)));
    const dup = seasonal[i].dishes.filter((d) => prev.has(d.dish)).map((d) => d.dish);
    if (dup.length) clashes.push(`${seasonal[i].iso}：${dup.join('、')}`);
  }
  assert.deepEqual(clashes, []);
});
