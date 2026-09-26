// 年節前的菜價：什麼時候開始漲、漲多少、哪些不漲
//
// 情境是節前兩三週，使用者問「現在買還是再等」。往例算得出來：
//   春節／中秋／端午／清明各自的節前 21 天，價格相對「節前一個月」的水準怎麼走。
//
// 一個查資料才知道的關鍵事實：批發市場一路交易到除夕當天，初一才開始連休約五天
// （2026-09-26 用休市表的三年實例核對過）。所以要看的是節前那段，不是節後。
//
// 怎麼把「年節效應」跟「季節性」分開：只比「節前高峰 ÷ 節前一個月」不夠，因為那個比值
// 本身就含季節走勢（六月的寬皮柑產季結束在漲，硬算會得到端午前漲 510%，那不是端午造成的）。
// 農曆節慶的國曆日期每年前後移動三週，所以同一個曆日在別的年份可能離節慶很遠——
// 拿那些年份當對照組，把同一個比值算一次，兩者相除才是年節自己的效應。
//   節前比值 r = 節前 21 天高峰 ÷ 節前 43–29 天均價
//   對照比值 rc = 同曆日、且那年距離同一個節慶 > 21 天的年份，同樣算 r 的中位數
//   年節效應 = r / rc - 1
// 對照年也要排除颱風重疊，否則污染只是換一邊。
//
// 產出 data/page/festival.json：
//   { next, definition, byFestival: { <type>: { crops: [...] } }, byCrop: { <plv3_key>: { <type>: {...} } } }
//
// 用法：node transform/festival.mjs
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect, q, DATA, RAW, ROOT, today } from './_db.mjs';

const PAGE = join(DATA, 'page');
const AGG = join(DATA, 'agg');
const TYPES = [
  { id: 'cny', name: '春節', dateKey: 'eve', label: '除夕' },      // 對出貨與買菜都是除夕那天收尾
  { id: 'midAutumn', name: '中秋', dateKey: 'midAutumn', label: '中秋' },
  { id: 'duanwu', name: '端午', dateKey: 'duanwu', label: '端午' },
  { id: 'qingming', name: '清明', dateKey: 'qingming', label: '清明' },
];
const WINDOW_DAYS = 21;        // 節前觀察窗
const BASE_FROM = 43, BASE_TO = 29;   // 基準窗：節前 43 天到 29 天
const MIN_BASE_DAYS = 5;       // 基準窗至少要有幾個交易日
const AFFECTED_PCT = 15;       // 漲幅達這個數才算「這個年節真的有漲」
const MIN_SAMPLES = 3;         // 至少幾次「有漲」才給中位數
const MIN_VOLUME = 10_000;     // 常態日均量（公斤）：擋掉沒人買的冷門品項
const MIN_WINDOW_DAYS = 10;    // 節前窗至少要有幾個交易日（不然是產季外，均價是雜訊）
const MIN_CONTROLS = 3;        // 至少要有幾個對照年才給結論
// 對照年的同曆日要離那年的節慶多遠才算「沒有年節」。農曆節慶在國曆上前後移動約三週，
// 門檻放到 21 天會讓春節幾乎找不到對照年（實測只剩 10 個作物算得出來）。
const CONTROL_GAP = 14;

const shift = (iso, n) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const avg = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};
const rd = (v, n = 1) => (v == null ? null : +Number(v).toFixed(n));

