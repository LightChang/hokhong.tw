// 品項頁「價格走勢」的股票式線圖：K 線＋均線（趨勢線）＋交易量。伺服器端先畫預設區間，
// 瀏覽器端換區間、換單位時用同一支重畫，所以這裡不得 import node 模組。
//
// 遵循 dataviz（與 PriceLine.astro 同一套）：
//   - 單一 y 軸；交易量是繪圖區底部的獨立一帶，不給第二根 y 軸（值在 tooltip 與表格裡）
//   - SVG 只畫圖形、可被非等比拉伸；所有文字都是 HTML，以百分比定位，字級照 token
//   - 漲跌不只靠顏色：漲是空心紅、跌是實心綠（台灣看盤習慣紅漲綠跌）
//   - 均線兩條：短的用 series-main 藍、長的用 series-mute 灰。不用粉色——跟紅 K 太近
//
// 區間與均線長度是設計常數：
//   3 個月 → 日線（每天只有一個全國均價，沒有開高低收，所以畫折線）＋ 20 日均線
//   1 年   → 週 K ＋ 4 週、13 週均線（約一個月、一季）
//   3 年、全部 → 月 K ＋ 3 個月、12 個月均線。12 個月均線把季節性平均掉，是真正的長期趨勢
import { fromKg, fmtNum, perLabel } from './unit.mjs';

const W = 900;
const PRICE_H = 250;   // 價格區
const GAP = 14;
const VOL_H = 56;      // 交易量帶
const H = PRICE_H + GAP + VOL_H;

// 均線：視窗內至少一半有值才算，否則不畫（產季短的水果 12 個月均線本來就算不出來，就不給）
const movingAvg = (vals, n) => vals.map((_, i) => {
  if (i < n - 1) return null;
  const w = vals.slice(i - n + 1, i + 1).filter((v) => v != null);
  return w.length >= Math.ceil(n / 2) ? w.reduce((s, v) => s + v, 0) / w.length : null;
});

// 月份、週次補成連續的軸：沒有交易的期別留空（休市、產季外），K 線斷開而不是把兩端接起來
const nextMonth = (ym) => {
  const [y, m] = ym.split('-').map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
};
const nextWeek = (d) => new Date(Date.parse(`${d}T00:00:00Z`) + 7 * 86400_000).toISOString().slice(0, 10);
const fillAxis = (rows, next) => {
  if (!rows.length) return [];
  const by = new Map(rows.map((r) => [r[0], r]));
  const out = [];
  for (let k = rows[0][0]; k <= rows.at(-1)[0]; k = next(k)) out.push(by.get(k) ?? [k, null, null, null, null, null, null]);
  return out;
};
const rocYear = (y) => Number(y) - 1911;
const md = (iso) => `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))}`;
const rocDate = (iso) => `${rocYear(iso.slice(0, 4))}/${iso.slice(5, 7)}/${iso.slice(8, 10)}`;

// doc.kline（transform/emit-page.mjs）與日線 → 各區間要畫的資料。均線用整段序列算完再切區間，
// 區間第一根就有均線可看。
export function buildViews({ kline, daily }) {
  const views = [];
  if (daily?.length > 1) {
    const a = daily.map((d) => d.a);
    const ma20 = movingAvg(a, 20);
    views.push({
      key: '3m', label: '3 個月', kind: 'line', period: '日',
      rows: daily.map((d, i) => ({ x: md(d.d), t: rocDate(d.d), a: d.a, v: d.v, ma: [ma20[i]] })),
      ma: [{ label: '20 日均線', role: 'mute' }],
    });
  }
  const toRows = (raw, fmtX, fmtT, ns) => {
    const a = raw.map((r) => r[5]);
    const mas = ns.map((n) => movingAvg(a, n));
    return raw.map((r, i) => ({ x: fmtX(r[0]), t: fmtT(r[0]), o: r[1], h: r[2], l: r[3], c: r[4], a: r[5], v: r[6], ma: mas.map((m) => m[i]) }));
  };
  const week = fillAxis(kline?.week ?? [], nextWeek);
  if (week.length > 13) {
    views.push({
      key: '1y', label: '1 年', kind: 'candle', period: '週',
      rows: toRows(week, md, (d) => `${rocDate(d)} 那週`, [4, 13]).slice(-53),
      ma: [{ label: '4 週均線', role: 'main' }, { label: '13 週均線', role: 'mute' }],
    });
  }
  const month = fillAxis(kline?.month ?? [], nextMonth);
  if (month.length > 1) {
    const rows = toRows(month, (ym) => `${rocYear(ym.slice(0, 4))}/${ym.slice(5)}`,
      (ym) => `民國 ${rocYear(ym.slice(0, 4))} 年 ${Number(ym.slice(5))} 月`, [3, 12]);
    const ma = [{ label: '3 個月均線', role: 'main' }, { label: '12 個月均線', role: 'mute' }];
    if (rows.length > 36) views.push({ key: '3y', label: '3 年', kind: 'candle', period: '月', rows: rows.slice(-36), ma });
    views.push({ key: 'all', label: '全部', kind: 'candle', period: '月', rows, ma });
  }
  return views;
}

