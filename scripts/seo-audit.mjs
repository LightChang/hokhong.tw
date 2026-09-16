#!/usr/bin/env node
// 本機稽核：把 dist/ 的 SEO／AEO／GEO 現況算出來。
//
// 為什麼要有這支：文件裡不留寫死的數字。任何「現在有幾頁有 JSON-LD」「入鏈幾個」
// 都是每天 build 會變的東西，寫進 Markdown 隔天就是錯的，而且錯得很有說服力。
// 要看現況就跑這支，輸出即事實。
//
//   node scripts/seo-audit.mjs            # 全部
//   node scripts/seo-audit.mjs links      # 只看內部連結
//   node scripts/seo-audit.mjs schema     # 只看結構化資料覆蓋
//   node scripts/seo-audit.mjs sitemap    # 只看 sitemap 一致性
//   node scripts/seo-audit.mjs validate   # 逐筆驗標記內容（垃圾值、必填欄位、網址）
//
// 前提：dist/ 是最新的（npx astro build 或 node transform/run.mjs）。

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(process.cwd());
const DIST = join(ROOT, 'dist');
const only = process.argv[2] ?? 'all';
const want = (s) => only === 'all' || only === s;

if (!existsSync(DIST)) {
  console.error('找不到 dist/。先跑 `npx astro build` 或 `node transform/run.mjs`。');
  process.exit(1);
}

// ── 收集 ──────────────────────────────
const htmlFiles = [];
(function walk(dir) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p);
    else if (e.endsWith('.html')) htmlFiles.push(p);
  }
})(DIST);

const pages = new Map();   // 路徑 → { html, noindex }
for (const f of htmlFiles) {
  const path = '/' + f.slice(DIST.length + 1).replace(/index\.html$/, '');
  const html = readFileSync(f, 'utf-8');
  pages.set(path, { html, noindex: /name="robots" content="noindex"/.test(html) });
}

const fmt = (n) => n.toLocaleString('en-US');
const head = (s) => console.log(`\n── ${s} ${'─'.repeat(Math.max(0, 56 - s.length))}`);

console.log(`dist/ 共 ${fmt(pages.size)} 頁（${new Date().toISOString().slice(0, 16)} 稽核）`);

// ── 結構化資料與 head 標記 ──────────────────
if (want('schema')) {
  head('結構化資料 / head');
  const byType = new Map();
  let blocks = 0, parseFail = 0, withLd = 0;
  for (const [path, { html }] of pages) {
    const ms = [...html.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/gs)];
    if (ms.length) withLd++;
    for (const m of ms) {
      blocks++;
      try {
        const t = JSON.parse(m[1])['@type'];
        byType.set(t, (byType.get(t) ?? 0) + 1);
      } catch { parseFail++; console.log(`  解析失敗: ${path}`); }
    }
  }
  console.log(`  有 JSON-LD 的頁: ${fmt(withLd)} / ${fmt(pages.size)}（noindex 頁刻意不輸出）`);
  console.log(`  區塊總數: ${fmt(blocks)}　解析失敗: ${parseFail}${parseFail ? '  ← 要修' : ''}`);
  for (const [t, n] of [...byType].sort((a, b) => b[1] - a[1])) console.log(`    ${t}: ${fmt(n)}`);

  const count = (re) => [...pages.values()].filter((p) => re.test(p.html)).length;
  console.log(`  og:image: ${fmt(count(/og:image/))}　h2: ${fmt(count(/<h2/))}　h3: ${fmt(count(/<h3/))}`);
  console.log(`  表格 caption: ${fmt(count(/<caption/))}　dateModified: ${fmt(count(/dateModified/))}`);
}