async function main() {
  const con = await connect();
  await mkdir(PAGE, { recursive: true });

  const { festivals } = JSON.parse(await readFile(join(ROOT, 'overrides', 'festivals.json'), 'utf-8'));

  // 中秋與端午落在颱風季，節前窗只要碰到颱風，算出來的「年節漲幅」其實是颱風漲幅
  // （未剔除時中秋 47.7%、端午 57.6% 都高過春節 40.3%，那不合理）。
  // 判準：節前基準窗到節慶當天這段（43 天）只要與任何一次海上警報重疊，這一年不採計。
  const typhoons = JSON.parse(gunzipSync(await readFile(join(RAW, 'cwa-typhoon-warnings.json.gz'))).toString())
    .filter((t) => t.sea_start_datetime >= '2012')
    .map((t) => ({ from: t.sea_start_datetime.slice(0, 10), to: t.sea_end_datetime.slice(0, 10) }));
  const typhoonIn = (from, to) => typhoons.some((t) => t.from <= to && t.to >= from);
  let skippedTyphoon = 0, skippedThin = 0, skippedControl = 0;

  // 作物 × 日的全國量加權均價（與颱風那支同一個口徑：plv3_day 自己 sum，不用旬）
  const rows = await q(con, `SELECT trans_date::VARCHAR AS d, tc_type, plv3_key, any_value(plv3) AS plv3,
           sum(wavg_price * volume) / nullif(sum(volume), 0) AS price, sum(volume) AS volume
      FROM read_parquet('${join(AGG, 'plv3_day.parquet')}')
     WHERE wavg_price > 0 AND volume > 0 AND tc_type <> 'N06'
     GROUP BY 1, 2, 3 ORDER BY 1`);

  const byCropDay = new Map();
  for (const r of rows) {
    const key = `${r.tc_type}|${r.plv3_key}`;
    if (!byCropDay.has(key)) byCropDay.set(key, { plv3: r.plv3, tc: r.tc_type, key: r.plv3_key, days: new Map(), vols: [] });
    const c = byCropDay.get(key);
    c.days.set(r.d, Number(r.price));
    c.vols.push(Number(r.volume));
  }

  const [{ last_date }] = await q(con, `SELECT max(trans_date)::VARCHAR AS last_date FROM read_parquet('${join(AGG, 'plv3_day.parquet')}')`);

  // 某個作物、某一個「日期」的節前比值 r（節前 21 天高峰 ÷ 節前 43–29 天均價）
  const ratioAt = (c, day) => {
    // 只看節前 21 天窗有沒有颱風：那段是拿來抓高峰的，一次颱風就能把高峰整個換掉。
    // 基準窗是 15 天平均，受一次颱風的影響有限，若連基準窗都排除，中秋與端午會一年都不剩。
    if (typhoonIn(shift(day, -WINDOW_DAYS), day)) return { skip: 'typhoon' };
    const base = [];
    for (let i = BASE_TO; i <= BASE_FROM; i++) {
      const v = c.days.get(shift(day, -i));
      if (v) base.push(v);
    }
    const baseline = avg(base);
    if (!baseline || base.length < MIN_BASE_DAYS) return { skip: 'base' };
    let peak = null, peakOffset = null, tradingDays = 0;
    for (let i = WINDOW_DAYS; i >= 0; i--) {
      const v = c.days.get(shift(day, -i));
      if (v == null) continue;
      tradingDays++;
      if (peak == null || v > peak) { peak = v; peakOffset = i; }
    }
    if (peak == null) return { skip: 'nodata' };
    if (tradingDays < MIN_WINDOW_DAYS) return { skip: 'thin' };
    return { r: peak / baseline, baseline, peak, peakOffset };
  };

  const byCrop = {};       // plv3_key → { <type>: stats }
  for (const [, c] of byCropDay) {
    const volumeMedian = median(c.vols);
    if (volumeMedian == null || volumeMedian < MIN_VOLUME) continue;
    const out = {};
    for (const t of TYPES) {
      const events = [];
      for (const f of festivals) {
        const day = f[t.dateKey];
        if (!day || day > last_date) continue;         // 還沒發生的年節不算
        const got = ratioAt(c, day);
        if (got.skip) { if (got.skip === 'typhoon') skippedTyphoon++; else if (got.skip === 'thin') skippedThin++; continue; }

        // 對照組：同一個月日、但那一年距離同一個節慶超過 21 天
        const md = day.slice(5);
        const controls = [];
        for (const g of festivals) {
          if (g.year === f.year) continue;
          const ctrlDay = `${g.year}-${md}`;
          if (ctrlDay > last_date) continue;
          const ctrlFestival = g[t.dateKey];
          if (!ctrlFestival) continue;
          const gap = Math.abs((new Date(ctrlDay) - new Date(ctrlFestival)) / 86400_000);
          if (gap <= CONTROL_GAP) continue;            // 這一年的同曆日也在節慶附近，不能當對照
          const cg = ratioAt(c, ctrlDay);
          if (!cg.skip) controls.push(cg.r);
        }
        if (controls.length < MIN_CONTROLS) { skippedControl++; continue; }
        const rc = median(controls);
        const netPct = rd((got.r / rc - 1) * 100);
        events.push({
          year: f.year, date: day,
          baseline: rd(got.baseline, 2), peak: rd(got.peak, 2),
          rawPct: rd((got.r - 1) * 100), controlPct: rd((rc - 1) * 100), netPct,
          controls: controls.length,
          daysBefore: got.peakOffset, affected: netPct >= AFFECTED_PCT,
        });
      }
      const affected = events.filter((e) => e.affected);
      if (events.length < MIN_SAMPLES) continue;
      out[t.id] = {
        samples: events.length,
        affectedCount: affected.length,
        affectedRate: Math.round((affected.length / events.length) * 100),
        // 中位數只取「真的有漲」那幾次：把沒漲的算進去會得到 0%，那不是「年節前會不會漲」的答案
        medianPeakPct: affected.length >= MIN_SAMPLES ? median(affected.map((e) => e.netPct)) : null,
        medianDaysBefore: affected.length >= MIN_SAMPLES ? median(affected.map((e) => e.daysBefore)) : null,
        events: events.slice(-6),
      };
    }
    if (Object.keys(out).length) byCrop[c.key] = { plv3: c.plv3, tcType: c.tc, volumeMedian: Math.round(volumeMedian), ...out };
  }

  // 各年節的榜單：漲最兇的在前（只收有中位數的）
  const byFestival = {};
  for (const t of TYPES) {
    const crops = Object.entries(byCrop)
      .filter(([, v]) => v[t.id]?.medianPeakPct != null)
      .map(([key, v]) => ({ key, plv3: v.plv3, tcType: v.tcType, ...v[t.id] }))
      .sort((a, b) => b.medianPeakPct - a.medianPeakPct);
    if (!crops.length) continue;
    byFestival[t.id] = {
      name: t.name, label: t.label,
      crops: crops.slice(0, 40),
      calm: [...crops].sort((a, b) => a.affectedRate - b.affectedRate || a.medianPeakPct - b.medianPeakPct).slice(0, 10),
      medianPeakPct: median(crops.map((c) => c.medianPeakPct)),
      medianDaysBefore: median(crops.map((c) => c.medianDaysBefore)),
      cropCount: crops.length,
    };
  }

  // 下一個年節：以台北時間今天算，頁面用它決定要不要現在講這件事
  const now = today();
  let next = null;
  for (const f of festivals) {
    for (const t of TYPES) {
      const day = f[t.dateKey];
      if (!day || day < now) continue;
      const daysUntil = Math.round((new Date(day) - new Date(now)) / 86400_000);
      if (!next || daysUntil < next.daysUntil) {
        next = { type: t.id, name: t.name, label: t.label, date: day, year: f.year, daysUntil };
      }
    }
  }

  const out = {
    builtAt: new Date().toISOString(), lastDate: last_date, asOf: now,
    definition: { windowDays: WINDOW_DAYS, baseFrom: BASE_FROM, baseTo: BASE_TO, affectedPct: AFFECTED_PCT, minSamples: MIN_SAMPLES, minVolume: MIN_VOLUME },
    next, byFestival, byCrop,
  };
  await writeFile(join(PAGE, 'festival.json'), JSON.stringify(out));

  console.error(`年節 ${festivals.length} 年（${festivals[0].year}–${festivals.at(-1).year}）；有統計的作物 ${Object.keys(byCrop).length} 個`);
  console.error(`下一個：${next ? `${next.name}（${next.label} ${next.date}），還有 ${next.daysUntil} 天` : '無'}`);
  console.error(`剔除：節前窗碰到颱風 ${skippedTyphoon}、產季外交易日不足 ${skippedThin}、對照年不足 ${skippedControl}（單位：作物×年節）`);
  for (const t of TYPES) {
    const f = byFestival[t.id];
    if (!f) continue;
    console.error(`  ${t.name}：${f.cropCount} 個作物算得出往例，中位漲 ${f.medianPeakPct}%、高峰落在節前第 ${f.medianDaysBefore} 天`);
    console.error(`    漲最兇：${f.crops.slice(0, 6).map((c) => `${c.plv3} ${c.medianPeakPct}%（節前 ${c.medianDaysBefore} 天）`).join('、')}`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
