#!/usr/bin/env node
// 版面檢查：用 headless chromium 量 dist/ 的代表頁，在手機到桌機五種尺寸下
//   1. 不得水平捲動（documentElement.scrollWidth <= clientWidth）
//   2. 按鈕／導航鈕不得超出所在列或視窗（被裁切）
//   3. 按鈕不得壓到同一列的文字（逐個文字節點量 Range 的矩形）
// 任一不過 exit 1。
//
//   node scripts/layout-check.mjs                     # 讀 dist/，自己起靜態伺服器
//   node scripts/layout-check.mjs --base=https://hokhong.tw   # 量線上
//   node scripts/layout-check.mjs --shots=/tmp/x      # 另存每頁每尺寸截圖
//
// playwright 不是本站相依（CI 不必裝瀏覽器）。本機執行時指定：
//   PLAYWRIGHT_MODULE=/path/to/node_modules/playwright  （預設 'playwright'）
//   CHROMIUM_PATH=/path/to/chrome-headless-shell        （預設用 playwright 自帶的）
// 2026-09-28 起因：市場清單的「導航」鈕吃到 .rows a 的 grid＋負邊距，手機凸出列外並壓到「N 天」。
// 同日清單改成 <table>，「所在列」一併量 <tr>。

import { createServer } from 'node:http';
import { readFile, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, extname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')));
const DIST = resolve('dist');
const VIEWPORTS = [[360, 800], [390, 844], [430, 932], [768, 1024], [1280, 800]];
// 會壓到文字的「控制元件」：列尾按鈕、標題旁的按鈕
// 導覽列連結也算：.shell 是 overflow-x: clip，擠出去不會產生水平捲動，只會被默默切掉
const CONTROLS = '.nav-btn, .add-btn, .list-tools button, .rows button, .screen-hd nav a, .home-hd nav a';

// ── 代表頁：每種頁型取一頁（可收錄的，才有完整內容） ──
async function firstIndexable(dir, depth) {
  const root = join(DIST, dir);
  if (!existsSync(root)) return null;
  const walk = async (d, left) => {
    for (const e of (await readdir(d)).sort()) {
      const p = join(d, e);
      if (!(await stat(p)).isDirectory()) continue;
      if (left === 1) {
        const f = join(p, 'index.html');
        if (existsSync(f) && !/name="robots" content="noindex"/.test(await readFile(f, 'utf-8'))) {
          return '/' + p.slice(DIST.length + 1) + '/';
        }
      } else {
        const r = await walk(p, left - 1);
        if (r) return r;
      }
    }
    return null;
  };
  return walk(root, depth);
}

const pages = ['/', '/market/', '/cheap/', '/crop/', '/meat/', '/typhoon/', '/about/', '/festival/', '/today/', '/season/', '/season/1/'];
if (!args.base) {
  for (const [dir, depth] of [['market', 1], ['crop', 1], ['crop', 2], ['meat', 1], ['festival', 1]]) {
    const p = await firstIndexable(dir, depth);
    if (p) pages.push(p);
  }
} else {
  pages.push('/market/n05-400/', '/crop/n04-00201002001/', '/crop/n04-00201002001/104/', '/meat/hog/', '/festival/cny/');
}

// ── 靜態伺服器（量本機 dist/ 時） ──
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.txt': 'text/plain' };
let server, base = args.base;
if (!base) {
  if (!existsSync(DIST)) { console.error('找不到 dist/。先跑 node transform/run.mjs'); process.exit(2); }
  server = createServer(async (req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p.endsWith('/')) p += 'index.html';
    try { res.writeHead(200, { 'content-type': TYPES[extname(p)] ?? 'application/octet-stream' }); res.end(await readFile(join(DIST, p))); }
    catch { res.writeHead(404); res.end(); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
}

const pwPath = process.env.PLAYWRIGHT_MODULE;
const { chromium } = await import(pwPath ? pathToFileURL(join(pwPath, 'index.mjs')).href : 'playwright');
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});

let fails = 0;
try {
  for (const [w, h] of VIEWPORTS) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h } });
    const pg = await ctx.newPage();
    for (const path of pages) {
      await pg.goto(base + path, { waitUntil: 'load' });
      const r = await pg.evaluate((CONTROLS) => {
        const de = document.documentElement;
        const vw = de.clientWidth;
        const problems = [];
        const hit = (a, b) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1
          && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1;
        if (de.scrollWidth > vw) problems.push(`水平捲動 ${de.scrollWidth}>${vw}`);
        for (const c of document.querySelectorAll(CONTROLS)) {
          const cr = c.getBoundingClientRect();
          if (!cr.width || getComputedStyle(c).visibility === 'hidden') continue;
          const label = (c.textContent || '').trim().slice(0, 8);
          if (cr.right > vw + 0.5 || cr.left < -0.5) problems.push(`「${label}」超出視窗 ${Math.round(cr.left)}–${Math.round(cr.right)}/${vw}`);
          const row = c.closest('li, tr, .list-tools, h1, h2');
          if (!row) continue;
          const rr = row.getBoundingClientRect();
          if ((row.tagName === 'LI' || row.tagName === 'TR') && (cr.right > rr.right + 0.5 || cr.left < rr.left - 0.5)) {
            problems.push(`「${label}」超出所在列 ${Math.round(cr.left)}–${Math.round(cr.right)} / 列 ${Math.round(rr.left)}–${Math.round(rr.right)}`);
          }
          const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
          for (let n; (n = walker.nextNode());) {
            if (!n.textContent.trim() || c.contains(n)) continue;
            const range = document.createRange(); range.selectNodeContents(n);
            for (const tr of range.getClientRects()) {
              if (tr.width && hit(cr, tr)) { problems.push(`「${label}」壓到文字「${n.textContent.trim().slice(0, 12)}」`); break; }
            }
          }
        }
        return [...new Set(problems)];
      }, CONTROLS);
      if (r.length) { fails++; console.log(`✗ ${w}x${h} ${path}\n    ${r.slice(0, 5).join('\n    ')}`); }
      else console.log(`✓ ${w}x${h} ${path}`);
      if (args.shots) await pg.screenshot({ path: `${args.shots}/${w}${path.replace(/\//g, '_')}.png` });
    }
    await ctx.close();
  }
} finally {
  await browser.close();
  server?.close();
}
console.log(fails ? `\n版面檢查：${fails} 組不過` : '\n版面檢查：全部通過');
process.exitCode = fails ? 1 : 0;
