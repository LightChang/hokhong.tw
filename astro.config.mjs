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

// lastmod 必須是「內容上次變動的日子」，不是「上次 build 的時間」。
// 用 new Date() 的話每天 build 都會把全站 1,395 筆的 lastmod 往前推，等於告訴 Google
// 「這個站每天每頁都改」，它會停止採信這個欄位，回訪頻率反而掉下來。
// 站上每一頁的數字都是從同一份每日行情重算的，所以最後交易日就是全站的真實變動日：
// 來源沒有新資料的那天，lastmod 就不會動。
let lastmod;
try {
  const { lastDate } = JSON.parse(
    readFileSync(new URL('./data/page/index.json', import.meta.url), 'utf-8'),
  );
  if (lastDate) lastmod = new Date(`${lastDate}T00:00:00Z`);
} catch {
  console.warn('[sitemap] 找不到 data/page/index.json，這次不寫 lastmod');
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
      ...(lastmod ? { lastmod } : {}),
    }),
  ],
});