// ── sitemap 一致性 ──────────────────────────
if (want('sitemap')) {
  head('sitemap 一致性');
  const smFile = join(DIST, 'sitemap-0.xml');
  if (!existsSync(smFile)) console.log('  找不到 dist/sitemap-0.xml');
  else {
    const sm = new Set(
      [...readFileSync(smFile, 'utf-8').matchAll(/<loc>([^<]+)<\/loc>/g)]
        .map((m) => m[1].replace('https://hokhong.tw', '')),
    );
    const lastmod = new Set(
      [...readFileSync(smFile, 'utf-8').matchAll(/<lastmod>([^<]+)<\/lastmod>/g)].map((m) => m[1]),
    );
    const noindex = new Set([...pages].filter(([, v]) => v.noindex).map(([k]) => k));
    const inSmNoindex = [...sm].filter((u) => noindex.has(u));
    const inSmMissing = [...sm].filter((u) => !pages.has(u));
    const shouldBeIn = [...pages.keys()].filter((u) => !noindex.has(u) && u !== '/404.html' && !sm.has(u));
    console.log(`  sitemap 筆數: ${fmt(sm.size)}　noindex 頁: ${fmt(noindex.size)}`);
    console.log(`  lastmod 值: ${[...lastmod].join(', ') || '（無）'}`);
    console.log(`  ${inSmNoindex.length ? '✗' : '✓'} sitemap 含 noindex 頁: ${inSmNoindex.length}` +
      (inSmNoindex.length ? ` ${inSmNoindex.slice(0, 3).join(' ')}` : ''));
    console.log(`  ${inSmMissing.length ? '✗' : '✓'} sitemap 指向不存在的頁: ${inSmMissing.length}` +
      (inSmMissing.length ? ` ${inSmMissing.slice(0, 3).join(' ')}` : ''));
    console.log(`  ${shouldBeIn.length ? '✗' : '✓'} 可收錄但漏在 sitemap 外: ${shouldBeIn.length}` +
      (shouldBeIn.length ? ` ${shouldBeIn.slice(0, 3).join(' ')}` : ''));
  }

  // canonical 必須等於自身網址
  const bad = [];
  for (const [path, { html }] of pages) {
    if (path === '/404.html') continue;
    const m = /<link rel="canonical" href="([^"]+)"/.exec(html);
    const self = `https://hokhong.tw${path}`;
    if (!m || m[1] !== self) bad.push(path);
  }
  console.log(`  ${bad.length ? '✗' : '✓'} canonical 不等於自身網址: ${bad.length}` +
    (bad.length ? ` ${bad.slice(0, 3).join(' ')}` : ''));
}

