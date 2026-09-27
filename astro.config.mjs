import { readFileSync } from 'node:fs';
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import { fileURLToPath } from 'node:url';
import { pageLastmods, lastmodFor } from './src/lib/lastmod.mjs';

// 收錄與否由轉換層每天重算，結果在 data/page/page-state.ndjson（indexable 0/1）。
// 這裡只是把那個判斷接到 sitemap，不在建置時重新發明門檻。
// 門檻與遲滯規則見 transform/emit-page.mjs 與 transform/STORAGE.md §6。
let indexable = null;
try {
  indexable = new Map(
    readFileSync(new URL('./data/page/page-state.ndjson', import.meta.url), 'utf-8')
      .trim().split('\n').filter(Boolean)
      .map((l) => JSON.parse(l))
      .map((s) => [s.path, s.indexable]),
  );
} catch {
  // 首次建置、或還沒跑過 transform/run.mjs：全部收錄，不要因此讓 build 失敗
  console.warn('[sitemap] 找不到 data/page/page-state.ndjson，這次全部收錄');
}

// lastmod 必須是「內容上次變動的日子」，不是「上次 build 的時間」（每天 build 都刷新會讓 Google
// 停止採信這個欄位）。2026-09-27 起逐頁取該頁資料最後一次實際變動的交易日，
// 規則與理由見 src/lib/lastmod.mjs。
const lm = pageLastmods(fileURLToPath(new URL('.', import.meta.url)));
if (!lm.global) console.warn('[sitemap] 找不到 data/page/index.json，這次不寫 lastmod');

export default defineConfig({
  site: 'https://hokhong.tw',
  trailingSlash: 'always',
  build: { format: 'directory' },
  integrations: [
    sitemap({
      filter: (page) => {
        if (!indexable) return true;
        const path = new URL(page).pathname.replace(/\/$/, '') || '/';
        return indexable.get(path) !== 0;
      },
      changefreq: 'daily',
      serialize: (item) => {
        const d = lastmodFor(item.url, lm);
        return d ? { ...item, lastmod: `${d}T00:00:00.000Z` } : item;
      },
    }),
  ],
});
