// 品項×市場頁頁首的「這個市場平常比全國貴還是便宜」（站主 2026-11-15 當面同意，限版面）。
//
// 頁首原本只有「最近交易日」的全國價與市場價，一天的差距常常是雜訊（三重芥藍某天「比全國低 81%」，
// 那時近 90 天只成交約 7 公噸）。買菜的人想知道的是常態：這個市場一般偏貴還是偏便宜、穩不穩、
// 在各市場裡排第幾。這支只用 emit-page 已經產出的月均價（crop-market/*.json 與 crop/*.json 的
// monthly），不讀 DuckDB、不加新來源，也不碰收錄判斷（index-state、INDEX_IN、遲滯規則都不讀不寫）。
//
// 怎麼算（/about/#m-crop-market 有對應的白話說明，改這裡的門檻要一起改那裡）：
//   1. 期間：該品項全國最新月份往回 12 個月（含最新月）。
//   2. 只用「這個市場這個月有足夠成交」的月份：交易量 ≥ MIN_MONTH_VOLUME 且交易日 ≥ MIN_MONTH_DAYS。
//   3. 每個月算 市場月均價 ÷ 全國同月均價 − 1；差距在 ±SIMILAR_PCT% 以內算「差不多」。
//   4. 有效月份 < MIN_MONTHS 就整段不給（頁面整段不顯示）——算不出可靠結論就不給數字（STORAGE.md §6）。
//   5. 偏向：較便宜的月份佔有效月份 ≥ LEAN_SHARE → cheaper；較貴的 ≥ LEAN_SHARE → dearer；
//      差不多的佔一半以上 → similar；其餘 mixed（時高時低）。
//   6. 排名：同一品項所有過了第 4 步的市場，依有效月份差距的中位數由低到高排（第 1 名＝最便宜）；
//      能排的市場 < MIN_RANKED 就不給排名。
// 頁面不給「差幾 %」：結構性的價差（分級、包裝不同）一樣會穩定出現，給百分比容易被讀成「到這裡買省多少」。
//
// 門檻是設計常數，2026-11-15 照本機資料（最後交易日 2026-10-06，3,050 個品項×市場組合）訂一次：
//   - 近 12 個月的「市場×月」交易量分位數：p10 93、p25 748、p50 8,746、p75 53,215、p90 168,744 公斤；
//     交易日 p25 8、p50 21 天。
//   - 月量 ≥ 5,000 公斤（約每個交易日 200 公斤以上）、交易日 ≥ 10、有效月 ≥ 6 時，
//     1,111 個組合給得出結論（可收錄的 1,288 頁中 1,060 頁）；門檻放到 3,000 公斤會多出約 100 組，
//     多半是一個月只成交兩三公噸的市場，月均價常被單筆零星成交拉走，就是「比全國低 81%」那種數字的來源。
//   - 這組門檻下，有效月份裡偏向一致的比例中位數 0.91、p25 0.73，所以 LEAN_SHARE 取 2/3。
//
// 產出 data/page/cm-norm.json：{ lastDate, gates, pages: { "<品項slug>-<市場代號>": {...} } }
// 沒有出現在 pages 的頁＝不給這段。
// 用法：node transform/cm-norm.mjs（要在 emit-page 之後）
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MIN_MONTH_VOLUME = 5_000; // 公斤／月
export const MIN_MONTH_DAYS = 10;      // 交易日／月
export const MIN_MONTHS = 6;           // 12 個月裡至少幾個有效月份
export const SIMILAR_PCT = 3;          // 差距在 ±3% 以內算差不多
export const LEAN_SHARE = 2 / 3;       // 偏向一致的月份佔多少才講「偏便宜／偏貴」
export const MIN_RANKED = 3;           // 至少幾個市場可排才給排名
export const WINDOW_MONTHS = 12;

// 'YYYY-MM' 往回 n 個月
const monthsBack = (ym, n) => {
  let [y, m] = ym.split('-').map(Number);
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(`${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}`);
    m -= 1;
    if (m === 0) { m = 12; y -= 1; }
  }
  return out;
};

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const k = s.length >> 1;
  return s.length % 2 ? s[k] : (s[k - 1] + s[k]) / 2;
};

/**
 * 單一市場對全國的常態比較。給不出可靠結論時回傳 null。
 * @param {{ym:string,price:number|null,volume:number,days:number}[]} marketMonthly
 * @param {{ym:string,price:number|null}[]} nationalMonthly
 */
