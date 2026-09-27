// 讀 transform/emit-page.mjs 產出的 per-page JSON。
// build 期間只做讀檔，不查 DuckDB（理由見 transform/STORAGE.md §1）。
import { readFile, readdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

// 不能用 new URL(..., import.meta.url)：build 時這個模組會被打包搬到 dist/.prerender/chunks/，
// 相對路徑就會指向 dist/data/page/（不存在）。一律以專案根目錄解析。
const PAGE = resolve(process.cwd(), 'data/page');

const readJson = async (rel) => JSON.parse(await readFile(join(PAGE, rel), 'utf-8'));
const listSlugs = async (dir) =>
  (await readdir(join(PAGE, dir))).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort();

// 市場座標：人工整理（OSM Nominatim + 縣市驗證），不在 data/page 而在 overrides/
// 品項頁也要用它補市場名稱（行情站有幾個代號沒給名字），幾百頁各讀一次檔沒必要，快取住。
let _marketGeo;
export const marketGeo = () => (_marketGeo ??=
  readFile(resolve(process.cwd(), 'overrides/market-geo.json'), 'utf-8')
    .then((s) => JSON.parse(s).markets));

export const siteIndex = () => readJson('index.json');
// /about/ 與品項頁 FAQ 要交代的涵蓋範圍與覆蓋率：全部由 emit-page 算好，頁面不寫死數字
let _about;
export const about = () => (_about ??= readJson('about.json'));
export const cheapNow = () => readJson('cheap-now.json');
export const home = () => readJson('home.json');
// 買菜清單：整包內嵌到首頁，讓瀏覽器端自己查使用者清單上每一項現在貴不貴
export const listSource = () => readJson('list-source.json');
// 幾千個頁面都要用，快取住 promise，不要每頁讀一次檔
let _typhoon;
export const typhoon = () => (_typhoon ??= readJson('typhoon.json').catch(() => null));
// 休市：市場頁與市場清單都要用，同樣快取住
let _marketRest;
export const marketRest = () => (_marketRest ??= readJson('market-rest.json').catch(() => null));
// 年節：品項頁（往例）與首頁（節前提醒）都要用
let _festival;
export const festival = () => (_festival ??= readJson('festival.json').catch(() => null));
// 量價關係：品項頁「為什麼是這個價」用
let _volPrice;
export const volumePrice = () => (_volPrice ??= readJson('volume-price.json').catch(() => null));
// 產銷履歷／有機價差：樣本不足時 ready=false，頁面就不講（判準見 transform/tap.mjs）
let _tap;
export const tap = () => (_tap ??= readJson('tap.json').catch(() => null));
// 節日菜單：節日食材頁用（菜色對應是人工表，價格由轉換層接上）
let _festivalMenu;
export const festivalMenu = () => (_festivalMenu ??= readJson('festival-menu.json').catch(() => null));
// 品種與進口佔比：品項頁用
let _cropVariety;
export const cropVariety = () => (_cropVariety ??= readJson('crop-variety.json').catch(() => null));
// 品項性格（產季、價格波動度）：品項頁用
let _cropProfile;
export const cropProfile = () => (_cropProfile ??= readJson('crop-profile.json').catch(() => null));
// 市場集中度的說法。門檻在 transform/emit-page.mjs（cropsFor80），這裡只負責講法
export const MIX_TEXT = {
  focused: '專做型',
  mixed: '中型',
  broad: '綜合型',
};

// 波動度分級的說法。級距在 transform/crop-profile.mjs，這裡只負責講法
export const SWING_TEXT = {
  steady: { text: '價格很穩', advice: '不必等，什麼時候買差不多' },
  normal: { text: '價格一般', advice: '等幾天可能小幅變動' },
  jumpy: { text: '價格常跳動', advice: '過幾天再看常常差一兩成' },
};
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
// 休市日要講星期：使用者記的是「週一休市」，不是日期
const DOW = ['日', '一', '二', '三', '四', '五', '六'];
export const dowLabel = (iso) => DOW[new Date(`${iso}T00:00:00Z`).getUTCDay()];
// 休市日給人看的短格式：9/26（六）
export const restDate = (iso) => `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))}（${dowLabel(iso)}）`;

export const ymLabel = (ym) => {
  const [y, m] = ym.split('-');
  return `${y}/${m}`;
};

// 漲跌方向：價格上漲對消費者不利，用 critical 色；下跌用 pass 色（見 site.css）
export const dirClass = (v) => (v == null ? '' : v > 0 ? 'up' : v < 0 ? 'down' : '');

// 漲跌幅的 diverging 分級 → 色塊 class。級距取自 2026-09-12 當時榜單的實際分佈
// （便宜30%+ 5、便宜10–30% 24、持平±10% 34、貴10–30% 20、貴30–100% 17、貴100%+ 7；
// 現在的分佈跑 node scripts/status.mjs page 看候選數，級距本身是設計常數不隨資料變）。
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
// 主數字一律是「比常年便宜/貴幾 %」。絕對價格只當佐證，因為零售÷批發的倍數逐品項差很多，
// 用單一倍數推估攤價一定會錯（現值在 data/page/about.json 的 retail，別在註解裡寫死）。
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

// ── 市場名稱 ──────────────────────
// 一律讀 overrides/market-names.json，不用行情站每天給的名稱字串（同一代號不同日子給的名稱不同，
// 直接用會讓標題每天來回跳；另有幾個會講錯地方）。欄位定義與來源見該檔 _note。
let _marketNamesTable;
try {
  _marketNamesTable = JSON.parse(readFileSync(resolve(process.cwd(), 'overrides/market-names.json'), 'utf-8'));
} catch {
  _marketNamesTable = { produce: {}, flower: {} };
  console.warn('[market-names] 讀不到 overrides/market-names.json，市場名稱全部退回行情站名稱');
}
let _marketGeoSync;
const geoSync = () => (_marketGeoSync ??= (() => {
  try { return JSON.parse(readFileSync(resolve(process.cwd(), 'overrides/market-geo.json'), 'utf-8')).markets; }
  catch { return {}; }
})());
const _warned = new Set();
export const marketNames = (code, tc, rawName) => {
  const flower = tc === 'N06';
  const row = (flower ? _marketNamesTable.flower : _marketNamesTable.produce)?.[code];
  const g = geoSync()[code] ?? {};
  // 座標表只收果菜市場（105、700 例外，它們只有花卉）；同代號的花卉市場不在那個地址
  const geoApplies = !(flower && (g.fullName ?? '').includes('果菜'));
  const lat = geoApplies ? g.lat ?? null : null;
  const lon = geoApplies ? g.lon ?? null : null;
  if (!row) {
    const key = `${tc}-${code}`;
    if (!_warned.has(key)) {
      _warned.add(key);
      console.warn(`[market-names] ⚠ 市場代號 ${key}（行情站名稱「${rawName ?? ''}」）不在 overrides/market-names.json，暫用行情站名稱；請補進對照表`);
    }
    const name = rawName ?? code;
    const title = `${name}${flower ? '花卉' : '果菜'}市場`;
    return { known: false, title, full: (geoApplies && g.fullName) || title, short: name, place: name, nav: null, lat, lon };
  }
  return { known: true, ...row, nav: row.nav ?? null, lat, lon };
};

// 只有代號、不知道類別時（/about/ 的市場清單）：果菜表優先，沒有才查花卉表
export const marketNameByCode = (code, rawName) => {
  const row = _marketNamesTable.produce?.[code] ?? _marketNamesTable.flower?.[code];
  if (row) return row.full;
  return marketNames(code, 'N04', rawName).full;
};

// 常查品項：首頁要連出去的「熱門品項」。
// 不手挑（手挑的清單會過期），取近 90 天全國交易量最大的可收錄蔬果——
// 交易量大的就是大家天天在買、也最常查價格的那些。
let _popular;
export const popularCrops = (n = 16) => (_popular ??= (async () => {
  const idx = await siteIndex();
  const docs = await Promise.all(idx.crops
    .filter((c) => c.indexable && c.tcType !== 'N06')
    .map((c) => crop(c.slug).then((d) => ({ slug: c.slug, name: c.name, tcType: c.tcType, vol: d.quality?.volume90 ?? 0 }))
      .catch(() => null)));
  return docs.filter(Boolean).sort((a, b) => b.vol - a.vol);
})()).then((all) => all.slice(0, n));


// 最新行情：依「最近一次有成交的日子」排序（新的在前），同一天再依當天全國成交量。
// 給首頁與 /cheap/ 的「最新交易日有成交」區塊：每天換一批，讓爬蟲從入口頁走得到最近資料有變的品項頁。
// 只收可收錄的蔬果（noindex 頁不該從入口頁導流），exclude 用來避開同一頁上已經列過的品項。
let _latestTraded;
export const latestTradedCrops = async (n = 20, exclude = []) => {
  _latestTraded ??= (async () => {
    const idx = await siteIndex();
    const rows = await Promise.all(idx.crops
      .filter((c) => c.indexable && c.tcType !== 'N06')
      .map((c) => crop(c.slug).then((d) => {
        const last = (d.daily90 ?? []).map((r) => r.d).sort().at(-1);
        if (!last) return null;
        const vol = d.daily90.filter((r) => r.d === last).reduce((s, r) => s + (r.volume ?? 0), 0);
        return { slug: c.slug, name: c.name, last, vol };
      }).catch(() => null)));
    return rows.filter(Boolean).sort((a, b) => b.last.localeCompare(a.last) || b.vol - a.vol || a.slug.localeCompare(b.slug));
  })();
  const ex = new Set(exclude);
  return (await _latestTraded).filter((c) => !ex.has(c.slug)).slice(0, n);
};
