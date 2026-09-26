// IndexNow 提交（Bing / Yandex / Seznam / Naver 共用的即時收錄協定）。
// ⚠ Google 不吃 IndexNow——Google 靠 robots.txt 的 Sitemap 行與 GSC 自己爬。
//
// 這個站每天重建、1,400 多頁的價格每天都在動，**不能每天把整份 sitemap 丟出去**：
// 那是洗版，而且對方也不會因此多爬。送的是兩種：
//   1. 每天真的值得重爬的入口頁（首頁、榜單、颱風、清單頁、節日頁）
//   2. 這次部署**新出現**的網址（用「線上的舊 sitemap」與「dist 的新 sitemap」相減）
// 相減要在部署之前算（部署後線上就是新的了），所以 daily.yml 分兩步：先算清單，上線後才送。
//
// 用法：
//   node scripts/indexnow-submit.mjs --plan out.txt    # 上線前：算出要送的網址寫進檔案
//   node scripts/indexnow-submit.mjs --send out.txt    # 上線後：送出那份清單
//   加 --dry 只印不送。
// 環境變數：SITE_URL、INDEXNOW_KEY（32 hex，對應 public/<key>.txt）。
// 任何失敗都 exit 0，不擋部署——收錄提交不值得讓整條產線紅燈。
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const args = process.argv.slice(2);
const dry = args.includes('--dry');
const mode = args.includes('--send') ? 'send' : 'plan';
const file = args.find((a) => !a.startsWith('--')) ?? 'indexnow-urls.txt';

const SITE_URL = process.env.SITE_URL;
const KEY = process.env.INDEXNOW_KEY;
if (!SITE_URL || !KEY) { console.error('缺 SITE_URL 或 INDEXNOW_KEY，略過 IndexNow。'); process.exit(0); }
const site = new URL(SITE_URL);
const MAX = 200;                       // 一次最多送幾個，避免任何一天爆量
const locs = (xml) => [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);

// 每天都值得重爬的入口頁：內容真的每天換
const hubs = async () => {
  const fixed = ['/', '/cheap/', '/crop/', '/market/', '/meat/', '/typhoon/', '/about/'];
  const fes = await readdir(join('dist', 'festival')).catch(() => []);
  return [...fixed, ...fes.map((id) => `/festival/${id}/`)].map((p) => new URL(p, site).href);
};

const localSitemap = async () => {
  const dir = 'dist';
  const files = (await readdir(dir).catch(() => [])).filter((f) => /^sitemap-\d+\.xml$/.test(f));
  const urls = [];
  for (const f of files) urls.push(...locs(await readFile(join(dir, f), 'utf-8')));
  return new Set(urls);
};

const liveSitemap = async () => {
  const urls = new Set();
  try {
    const r = await fetch(new URL('sitemap-index.xml', site).href);
    if (!r.ok) return urls;
    for (const m of locs(await r.text())) {
      const rr = await fetch(m);
      if (rr.ok) for (const u of locs(await rr.text())) urls.add(u);
    }
  } catch (e) {
    console.error(`讀線上 sitemap 失敗（當成沒有舊清單，只送入口頁）：${e.message}`);
  }
  return urls;
};

if (mode === 'plan') {
  const [nw, old, hub] = [await localSitemap(), await liveSitemap(), await hubs()];
  // 線上讀不到舊 sitemap 時不要把 1,400 頁全當新頁送出去——那就是洗版
  const added = old.size ? [...nw].filter((u) => !old.has(u)) : [];
  const list = [...new Set([...hub, ...added])].slice(0, MAX);
  await writeFile(file, list.join('\n') + '\n');
  console.error(`IndexNow 清單：入口頁 ${hub.length} 個＋新網址 ${added.length} 個`
    + `${old.size ? '' : '（線上舊 sitemap 讀不到，這次不送新網址）'} → 共 ${list.length} 個，寫進 ${file}`);
  process.exit(0);
}

const list = (await readFile(file, 'utf-8').catch(() => '')).split('\n').map((s) => s.trim()).filter(Boolean);
if (!list.length) { console.error('清單是空的，略過。'); process.exit(0); }
const payload = { host: site.host, key: KEY, keyLocation: new URL(`/${KEY}.txt`, site).href, urlList: list };
console.error(`IndexNow：送 ${list.length} 個網址 → ${payload.keyLocation}`);
if (dry) { console.error(JSON.stringify(payload, null, 2)); process.exit(0); }
try {
  const res = await fetch('https://api.indexnow.org/indexnow', {
    method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify(payload),
  });
  console.error(`IndexNow 回應：${res.status}（200／202 為受理；422 多半是金鑰檔還沒上線）`);
} catch (e) {
  console.error(`IndexNow 送出失敗（不擋部署）：${e.message}`);
}
process.exit(0);
