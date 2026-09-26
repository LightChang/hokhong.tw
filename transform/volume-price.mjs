// 量價關係：這個品項「到貨量少一成，價格大概貴幾 %」，以及這一旬的量是多是少
//
// 回答「為什麼現在這個價」。買菜的人想知道是不是被坑，出貨的人想知道量崩價會不會跟著崩。
//
// 粒度刻意用「全國旬」，不是全國日：每天開秤的市場數從 1 到 21 不等，用全國日去看
// 量價變動會被休市整個蓋掉（實測甘藍日對日相關只有 -0.13，旬是 -0.41）。
//
// 做法：相鄰兩旬取 log 差分後做最小平方迴歸（Δln價 對 Δln量）。取 log 差分是因為
// 價與量都是水準值且有趨勢，直接迴歸會量到「兩者都隨年份上漲」而不是彼此的關係。
// 斜率就是彈性：量 ×0.9 時價格變成 ×0.9^斜率。
//
// 相關係數沒過門檻的品項不給數字——「這個品項的價格跟到貨量沒什麼關係」本身就是答案。
//
// 產出 data/page/volume-price.json：
//   { lastXun, byCrop: { <plv3_key>: { tcType, slope, r, n, pct10, now: {...} } } }
//
// 用法：node transform/volume-price.mjs
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect, q, DATA } from './_db.mjs';

const PAGE = join(DATA, 'page');
const AGG = join(DATA, 'agg');
const MIN_XUN = 30;        // 至少幾個旬的變動才給結論
const MIN_R = -0.2;        // 相關要至少這麼負，否則視為「關係不明顯」
const BASE_YEARS = 3;      // 這一旬的量跟近幾年同旬比
// 量差超過這個幅度時，不要再把彈性乘出來講「對應價格 +91%」——那是把線性迴歸
// 外推到樣本邊緣，數字會失真。超出範圍就只講量差與彈性本身。
const IMPLIED_MAX_PCT = 30;

const rd = (v, n = 2) => (v == null ? null : +Number(v).toFixed(n));
const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