export function normFor(marketMonthly, nationalMonthly) {
  const natLast = nationalMonthly?.at(-1)?.ym;
  if (!natLast) return null;
  const window = new Set(monthsBack(natLast, WINDOW_MONTHS));
  const nat = new Map(nationalMonthly.map((p) => [p.ym, p.price]));
  const gaps = [];
  for (const p of marketMonthly ?? []) {
    if (!window.has(p.ym)) continue;
    const n = nat.get(p.ym);
    if (!(p.price > 0) || !(n > 0)) continue;
    if (!(p.volume >= MIN_MONTH_VOLUME) || !(p.days >= MIN_MONTH_DAYS)) continue;
    gaps.push((p.price / n - 1) * 100);
  }
  if (gaps.length < MIN_MONTHS) return null;
  const cheaper = gaps.filter((g) => g <= -SIMILAR_PCT).length;
  const dearer = gaps.filter((g) => g >= SIMILAR_PCT).length;
  const similar = gaps.length - cheaper - dearer;
  const months = gaps.length;
  const lean = cheaper / months >= LEAN_SHARE ? 'cheaper'
    : dearer / months >= LEAN_SHARE ? 'dearer'
      : similar / months > 0.5 ? 'similar'
        : 'mixed';
  return { months, cheaper, dearer, similar, lean, median: +median(gaps).toFixed(2), window: [monthsBack(natLast, WINDOW_MONTHS).at(-1), natLast] };
}

/**
 * 同一品項的各市場排名（第 1 名＝差距中位數最低＝最便宜）。可排的市場 < MIN_RANKED 時不寫 rank。
 * @param {Map<string, object>} byCode  市場代號 → normFor 的結果（null 的不要放進來）
 */
export function rankMarkets(byCode) {
  const list = [...byCode.entries()].sort((a, b) => a[1].median - b[1].median || a[0].localeCompare(b[0]));
  if (list.length < MIN_RANKED) return;
  list.forEach(([, v], i) => { v.rank = i + 1; v.of = list.length; });
}

async function main() {
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
  const PAGE = join(ROOT, 'data', 'page');
  const readJson = async (p) => JSON.parse(await readFile(p, 'utf-8'));
  const files = (await readdir(join(PAGE, 'crop-market'))).filter((f) => f.endsWith('.json')).sort();

  // 品項 slug → [{ code, doc }]
  const byCrop = new Map();
  for (const f of files) {
    const slug = f.slice(0, -5);
    const i = slug.lastIndexOf('-');
    const crop = slug.slice(0, i);
    if (!byCrop.has(crop)) byCrop.set(crop, []);
    byCrop.get(crop).push({ code: slug.slice(i + 1), file: f });
  }

  const pages = {};
  let lastDate = null, nCrop = 0, nRanked = 0;
  const leanCount = { cheaper: 0, dearer: 0, similar: 0, mixed: 0 };
  for (const [crop, list] of byCrop) {
    const parent = await readJson(join(PAGE, 'crop', `${crop}.json`)).catch(() => null);
    if (!parent?.monthly?.length) continue;
    if (!lastDate || parent.lastDate > lastDate) lastDate = parent.lastDate;
    const got = new Map();
    for (const { code, file } of list) {
      const doc = await readJson(join(PAGE, 'crop-market', file));
      const r = normFor(doc.monthly, parent.monthly);
      if (r) got.set(code, r);
    }
    if (!got.size) continue;
    nCrop += 1;
    rankMarkets(got);
    for (const [code, v] of got) {
      pages[`${crop}-${code}`] = v;
      leanCount[v.lean] += 1;
      if (v.rank) nRanked += 1;
    }
  }

  const out = {
    lastDate,
    gates: { MIN_MONTH_VOLUME, MIN_MONTH_DAYS, MIN_MONTHS, SIMILAR_PCT, LEAN_SHARE, MIN_RANKED, WINDOW_MONTHS },
    pages,
  };
  await writeFile(join(PAGE, 'cm-norm.json'), JSON.stringify(out));
  const n = Object.keys(pages).length;
  console.error(`[cm-norm] 品項×市場 ${files.length} 頁，給得出常態比較 ${n} 頁（${nCrop} 個品項），其中有排名 ${nRanked} 頁；`
    + `偏便宜 ${leanCount.cheaper}、偏貴 ${leanCount.dearer}、差不多 ${leanCount.similar}、時高時低 ${leanCount.mixed}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