// y 軸刻度取整齊的數（1、2、2.5、5 × 10^n），換到 100 克時數字很小也不會出現重複的標籤
const niceTicks = (lo, hi, count = 4) => {
  const raw = (hi - lo) / count || 1;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
  const start = Math.floor(lo / step) * step;
  const ticks = [];
  for (let v = start; v <= hi + step * 1e-9; v += step) ticks.push(+v.toFixed(6));
  if (ticks.at(-1) < hi) ticks.push(+(ticks.at(-1) + step).toFixed(6));
  return { ticks, decimals: step < 1 ? (String(step).split('.')[1]?.length ?? 1) : 0 };
};

const f1 = (v) => v.toFixed(1);

// 一個區間 × 一個單位 → 圖的 HTML（.chart-wrap 內層）。伺服器端 set:html、瀏覽器端 innerHTML 共用。
// 內容只有數字與本檔的固定字串，沒有外部文字，不會有注入問題。
export function renderView(view, unit) {
  const k = (v) => fromKg(v, unit);
  const rows = view.rows;
  const n = rows.length;
  const vals = rows.flatMap((r) => (view.kind === 'candle' ? [r.h, r.l] : [r.a]).concat(r.ma)).filter((v) => v != null).map(k);
  const vMin = vals.length ? Math.min(...vals) : 0;
  const vMax = vals.length ? Math.max(...vals) : 1;
  const pad = (vMax - vMin) * 0.06 || vMax * 0.1 || 1;
  const { ticks, decimals } = niceTicks(Math.max(0, vMin - pad), vMax + pad);
  const lo = ticks[0], hi = ticks.at(-1);
  const slot = W / Math.max(n, 1);
  const xAt = (i) => slot * (i + 0.5);
  const yAt = (v) => PRICE_H - ((k(v) - lo) / (hi - lo)) * PRICE_H;
  const vMaxVol = Math.max(...rows.map((r) => r.v ?? 0), 1);
  const pctX = (i) => `${((xAt(i) / W) * 100).toFixed(3)}%`;
  const pctY = (y) => `${((y / H) * 100).toFixed(3)}%`;

  const grid = ticks.map((t) => {
    const y = PRICE_H - ((t - lo) / (hi - lo)) * PRICE_H;
    return `<line x1="0" x2="${W}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}" />`;
  }).join('');
  const bw = Math.max(slot * 0.62, 1.2);
  const vols = rows.map((r, i) => {
    if (!r.v) return '';
    const h = (r.v / vMaxVol) * VOL_H;
    return `<rect x="${(xAt(i) - bw / 2).toFixed(2)}" y="${(H - h).toFixed(2)}" width="${bw.toFixed(2)}" height="${h.toFixed(2)}" />`;
  }).join('');
  const pathOf = (get) => {
    let d = '', open = false;
    rows.forEach((r, i) => {
      const v = get(r);
      if (v == null) { open = false; return; }
      d += `${open ? 'L' : 'M'}${xAt(i).toFixed(1)} ${yAt(v).toFixed(1)} `;
      open = true;
    });
    return d.trim();
  };
  let marks = '';
  if (view.kind === 'candle') {
    marks = rows.map((r, i) => {
      if (r.o == null) return '';
      const dir = r.c > r.o ? 'up' : r.c < r.o ? 'down' : 'flat';
      const top = yAt(Math.max(r.o, r.c)), bot = yAt(Math.min(r.o, r.c));
      const h = Math.max(bot - top, PRICE_H * 0.006);
      const x = xAt(i).toFixed(2);
      return `<g class="k ${dir}"><line x1="${x}" x2="${x}" y1="${yAt(r.h).toFixed(1)}" y2="${yAt(r.l).toFixed(1)}" />`
        + `<rect x="${(xAt(i) - bw / 2).toFixed(2)}" y="${top.toFixed(1)}" width="${bw.toFixed(2)}" height="${h.toFixed(1)}" /></g>`;
    }).join('');
  } else {
    marks = `<path class="line main" d="${pathOf((r) => r.a)}" />`;
  }
  const maLines = view.ma.map((m, j) => `<path class="line ${m.role}" d="${pathOf((r) => r.ma[j])}" />`).join('');

  // 最後一期的均價標在右端：「現在多少」是買菜的人第一個要的數字
  const lastI = rows.findLastIndex((r) => r.a != null);
  const last = lastI >= 0 ? rows[lastI] : null;
  const endY = last ? yAt(last.a) : 0;
  const end = last
    ? `<i class="dot" style="left:${pctX(lastI)};top:${pctY(endY)}"></i>`
      + `<span class="endlabel${endY / H < 0.25 ? ' below' : ''}" style="left:${pctX(lastI)};top:${pctY(endY)}">${fmtNum(k(last.a))}</span>`
    : '';
  const xIdx = n <= 2 ? rows.map((_, i) => i) : [0, Math.round((n - 1) / 3), Math.round(((n - 1) * 2) / 3), n - 1];
  const yLabels = ticks.map((t) => t.toFixed(decimals));
  const yCh = Math.max(...yLabels.map((s) => s.length), 1);

  return `<div class="chart-wrap" style="--y-axis-ch:${yCh}">
    <div class="y-axis" aria-hidden="true">${ticks.map((t, i) =>
      `<span style="top:${pctY(PRICE_H - ((t - lo) / (hi - lo)) * PRICE_H)}">${yLabels[i]}</span>`).join('')}</div>
    <div class="plot" style="aspect-ratio:${W}/${H}">
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
        <g class="grid">${grid}</g>
        <g class="vol">${vols}</g>
        ${marks}${maLines}
        <line class="cross" data-cross style="opacity:0" y1="0" y2="${H}" x1="0" x2="0" />
        <rect class="hit" data-hit x="0" y="0" width="${W}" height="${H}" />
      </svg>
      ${end}
      <div class="tip" data-tip></div>
    </div>
    <div class="x-axis" aria-hidden="true">${xIdx.map((i) =>
      `<span class="${i === 0 ? 'start' : i === n - 1 ? 'end' : 'mid'}" style="left:${pctX(i)}">${rows[i].x}</span>`).join('')}</div>
  </div>`;
}