async function main() {
  const con = await connect();
  await mkdir(PAGE, { recursive: true });

  const rows = await q(con, `SELECT tc_type, plv3_key, plv3, year, month, xun, wavg_price, volume
      FROM read_parquet('${join(AGG, 'plv3_xun.parquet')}')
     WHERE market_code = 'ALL' AND wavg_price > 0 AND volume > 0
     ORDER BY year, month, xun`);

  const by = new Map();
  for (const r of rows) {
    const key = `${r.tc_type}|${r.plv3_key}`;
    if (!by.has(key)) by.set(key, { tcType: r.tc_type, plv3Key: r.plv3_key, plv3: r.plv3, series: [] });
    by.get(key).series.push({
      year: Number(r.year), month: Number(r.month), xun: Number(r.xun),
      price: Number(r.wavg_price), volume: Number(r.volume),
    });
  }

  // 「最近一旬」一定要是**過完的**旬：進行中的旬只累積了幾天的量，直接拿去跟常年同旬
  // 比會得到「量少 57%」這種假訊號（實測 2026-09 中旬只到 16 日就是這樣）。
  const [{ last_date }] = await q(con, `SELECT max(trans_date)::VARCHAR AS last_date FROM read_parquet('${join(AGG, 'plv3_day.parquet')}')`);
  const lastXun = (() => {
    const [y, m, d] = last_date.split('-').map(Number);
    const endOf = (yy, mm, xx) => (xx === 3 ? new Date(Date.UTC(yy, mm, 0)).getUTCDate() : xx * 10);
    let cur = { year: y, month: m, xun: d >= 21 ? 3 : d >= 11 ? 2 : 1 };
    if (d < endOf(cur.year, cur.month, cur.xun)) {
      // 這個旬還沒過完 → 退到上一個旬
      cur = cur.xun > 1
        ? { year: cur.year, month: cur.month, xun: cur.xun - 1 }
        : cur.month > 1 ? { year: cur.year, month: cur.month - 1, xun: 3 } : { year: cur.year - 1, month: 12, xun: 3 };
    }
    return cur;
  })();
  const xunLabel = (x) => `${x.year}-${String(x.month).padStart(2, '0')} ${['上', '中', '下'][x.xun - 1] ?? x.xun}旬`;

  const byCrop = {};
  let weak = 0, few = 0;
  for (const [, c] of by) {
    const s = c.series;
    const d = [];
    for (let i = 1; i < s.length; i++) {
      // 只比相鄰的旬；中間缺旬（產季外沒量）就跳過，否則會把半年的落差當成一旬的變動
      const prev = s[i - 1], cur = s[i];
      const gap = (cur.year * 36 + cur.month * 3 + cur.xun) - (prev.year * 36 + prev.month * 3 + prev.xun);
      if (gap !== 1) continue;
      d.push([Math.log(cur.volume / prev.volume), Math.log(cur.price / prev.price)]);
    }
    if (d.length < MIN_XUN) { few++; continue; }
    const n = d.length;
    const mx = d.reduce((a, x) => a + x[0], 0) / n;
    const my = d.reduce((a, x) => a + x[1], 0) / n;
    let sxy = 0, sxx = 0, syy = 0;
    for (const [x, y] of d) { sxy += (x - mx) * (y - my); sxx += (x - mx) ** 2; syy += (y - my) ** 2; }
    if (!sxx || !syy) { weak++; continue; }
    const slope = sxy / sxx;
    const r = sxy / Math.sqrt(sxx * syy);
    if (!(r <= MIN_R)) { weak++; continue; }

    // 這一旬的量跟近三年同旬比。該作物在最近那個完整旬沒有量（產季外）就不講
    const latest = s.find((x) => x.year === lastXun.year && x.month === lastXun.month && x.xun === lastXun.xun) ?? null;
    let now = null;
    if (latest) {
      const base = s.filter((x) => x.month === latest.month && x.xun === latest.xun
        && x.year >= latest.year - BASE_YEARS && x.year < latest.year).map((x) => x.volume);
      const baseVol = median(base);
      // 迴歸是用「相鄰兩旬的變動」估的，所以要換算價差就得用同一個單位：跟上一旬比。
      // 跟常年同旬比的幅度動輒五六成，那已經在樣本邊緣，只能當背景資訊不能乘出來。
      const idx = s.indexOf(latest);
      const prev = idx > 0 ? s[idx - 1] : null;
      const adjacent = prev
        && (latest.year * 36 + latest.month * 3 + latest.xun) - (prev.year * 36 + prev.month * 3 + prev.xun) === 1;
      const prevPct = adjacent ? rd(((latest.volume - prev.volume) / prev.volume) * 100, 1) : null;
      if (baseVol || prevPct != null) {
        now = {
          xun: xunLabel(latest), volume: Math.round(latest.volume),
          // 背景：跟近三年同旬比（不換算價差）
          baseVolume: baseVol ? Math.round(baseVol) : null,
          baseYears: base.length,
          volPct: baseVol ? rd(((latest.volume - baseVol) / baseVol) * 100, 1) : null,
          // 換算用：跟上一旬比（與迴歸同單位）
          prevXun: adjacent ? xunLabel(prev) : null,
          prevPct,
          impliedPricePct: prevPct != null ? rd((Math.pow(latest.volume / prev.volume, slope) - 1) * 100, 1) : null,
          impliedOutOfRange: prevPct != null ? Math.abs(prevPct) > IMPLIED_MAX_PCT : null,
        };
      }
    }

    byCrop[c.plv3Key] = {
      tcType: c.tcType, plv3: c.plv3,
      slope: rd(slope, 3), r: rd(r, 2), n,
      // 給人看的說法：量少一成，價格大約貴幾 %
      pct10: rd((Math.pow(0.9, slope) - 1) * 100, 1),
      now,
    };
  }

  const out = {
    builtAt: new Date().toISOString(), lastDate: last_date,
    lastXun: xunLabel(lastXun),
    definition: { grain: '全國旬', method: '相鄰兩旬的 log 差分最小平方迴歸', minXun: MIN_XUN, minR: MIN_R, baseYears: BASE_YEARS },
    byCrop,
  };
  await writeFile(join(PAGE, 'volume-price.json'), JSON.stringify(out));

  const list = Object.values(byCrop).sort((a, b) => a.r - b.r);
  console.error(`量價關係：可用 ${list.length} 個作物、關係不明顯 ${weak} 個、旬數不足 ${few} 個；最新旬 ${out.lastXun}`);
  for (const c of list.slice(0, 6)) {
    console.error(`  ${c.plv3.padEnd(8)} r=${c.r} 斜率 ${c.slope} → 量少一成價格約 ${c.pct10 > 0 ? '+' : ''}${c.pct10}%`
      + (c.now ? `；這一旬量比常年同旬 ${c.now.volPct > 0 ? '+' : ''}${c.now.volPct}%、比上一旬 ${c.now.prevPct > 0 ? '+' : ''}${c.now.prevPct}%`
        + `（對應價格 ${c.now.impliedOutOfRange ? '幅度超出範圍，不換算' : `${c.now.impliedPricePct > 0 ? '+' : ''}${c.now.impliedPricePct}%`}）` : ''));
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
