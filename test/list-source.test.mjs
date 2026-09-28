// 節日頁「把蔬果食材加進買菜清單」能加的每一樣，首頁清單都要顯示得出來（首頁以 list-source.json 的 slug 查資料，
// 查不到就不顯示）。需要 data/page（先跑 node transform/run.mjs）；沒有資料時略過。
// 品項頁的「加入買菜清單」只在可收錄的蔬果頁出現，也一併檢查。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';

const PAGE = new URL('../data/page/', import.meta.url);
const has = existsSync(new URL('list-source.json', PAGE)) && existsSync(new URL('festival-menu.json', PAGE));
const read = (f) => JSON.parse(readFileSync(new URL(f, PAGE), 'utf-8'));

test('節日頁可加入的蔬果食材都在首頁清單資料裡', { skip: !has && '沒有 data/page' }, () => {
  const ls = new Set(read('list-source.json').crops.map((c) => c.slug));
  const missing = read('festival-menu.json').festivals.flatMap((f) =>
    f.ingredients.filter((i) => i.kind === 'crop' && !ls.has(i.slug)).map((i) => `${f.name}／${i.name}（${i.slug}）`));
  assert.deepEqual(missing, []);
});

test('品項頁有「加入買菜清單」按鈕的品項都在首頁清單資料裡', { skip: !has && '沒有 data/page' }, () => {
  const ls = new Set(read('list-source.json').crops.map((c) => c.slug));
  const missing = [];
  for (const f of readdirSync(new URL('crop/', PAGE))) {
    const d = read(`crop/${f}`);
    // 與 src/pages/crop/[slug].astro 的按鈕條件相同
    if (d.quality?.indexable && d.tcType !== 'N06' && !ls.has(d.slug)) missing.push(d.slug);
  }
  assert.deepEqual(missing, []);
});