// ── 內部連結 ────────────────────────────────
if (want('links')) {
  head('內部連結');
  const links = new Map();
  for (const [path, { html }] of pages) {
    // 只取 body 裡真的 <a href>，避開 inline script 裡的 JS 樣板字串（會產生假的壞連結）
    const body = html.slice(html.indexOf('<body')).replace(/<script[\s\S]*?<\/script>/g, '');
    links.set(path, new Set([...body.matchAll(/<a[^>]+href="(\/[^"#?]*)"/g)].map((m) => m[1])));
  }
  const indeg = new Map([...pages.keys()].map((p) => [p, new Set()]));
  for (const [from, tos] of links) for (const to of tos) if (indeg.has(to)) indeg.get(to).add(from);

  const depth = new Map([['/', 0]]);
  for (const queue = ['/']; queue.length; ) {
    const cur = queue.shift();
    for (const to of links.get(cur) ?? []) {
      if (pages.has(to) && !depth.has(to)) { depth.set(to, depth.get(cur) + 1); queue.push(to); }
    }
  }

  const ok = [...pages].filter(([, v]) => !v.noindex).map(([k]) => k).filter((p) => p !== '/404.html');
  const degs = ok.map((p) => indeg.get(p).size).sort((a, b) => a - b);
  const orphan = ok.filter((p) => indeg.get(p).size === 0);
  const one = ok.filter((p) => indeg.get(p).size === 1);
  console.log(`  可收錄頁: ${fmt(ok.length)}`);
  console.log(`  入鏈 中位數 ${degs[degs.length >> 1]}　最少 ${degs[0]}　最多 ${degs.at(-1)}`);
  console.log(`  ${orphan.length ? '✗' : '✓'} 入鏈 0（孤兒）: ${orphan.length}` +
    (orphan.length ? ` ${orphan.slice(0, 3).join(' ')}` : ''));
  console.log(`  ${one.length > 50 ? '✗' : '✓'} 入鏈只有 1 個: ${one.length}` +
    (one.length ? ` 例 ${one.slice(0, 2).join(' ')}` : ''));
  const byDepth = new Map();
  for (const p of ok) {
    const d = depth.has(p) ? depth.get(p) : '不可達';
    byDepth.set(d, (byDepth.get(d) ?? 0) + 1);
  }
  console.log(`  點擊深度: ${[...byDepth].sort((a, b) => String(a[0]).localeCompare(String(b[0])))
    .map(([d, n]) => `${d} 層 ${fmt(n)}`).join('　')}`);
  const dead = new Set();
  for (const tos of links.values()) for (const to of tos) if (!pages.has(to) && !/\.\w+$/.test(to)) dead.add(to);
  console.log(`  ${dead.size ? '✗' : '✓'} 連到不存在的頁: ${dead.size}` +
    (dead.size ? ` ${[...dead].slice(0, 3).join(' ')}` : ''));
}

// ── 逐筆驗標記內容 ──────────────────────────
// 覆蓋率高不等於標記是對的。答案句、FAQ、Dataset description 都是從資料組出來的字串，
// 只要某個欄位是 null，格式化函式就會吐出「—」，然後那個「—」會原樣送進結構化資料，
// 變成一句「目前 — 元/公斤」的機器可讀事實。這一段就是抓這種。
if (want('validate')) {
  head('標記內容逐筆驗證');

  // 垃圾值：格式化函式在資料缺漏時的產物，以及 JS 的各種 falsy 外洩
  // 破折號要分兩種用途：標題分隔（「高麗菜現在貴嗎？便宜 25% — 好康」）和句中的「——」
  // 都是正常的，不能一律當垃圾。真正的問題是 price()／pct()／changeWord() 在資料缺漏時
  // 回傳的「—」被塞進數值的位置。所以只抓「破折號出現在數值該在的地方」。
  const DASH = '(?<!—)—(?!—)';
  const JUNK = [
    ['缺值佔位（— 接單位）', new RegExp(`${DASH}\\s*(元|%|公噸|公斤|台斤|個)`)],
    ['缺值佔位（數值前綴接 —）', new RegExp(`(均價|目前|約|常年|實測|同月|同旬|相差|比)\\s*${DASH}`)],
    ['缺值佔位（標題裡的 —）', new RegExp(`[？：]\\s*${DASH}\\s`)],
    ['undefined', /\bundefined\b/],
    ['null', /\bnull\b/],
    ['NaN', /\bNaN\b/],
    ['Infinity', /\bInfinity\b/],
    ['[object Object]', /\[object Object\]/],
    ['空括號', /（\s*）|\(\s*\)/],
    ['連續標點', /，\s*。|。\s*。|，\s*，/],
    ['未取代的樣板', /\$\{|\{\{/],
  ];

  const problems = [];
  const add = (path, what, detail) => problems.push({ path, what, detail });

  // 遞迴走訪物件裡所有字串值
  const strings = (o, prefix = '') => {
    const out = [];
    if (typeof o === 'string') out.push([prefix, o]);
    else if (Array.isArray(o)) o.forEach((v, i) => out.push(...strings(v, `${prefix}[${i}]`)));
    else if (o && typeof o === 'object') {
      for (const [k, v] of Object.entries(o)) out.push(...strings(v, prefix ? `${prefix}.${k}` : k));
    }
    return out;
  };

  const REQUIRED = {
    Dataset: ['name', 'description'],
    WebSite: ['name', 'url'],
    Organization: ['name', 'url'],
    WebPage: ['url', 'dateModified'],
    BreadcrumbList: ['itemListElement'],
    FAQPage: ['mainEntity'],
    ItemList: ['itemListElement'],
  };

  let objs = 0;
  for (const [path, { html, noindex }] of pages) {
    if (noindex) continue;

    for (const m of html.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/gs)) {
      let o;
      try { o = JSON.parse(m[1]); } catch { add(path, 'JSON 解析失敗', m[1].slice(0, 60)); continue; }
      objs++;
      const t = o['@type'];

      for (const f of REQUIRED[t] ?? []) {
        const v = o[f];
        if (v == null || v === '' || (Array.isArray(v) && !v.length)) add(path, `${t} 缺必填 ${f}`, '');
      }

      for (const [key, val] of strings(o)) {
        for (const [label, re] of JUNK) {
          if (re.test(val)) add(path, `${t}.${key} 含「${label}」`, val.slice(0, 80));
        }
        if (!val.trim() && key !== '') add(path, `${t}.${key} 是空字串`, '');
      }

      // 網址必須是本站絕對網址
      for (const [key, val] of strings(o)) {
        if (!/(^|\.)(url|item|contentUrl)$/.test(key)) continue;
        if (!/^https:\/\/hokhong\.tw\//.test(val) && !/^https:\/\/(www\.)?(afa|moa|naif)/.test(val)) {
          add(path, `${t}.${key} 網址可疑`, val.slice(0, 80));
        }
      }

      // 清單型別的 position 必須從 1 連號
      if (t === 'BreadcrumbList' || t === 'ItemList') {
        const pos = (o.itemListElement ?? []).map((x) => x.position);
        const okSeq = pos.every((p, i) => p === i + 1);
        if (!okSeq) add(path, `${t} position 不連號`, pos.slice(0, 8).join(','));
        for (const x of o.itemListElement ?? []) {
          if (!x.name) add(path, `${t} 項目缺 name`, '');
          if (t === 'BreadcrumbList' && !x.item) add(path, '麵包屑項目缺 item', '');
          if (t === 'ItemList' && !x.url) add(path, 'ItemList 項目缺 url', '');
        }
      }

      if (t === 'FAQPage') {
        for (const q of o.mainEntity ?? []) {
          if (!q.name?.trim()) add(path, 'FAQ 問題是空的', '');
          if (!q.acceptedAnswer?.text?.trim()) add(path, 'FAQ 答案是空的', q.name ?? '');
        }
      }

      if (t === 'WebPage' && o.dateModified && !/^\d{4}-\d{2}-\d{2}$/.test(o.dateModified)) {
        add(path, 'dateModified 不是 YYYY-MM-DD', o.dateModified);
      }

      if (t === 'Dataset' && o.temporalCoverage && !/^\d{4}-\d{2}-\d{2}\/\d{4}-\d{2}-\d{2}$/.test(o.temporalCoverage)) {
        add(path, 'temporalCoverage 格式不對', o.temporalCoverage);
      }
    }

    // 答案句與 meta description 也是同一批格式化函式組出來的，一起驗
    const body = html.slice(html.indexOf('<body'));
    for (const sr of body.matchAll(/<p class="sr-only">(.*?)<\/p>/gs)) {
      const text = sr[1].replace(/<[^>]+>/g, '');
      for (const [label, re] of JUNK) {
        if (re.test(text)) add(path, `答案句含「${label}」`, text.slice(0, 90));
      }
    }
    const desc = /<meta name="description" content="([^"]*)"/.exec(html)?.[1] ?? '';
    for (const [label, re] of JUNK) {
      if (re.test(desc)) add(path, `description 含「${label}」`, desc.slice(0, 90));
    }
    const title = /<title>([^<]*)<\/title>/.exec(html)?.[1] ?? '';
    for (const [label, re] of JUNK) {
      if (re.test(title)) add(path, `title 含「${label}」`, title.slice(0, 90));
    }
  }

  console.log(`  驗了 ${fmt(objs)} 個 JSON-LD 物件（只看可收錄頁）`);
  if (!problems.length) console.log('  ✓ 沒有發現問題');
  else {
    const byWhat = new Map();
    for (const p of problems) {
      if (!byWhat.has(p.what)) byWhat.set(p.what, []);
      byWhat.get(p.what).push(p);
    }
    console.log(`  ✗ ${fmt(problems.length)} 個問題，${byWhat.size} 種：`);
    for (const [what, list] of [...byWhat].sort((a, b) => b[1].length - a[1].length)) {
      console.log(`    ${what}  ×${fmt(list.length)}`);
      for (const p of list.slice(0, 2)) console.log(`      ${p.path}  ${p.detail}`);
    }
  }
}

console.log('');
