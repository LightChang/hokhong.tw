#!/usr/bin/env node
// 產生 overrides/search-demand.json：哪些蔬果品項「有人在查價格」（站主 2026-09-28 核可放寬收錄門檻的依據之一）。
//
// 兩種證據，都只收「品名＋價格類字眼」的查詢，不收料理、營養、功效類（那不是本站要承接的需求）：
//   gsc           本站 GSC 查詢（data/seo-daily/*.json，seo-ops 每日收集，只在本機有）
//   autocomplete  Google 自動完成（zh-TW）對「{品名} 價格」「{品名}」回的建議
//
// 為什麼寫成 overrides 而不是在 transform 裡即時算：CI runner 沒有 data/seo-daily，也不該在每日建置時打外部服務。
// 結果是人工資產，跟 festival-menu.json 一樣進版控，查證日期寫在檔內。建議每季或 GSC 查詢明顯變多時重跑一次。
//
//   node scripts/search-demand.mjs            # 重查全部蔬果品項（每個品項 2 次請求，間隔 400ms）
//   node scripts/search-demand.mjs --gsc-only # 只重算 GSC 那一欄，不連外
//
// 讀的是 data/page/index.json 的品項清單（先跑過 node transform/run.mjs）。
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'overrides', 'search-demand.json');
const gscOnly = process.argv.includes('--gsc-only');
// 價格類字眼：出現其中之一才算「在查價格」
const PRICE_RE = /價格|價錢|多少錢|一斤|台斤|批發|行情|菜價|果價|市價|貴嗎|很貴|便宜/;
// 自動完成的建議要是「品名緊接著價格字眼」：木薯粉價格、香椿醬價格、茴香酒價格是別的東西，不算。
// 沒人查過的字串 Google 回空陣列（實測「藤三七 價格」→ []），所以回傳原字串本身也算一筆證據。
const itemPrice = (s, name) => s.startsWith(name) && /^(價格|價錢|價|多少錢|一斤|一台斤|台斤|批發|行情|貴嗎|很貴|便宜)/.test(s.slice(name.length).replace(/\s+/g, ''));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const idx = JSON.parse(await readFile(join(ROOT, 'data/page/index.json'), 'utf-8'));
const food = idx.crops.filter((c) => c.tcType !== 'N06');
// 同一個名字只查一次（紅龍果有兩筆實體）
const names = [...new Set(food.map((c) => c.name))].sort();
const prev = JSON.parse(await readFile(OUT, 'utf-8').catch(() => '{}'));

// ── GSC：查詢字串裡含品名（或官方名）且有價格類字眼
const gscQueries = new Map();
const seoDir = join(ROOT, 'data/seo-daily');
for (const f of (await readdir(seoDir).catch(() => [])).filter((x) => x.endsWith('.json')).sort()) {
  const d = JSON.parse(await readFile(join(seoDir, f), 'utf-8'));
  for (const k of ['topQueries', 'pageQueryCross', 'strikingDistance', 'highImpZeroClick']) {
    for (const r of d.gsc?.[k] ?? []) gscQueries.set(r.query, (gscQueries.get(r.query) ?? 0) + (r.impressions ?? 0));
  }
}
const gsc = {};
for (const c of food) {
  // 最長的名字先比，避免「瓜」這種短字誤中；這裡的名字都至少兩個字
  const keys = [c.name, c.official, ...(c.also ?? [])].filter((x) => x && x.length >= 2);
  for (const [q] of gscQueries) {
    if (keys.some((k) => q.includes(k)) && PRICE_RE.test(q)) {
      (gsc[c.name] ??= new Set()).add(q);
    }
  }
}

// ── 自動完成
let auto = prev.autocomplete ?? {};
let checkedAt = prev.autocompleteCheckedAt ?? null;
if (!gscOnly) {
  auto = {};
  for (const name of names) {
    const hits = new Set();
    for (const q of [`${name} 價格`, name]) {
      const url = `https://suggestqueries.google.com/complete/search?client=firefox&hl=zh-TW&gl=tw&q=${encodeURIComponent(q)}`;
      try {
        const [, sug] = await fetch(url, { headers: { 'user-agent': 'hokhong.tw-maint (+https://hokhong.tw)' } }).then((r) => r.json());
        for (const s of sug ?? []) if (itemPrice(s, name)) hits.add(s);
      } catch (e) {
        console.error(`自動完成查詢失敗：${q}（${e.message}）`);
      }
      await sleep(400);
    }
    if (hits.size) auto[name] = [...hits].slice(0, 5);
  }
  checkedAt = new Date().toISOString().slice(0, 10);
}

const byName = {};
for (const n of names) {
  const ev = [];
  if (gsc[n]) ev.push(...[...gsc[n]].map((q) => `gsc:${q}`));
  if (auto[n]) ev.push(...auto[n].map((q) => `autocomplete:${q}`));
  if (ev.length) byName[n] = ev;
}

const doc = {
  _what: '有人在查價格的蔬果品項（俗名，對 data/page/index.json 的 name）。transform/emit-page.mjs 的需求收錄路徑讀這份。',
  _how: 'node scripts/search-demand.mjs 產生。只收「品名＋價格類字眼」的查詢（GSC 見該檔 PRICE_RE、自動完成見 itemPrice：品名後面緊接價格字眼），料理、營養、功效類查詢不算。',
  _approved: '2026-09-28 站主核可：有搜尋需求、資料不薄的品項放寬 noindex 門檻（GROWTH.md、SEO.md S17）。',
  autocompleteCheckedAt: checkedAt,
  gscFiles: 'data/seo-daily/*.json（本機，seo-ops 收集）',
  names: byName,
  autocomplete: auto,
};
await writeFile(OUT, `${JSON.stringify(doc, null, 1)}\n`);
console.log(`有需求證據的品項 ${Object.keys(byName).length}／${names.length}（GSC ${Object.keys(gsc).length}、自動完成 ${Object.keys(auto).length}）→ ${OUT}`);
