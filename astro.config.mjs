import { readFileSync } from 'node:fs';
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

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
      lastmod: new Date(),
    }),
  ],
});
