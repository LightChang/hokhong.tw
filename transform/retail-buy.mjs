// 台中公有零售市場的「這週價」與「買點」：蔬果（emit-page.mjs）與肉蛋（animal.mjs）共用同一套。
//
// 站主 2026-10-28：買菜的人要的是「攤子上喊到多少以下可以買」，不是推估的攤價。
// 有台中實測的品項直接從一年的訪價量出來，不用批發價乘倍率（實測過：拿別的品項的倍率去推，
// 誤差中位 22%、三成差到四成以上；攤價又幾乎不跟批發動，批發漲跌一成攤價平均只動 0.8%）。
// 沒有實測的品項就沒有買點，照舊只給批發價。
//   這週價  最近 RETAIL_WEEK_DAYS 個訪價日的中位數。30 天中位數太慢：2026-10 高麗菜批發已經跌回來，
//           30 天中位 48、最近 7 天 40（還把九月颱風那段算在裡面）
//   買點    一年裡每個月的攤價中位數，取便宜那四分之一的月份（第 25 百分位）；平常＝中位、貴＝第 75 百分位
// 每個月至少 RETAIL_MONTH_MIN 筆訪價才算那個月、至少 BUY_MIN_MONTHS 個月才給買點。
// 2026-10-28 實測蔬果 28 個作物全部有 12–13 個合格月份（荔枝、芒果這類產季短的也是 12），
// 門檻取半年，是為了將來訪價變少的品項不要拿兩三個月就喊買點。
export const RETAIL_WEEK_DAYS = 7;
export const RETAIL_MONTH_MIN = 20;
export const BUY_MIN_MONTHS = 6;
// 「划算／先別買」照攤價判（站主 2026-10-28）：
//   划算    這週價到買點，而且低於平常（柳丁一年都是 33 上下，買點＝平常，那不叫便宜）
//   先別買  這週價高於一年裡貴的那四分之一月份，而且比平常貴 RETAIL_PRICEY_MIN 以上
//           （同日實測：比平常貴的蔬果多在 +11%～+22%，差一兩塊的柳丁 +6% 不該叫人別買）
// 兩者會跟批發價打架：2026-10-28 青江菜批發比常年便宜 65%，攤子上卻是 48 元、比平常的 42 還貴。
export const RETAIL_PRICEY_MIN = 0.1;

const nearest = (vs, q) => vs[Math.min(vs.length - 1, Math.floor(vs.length * q))];

// valuesOf(row) → 這一列（一個市場一個訪價日）對這個品項的訪價，可能好幾欄（多品種合併）
export const weekPrice = (rows, valuesOf, rd = (v) => v) => {
  const days = [...new Set(rows.map((r) => r['訪價日期']))].sort().slice(-RETAIL_WEEK_DAYS);
  const d = new Set(days);
  const vs = rows.filter((r) => d.has(r['訪價日期'])).flatMap(valuesOf).filter((v) => v > 0).sort((a, b) => a - b);
  return vs.length >= RETAIL_MONTH_MIN ? rd(nearest(vs, 0.5)) : null;
};

export const buyLine = (rows, valuesOf) => {
  const byMonth = new Map();
  for (const r of rows) {
    const ym = r['訪價日期'].slice(0, 6);
    if (!byMonth.has(ym)) byMonth.set(ym, []);
    byMonth.get(ym).push(...valuesOf(r).filter((v) => v > 0));
  }
  const meds = [...byMonth.values()].filter((vs) => vs.length >= RETAIL_MONTH_MIN)
    .map((vs) => nearest(vs.sort((a, b) => a - b), 0.5)).sort((a, b) => a - b);
  if (meds.length < BUY_MIN_MONTHS) return null;
  return { cheap: Math.round(nearest(meds, 0.25)), usual: Math.round(nearest(meds, 0.5)), dear: Math.round(nearest(meds, 0.75)), months: meds.length };
};

export const retailNow = (r) => r?.week ?? r?.perCatty ?? null;
export const retailVerdict = (r) => {
  const now = retailNow(r);
  if (!r?.buy || now == null) return null;
  if (now <= r.buy.cheap && now < r.buy.usual) return 'cheap';
  if (now > r.buy.dear && now >= r.buy.usual * (1 + RETAIL_PRICEY_MIN)) return 'pricey';
  return 'normal';
};
// 這週價比平常貴／便宜幾 %（排序用）
export const retailPct = (r) => (retailNow(r) - r.buy.usual) / r.buy.usual * 100;