// tooltip 的文字（一期一筆）。開高低收只在 K 線區間給；量用公噸（大宗品項一個月幾千公噸）
export function tipLines(view, i, unit) {
  const r = view.rows[i];
  if (!r || r.a == null) return null;
  const k = (v) => fmtNum(fromKg(v, unit));
  const per = perLabel(unit);
  const lines = [`${view.period === '日' ? '均價' : `${view.period}均價`} ${k(r.a)} ${per}`];
  if (view.kind === 'candle' && r.o != null) lines.push(`開 ${k(r.o)}　高 ${k(r.h)}　低 ${k(r.l)}　收 ${k(r.c)}`);
  const ma = view.ma.map((m, j) => (r.ma[j] == null ? null : `${m.label} ${k(r.ma[j])}`)).filter(Boolean);
  if (ma.length) lines.push(ma.join('　'));
  if (r.v) lines.push(`交易量 ${r.v >= 10_000 ? `${f1(r.v / 1000)} 公噸` : `${Math.round(r.v).toLocaleString('zh-TW')} 公斤`}`);
  return { title: r.t, lines };
}

// 滑鼠或手指的位置 → 第幾期（與 renderView 同一套 x 座標）
export const indexAt = (view, fx) => Math.min(Math.max(Math.floor(fx * view.rows.length), 0), view.rows.length - 1);
export const xPct = (view, i) => (i + 0.5) / view.rows.length;

// 圖例跟著區間換（日線是折線、其餘是 K 線；均線長度不同）
export const legendHtml = (view) => [
  view.kind === 'candle'
    ? '<span class="k-up"><i class="kbox"></i>漲</span><span class="k-down"><i class="kbox"></i>跌</span>'
    : '<span class="main"><i></i>每日均價</span>',
  ...view.ma.map((m) => `<span class="${m.role}"><i></i>${m.label}</span>`),
  '<span class="vol"><i class="kbox"></i>交易量</span>',
].join('');
