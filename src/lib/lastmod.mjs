// sitemap <lastmod>：每一頁「資料最後一次實際變動的交易日」。
//
// 2026-09-27 站主拍板：原本全站 lastmod 都是同一個值（data/page/index.json 的 lastDate），
// 1,400 多頁同一天，Google 會判定這個欄位不可信而忽略。改成逐頁取自己的資料日期：
//   /crop/{品項}/            該品項近 90 天日資料裡最新一筆交易日（任何市場）
//   /crop/{品項}/{市場}/     該品項在該市場最新一筆交易日
//   /market/{slug}/          該市場該類別最新一筆到貨日
//   /meat/{slug}/            該品項最新一筆報價日
// 其餘頁（首頁、榜單、清單頁、颱風、節日食材、/about/）畫面上都有「更新至民國 X」與全站數字，
// 每次來源有新交易日內容就真的變，所以用全站最後交易日——那就是它們的內容變更日。
//
// 🔴 只讀 data/page 的 JSON，不看時鐘、不看 build 時間：同一份資料建兩次，日期必須一模一樣
//    （`node scripts/seo-audit.mjs lastmod` 會對 dist 的 sitemap 逐筆重算比對）。
// 🔴 日期不得晚於全站最後交易日，也不得從「沒有日資料」的頁推測——拿不到就退回全站日期。
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const readJson = (p) => JSON.parse(readFileSync(p, 'utf-8'));
const list = (dir) => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json') && !f.startsWith('._')) : []);
const maxOf = (xs) => xs.filter(Boolean).sort().at(-1) ?? null;

/** @returns {{ global: string|null, byPath: Map<string,string> }} 路徑不帶結尾斜線（'/crop/x'） */
export function pageLastmods(root = process.cwd()) {
  const PAGE = join(root, 'data/page');
  const byPath = new Map();
  let global = null;
  try { global = readJson(join(PAGE, 'index.json')).lastDate ?? null; } catch { /* 首次建置 */ }
  const cap = (d) => (d && global && d > global ? global : d);

  for (const f of list(join(PAGE, 'crop'))) {
    const d = readJson(join(PAGE, 'crop', f));
    const v = maxOf((d.daily90 ?? []).map((r) => r.d));
    if (v) byPath.set(`/crop/${f.slice(0, -5)}`, cap(v));
  }
  for (const f of list(join(PAGE, 'crop-market'))) {
    const d = readJson(join(PAGE, 'crop-market', f));
    const v = maxOf((d.daily90 ?? []).map((r) => r.d));
    const slug = f.slice(0, -5);
    const i = slug.lastIndexOf('-');
    if (v) byPath.set(`/crop/${slug.slice(0, i)}/${slug.slice(i + 1)}`, cap(v));
  }
  for (const f of list(join(PAGE, 'market'))) {
    const d = readJson(join(PAGE, 'market', f));
    const v = maxOf((d.daily ?? []).filter((r) => r.volume != null).map((r) => r.d));
    if (v) byPath.set(`/market/${f.slice(0, -5)}`, cap(v));
  }
  for (const f of list(join(PAGE, 'meat'))) {
    if (f === 'index.json') continue;
    const d = readJson(join(PAGE, 'meat', f));
    const v = maxOf((d.daily ?? []).map((r) => r.x));
    if (v) byPath.set(`/meat/${f.slice(0, -5)}`, cap(v));
  }
  return { global, byPath };
}

/** sitemap 用：給完整網址，回 ISO 日期（YYYY-MM-DD）或 null */
export function lastmodFor(url, lm) {
  const path = new URL(url).pathname.replace(/\/$/, '') || '/';
  return lm.byPath.get(path) ?? lm.global;
}
