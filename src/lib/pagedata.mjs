// 讀 transform/emit-page.mjs 產出的 per-page JSON。
// build 期間只做讀檔，不查 DuckDB（理由見 transform/STORAGE.md §1）。
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

// 不能用 new URL(..., import.meta.url)：build 時這個模組會被打包搬到 dist/.prerender/chunks/，
// 相對路徑就會指向 dist/data/page/（不存在）。一律以專案根目錄解析。
const PAGE = resolve(process.cwd(), 'data/page');

const readJson = async (rel) => JSON.parse(await readFile(join(PAGE, rel), 'utf-8'));
const listSlugs = async (dir) =>
  (await readdir(join(PAGE, dir))).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort();

// 市場座標：人工整理（OSM Nominatim + 縣市驗證），不在 data/page 而在 overrides/
// 品項頁也要用它補市場名稱（行情站有幾個代號沒給名字），356 頁各讀一次檔沒必要，快取住。
let _marketGeo;
export const marketGeo = () => (_marketGeo ??=
  readFile(resolve(process.cwd(), 'overrides/market-geo.json'), 'utf-8')
    .then((s) => JSON.parse(s).markets));

export const siteIndex = () => readJson('index.json');
export const cheapNow = () => readJson('cheap-now.json');
export const home = () => readJson('home.json');
// 買菜清單：整包內嵌到首頁，讓瀏覽器端自己查使用者清單上每一項現在貴不貴
export const listSource = () => readJson('list-source.json');
// 3,440 個頁面都要用，快取住 promise，不要每頁讀一次檔
let _typhoon;
export const typhoon = () => (_typhoon ??= readJson('typhoon.json').catch(() => null));
export const crop = (slug) => readJson(`crop/${slug}.json`);
export const market = (slug) => readJson(`market/${slug}.json`);
export const cropMarket = (slug) => readJson(`crop-market/${slug}.json`);
// 畜禽（毛豬、家禽產地價）：資料形狀與蔬果不同，走 transform/animal.mjs 自己的管線
export const meatIndex = () => readJson('meat/index.json');
export const meat = (slug) => readJson(`meat/${slug}.json`);
export const meatSlugs = () => listSlugs('meat').then((s) => s.filter((x) => x !== 'index'));
export const cropSlugs = () => listSlugs('crop');
export const marketSlugs = () => listSlugs('market');
export const cropMarketSlugs = () => listSlugs('crop-market');

// ── 顯示格式 ──────────────────────────────
export const TC_LABEL = { N04: '蔬菜', N05: '水果', N06: '花卉' };
export const tcLabel = (tc) => TC_LABEL[tc] ?? '其他';

export const price = (v) => (v == null ? '—' : `${Number(v).toFixed(1)}`);
export const pct = (v) => (v == null ? '—' : `${v > 0 ? '+' : ''}${Number(v).toFixed(1)}%`);

// 交易量：公斤 → 公噸（超過 10 噸才換單位，避免小品項顯示 0.0 噸）
export const volume = (kg) => {
  if (kg == null) return '—';
  const n = Number(kg);
  return n >= 10_000 ? `${(n / 1000).toFixed(0)} 公噸` : `${n.toLocaleString('zh-TW', { maximumFractionDigits: 0 })} 公斤`;
};

// 西元 ISO → 民國，因為來源與使用者的語彙都是民國年
export const roc = (iso) => {
  if (!iso) return '—';
  const [y, m, d] = iso.split('-');
  return `${Number(y) - 1911}/${m}/${d}`;
};
export const ymLabel = (ym) => {
  const [y, m] = ym.split('-');
  return `${y}/${m}`;
};

// 漲跌方向：價格上漲對消費者不利，用 critical 色；下跌用 pass 色（見 site.css）
export const dirClass = (v) => (v == null ? '' : v > 0 ? 'up' : v < 0 ? 'down' : '');

// 漲跌幅的 diverging 分級 → 色塊 class。級距取自實際分佈（107 個品項：
// 便宜30%+ 5、便宜10–30% 24、持平±10% 34、貴10–30% 20、貴30–100% 17、貴100%+ 7）。
// 色塊編碼「多便宜／多貴」，文字顏色仍由 dirClass 決定（色階淺端不足以當文字色）。
export const levelClass = (v) => {
  if (v == null) return 'lv';
  if (v <= -30) return 'lv lv-c3';
  if (v <= -10) return 'lv lv-c2';
  if (v < 10) return 'lv';
  if (v < 30) return 'lv lv-p1';
  if (v < 100) return 'lv lv-p2';
  return 'lv lv-p3';
};
export const levelText = (v) => {
  if (v == null) return '資料不足';
  if (v <= -30) return '比常年便宜很多';
  if (v <= -10) return '比常年便宜';
  if (v < 10) return '跟常年差不多';
  if (v < 30) return '比常年貴一些';
  if (v < 100) return '比常年貴很多';
  return '比常年貴一倍以上';
};

// ── 給買菜的人看的說法 ──────────────────────
// 主數字一律是「比常年便宜/貴幾 %」。絕對價格只當佐證，因為實測零售是批發的
// 1.01–3.11 倍，用單一倍數推估攤價一定會錯（見 overrides/crop-retail-map.json）。
export const verdict = (pct) => {
  if (pct == null) return { text: '資料不足', tone: '' };
  if (pct <= -30) return { text: '現在很便宜', tone: 'down' };
  if (pct <= -10) return { text: '比平常便宜', tone: 'down' };
  if (pct < 10) return { text: '跟平常差不多', tone: '' };
  if (pct < 30) return { text: '比平常貴', tone: 'up' };
  return { text: '現在很貴', tone: 'up' };
};

// 比常年便宜 38% → 「便宜 38%」；貴的話講「貴」。方向字比正負號好懂。
export const changeWord = (pct) =>
  pct == null ? '—' : `${pct < 0 ? '便宜' : '貴'} ${Math.abs(pct).toFixed(0)}%`;

// 台中公有零售市場實測價。沒有對到的作物就不顯示，不推估。
export const cattyPrice = (retail) => (retail?.perCatty == null ? null : `${retail.perCatty} 元/斤`);

export const seasonText = (c) =>
  !c?.seasonal ? null : c.seasonCounties?.length ? `當季 · 產地 ${c.seasonCounties.slice(0, 2).join('、')}` : '當季';
