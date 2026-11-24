// 寒流與菜價：寒流後哪些菜會漲、漲多少、多久回來（2026-11-24 站主拍板：/typhoon/ 擴成「天災與菜價」，網址不變）
//
// 寒流日期：中央氣象署的定義是「臺北氣象站最低氣溫 ≤ 10℃」（定義來源與資料來源見
// ingest/sources/cwa-taipei-tmin.mjs）。臺北站每日最低氣溫來自氣象署 CODiS：
// 歷年的在 overrides/cwa-taipei-tmin.json，這兩個月的在 ingest/raw/cwa-taipei-tmin.json.gz。
// 相隔 MERGE_GAP 天內的低溫日併成同一次寒流（一波冷空氣常分兩三次南下）。
//
// 為什麼不能照抄 typhoon.mjs（寒流前 14 天均價當基準、之後 21 天的最高價算高峰）：
//   1. 寒流多在 1、2 月，2012 年以來 22 次有 19 次的觀察窗碰到「除夕前 21 天到除夕後 7 天」
//      （2026-11-24 實算），漲的是寒流還是年前買氣分不開；直接排除就沒有往例可講。
//   2. 21 天裡挑最高的一天本來就容易比基準高：連 3 月沒有春節的寒流也有七成作物「漲兩成以上」。
// 所以這樣算：
//   對照年扣掉時節：每一次寒流，拿別的年份「同一個時節、而且那段沒有寒流」的同一段當對照——
//     碰到春節的寒流對齊「除夕前第幾天」（對照年同樣有年前買氣），其餘對齊國曆同一天。
//     每天價格先除以各自的寒流前基準，再除以對照年的中位數，剩下的才算寒流造成的。
//   5 天移動平均後才找高峰，回穩＝高峰之後回到 1.1 倍以內的第一天。
//   安慰劑檢查：把全部寒流日整體往前、往後平移 PLACEBO_SHIFTS 天重算一次（那些日子沒有寒流）。
//     一個作物的寒流漲幅要大於它在每一個平移下的漲幅，才講「寒流後會漲」——不然那只是這個菜平常的起伏。
//   基準期跟前一次寒流的觀察期重疊的，不算進往例（基準已經被前一次推高）。
//
// 產出 data/page/coldwave.json：{ events, byCrop, summary, latest, now, definition }
//
// 用法：node transform/coldwave.mjs
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect, q, RAW, DATA, ROOT, readL1 } from './_db.mjs';

const PAGE = join(DATA, 'page');
const MAP = join(DATA, 'identity', 'crop-map.parquet');
const COLD_C = 10;            // 氣象署寒流門檻（臺北站最低氣溫，含）
const MERGE_GAP = 7;          // 幾天內的低溫日算同一次
const BEFORE_DAYS = 14;
const AFTER_DAYS = 21;
const SMOOTH = 2;             // 移動平均 ±2 天
const RECOVER_RATIO = 1.1;
const RISE_PCT = 15;          // 中位漲幅至少這麼多才講「會漲」
const CALM_PCT = 5;           // 中位漲幅低於這個算「不太受影響」
const MIN_SAMPLES = 5;        // 至少幾次寒流有紀錄
const MIN_CONTROLS = 3;       // 每次至少幾個對照年
const MIN_NOW_VOLUME = 1000;
const CNY_BEFORE = 21, CNY_AFTER = 7;
const PLACEBO_SHIFTS = [-90, -75, -60, -45, -30, 30, 45, 60, 75, 90];

const shift = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
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

  const hist = JSON.parse(await readFile(join(ROOT, 'overrides', 'cwa-taipei-tmin.json'), 'utf-8'));
  const recent = await readFile(join(RAW, 'cwa-taipei-tmin.json.gz')).then((b) => JSON.parse(gunzipSync(b).toString())).catch(() => []);
  const tmin = new Map(hist.days.map((d) => [d.date, d.min]));
  for (const d of recent) if (d.min != null) tmin.set(d.date, d.min);
  const tLast = [...tmin.keys()].sort().at(-1);
  const { festivals } = JSON.parse(await readFile(join(ROOT, 'overrides', 'festivals.json'), 'utf-8'));
  const eves = festivals.map((f) => f.eve).filter(Boolean);
  const [{ last_date }] = await q(con, `SELECT max(trans_date)::VARCHAR AS last_date FROM read_parquet('${join(DATA, 'agg', 'plv3_day.parquet')}')`);

  // 寒流事件（offset ≠ 0 是安慰劑：整體平移）
  const buildEvents = (offset) => {
    const evs = [];
    for (const [d0, min] of [...tmin].sort(([a], [b]) => a.localeCompare(b))) {
      if (min == null || min > COLD_C) continue;
      const date = shift(d0, offset);
      if (date < '2012-01-01') continue;
      const cur = evs.at(-1);
      if (cur && (Date.parse(date) - Date.parse(cur.end)) / 86_400_000 <= MERGE_GAP) {
        cur.end = date; cur.coldDays++;
        if (min < cur.minTemp) { cur.minTemp = min; cur.minDate = date; }
      } else evs.push({ id: date, start: date, end: date, coldDays: 1, minTemp: min, minDate: date });
    }
    for (const [i, e] of evs.entries()) {
      e.from = shift(e.start, -BEFORE_DAYS);
      e.to = shift(e.start, AFTER_DAYS);
      e.eve = eves.find((d) => shift(d, CNY_AFTER) >= e.from && shift(d, -CNY_BEFORE) <= e.to) ?? null;
      e.cnyOverlap = !!e.eve;
      e.overlapPrev = i > 0 && evs[i - 1].to >= e.from;
      e.complete = e.to <= last_date;
      e.used = !e.overlapPrev && e.complete;
    }
    return evs;
  };
  const events = buildEvents(0);
  if (!events.length) throw new Error('寒流事件是 0：overrides/cwa-taipei-tmin.json 壞了？');
  const latest = [...events].reverse().find((e) => e.start <= last_date) ?? null;
  const daysSince = latest ? Math.round((Date.parse(last_date) - Date.parse(latest.end)) / 86_400_000) : null;

  await con.run(`CREATE TEMP TABLE daily AS
    SELECT make_date(CAST(substr(t."交易日期", 1, 3) AS INT) + 1911, CAST(substr(t."交易日期", 5, 2) AS INT), CAST(substr(t."交易日期", 8, 2) AS INT)) AS d,
           m.plv3_key, any_value(m.plv3) AS plv3, any_value(m.tc_type) AS tc_type,
           sum(t."平均價" * t."交易量") / nullif(sum(t."交易量"), 0) AS price, sum(t."交易量") AS volume
      FROM ${readL1()} t
      JOIN read_parquet('${MAP}') m ON m.crop_code = t."作物代號" AND m.tc_type = coalesce(t."種類代碼", '')
     WHERE t."作物代號" <> 'rest' AND t."交易量" > 0 AND t."種類代碼" IN ('N04', 'N05')
       AND m.confidence >= 0.8 AND m.plv3_key IS NOT NULL
     GROUP BY 1, 2`);
  const rows = await q(con, `SELECT d::VARCHAR AS d, plv3_key, plv3, tc_type, price, volume FROM daily WHERE d >= DATE '2011-09-01' ORDER BY 1`);
  const byCropDay = new Map();
  for (const r of rows) {
    if (!byCropDay.has(r.plv3_key)) byCropDay.set(r.plv3_key, { plv3: r.plv3, tc: r.tc_type, days: new Map(), vols: new Map() });
    byCropDay.get(r.plv3_key).days.set(r.d, Number(r.price));
    byCropDay.get(r.plv3_key).vols.set(r.d, Number(r.volume));
  }

  // 一個作物、一組事件 → 每次的（扣掉時節後）高峰漲幅與回穩天數
  const analyze = (c, evList) => {
    const pathAt = (startIso) => {
      const base = [];
      for (let i = 1; i <= BEFORE_DAYS; i++) { const v = c.days.get(shift(startIso, -i)); if (v) base.push(v); }
      const b = avg(base);
      if (!b || base.length < 5) return null;
      return { base: b, rel: Array.from({ length: AFTER_DAYS + 1 }, (_, t) => { const v = c.days.get(shift(startIso, t)); return v == null ? null : v / b; }) };
    };
    const out = [];
    for (const e of evList) {
      const me = pathAt(e.start);
      if (!me) continue;
      const ctrls = [];
      for (const f of festivals) {
        let cs;
        if (e.cnyOverlap) {
          if (!f.eve || f.eve === e.eve) continue;
          cs = shift(f.eve, Math.round((Date.parse(e.start) - Date.parse(e.eve)) / 86_400_000));
        } else {
          cs = `${f.year}${e.start.slice(4)}`;
          if (cs === e.start || cs.endsWith('02-29')) continue;
        }
        const cFrom = shift(cs, -BEFORE_DAYS), cTo = shift(cs, AFTER_DAYS);
        if (cFrom < '2012-01-01' || cTo > last_date) continue;
        // 對照那一段不能有（真的）寒流
        if (events.some((x) => x.from <= cTo && x.to >= cFrom)) continue;
        const p = pathAt(cs);
        if (p) ctrls.push(p.rel);
      }
      if (ctrls.length < MIN_CONTROLS) continue;
      const adj = me.rel.map((v, t) => {
        const cv = ctrls.map((r) => r[t]).filter((x) => x != null);
        const m = median(cv);
        return v == null || cv.length < MIN_CONTROLS || !m ? null : v / m;
      });
      const sm = adj.map((_, t) => {
        const w = adj.slice(Math.max(0, t - SMOOTH), t + SMOOTH + 1).filter((x) => x != null);
        return w.length >= SMOOTH + 1 ? avg(w) : null;
      });
      let peak = null, peakDay = null;
      sm.forEach((v, t) => { if (v != null && (peak == null || v > peak)) { peak = v; peakDay = t; } });
      if (peak == null) continue;
      let recovery = null;
      for (let t = peakDay + 1; t <= AFTER_DAYS; t++) if (sm[t] != null && sm[t] <= RECOVER_RATIO) { recovery = t; break; }
      out.push({ id: e.id, used: e.used, cny: e.cnyOverlap, baseline: rd(me.base, 2), peakPct: rd((peak - 1) * 100), peakDay, recoveryDays: recovery, controls: ctrls.length });
    }
    return out;
  };

  const placeboEvents = PLACEBO_SHIFTS.map((s) => buildEvents(s));
  const byCrop = {};
  const byEvent = {};
  const nowRows = [];
  for (const [key, c] of byCropDay) {
    const evs = analyze(c, events);
    const used = evs.filter((x) => x.used);
    for (const x of evs) {
      const t = (byEvent[x.id] ??= { peaks: [], rows: [] });
      t.peaks.push(x.peakPct);
      t.rows.push({ plv3: c.plv3, tcType: c.tc, key, peakPct: x.peakPct, recoveryDays: x.recoveryDays });
    }
    // 現在：最近一次寒流之後的最新價，對那次寒流前的基準（未扣時節，頁面要講明）
    if (latest && daysSince != null && daysSince <= AFTER_DAYS) {
      const vs = [], base = [];
      for (let i = 1; i <= BEFORE_DAYS; i++) {
        const v = c.vols.get(shift(latest.start, -i)); if (v) vs.push(v);
        const p = c.days.get(shift(latest.start, -i)); if (p) base.push(p);
      }
      let nowDate = null, nowPrice = null;
      for (const [d, v] of c.days) if (d >= latest.start && v != null && (nowDate == null || d > nowDate)) { nowDate = d; nowPrice = v; }
      const b = avg(base), pv = avg(vs);
      if (b && base.length >= 5 && nowPrice != null && pv >= MIN_NOW_VOLUME) {
        nowRows.push({ key, plv3: c.plv3, tcType: c.tc, baseline: rd(b, 2), price: rd(nowPrice, 2), date: nowDate,
          pct: rd((nowPrice / b - 1) * 100), preVolume: Math.round(pv), recovered: nowPrice <= b * RECOVER_RATIO });
      }
    }
    if (used.length < MIN_SAMPLES) continue;
    const realMed = median(used.map((x) => x.peakPct));
    const placebo = placeboEvents.map((pe) => median(analyze(c, pe).filter((x) => x.used).map((x) => x.peakPct))).filter((x) => x != null);
    const placeboMax = placebo.length ? Math.max(...placebo) : null;
    const rec = used.map((x) => x.recoveryDays).filter((x) => x != null);
    const rises = realMed >= RISE_PCT && placebo.length >= PLACEBO_SHIFTS.length / 2 && realMed > placeboMax;
    byCrop[key] = {
      plv3: c.plv3, tcType: c.tc,
      volumeMedian: Math.round(median([...c.vols.values()].filter((v) => v > 0)) ?? 0),
      samples: used.length, cnySamples: used.filter((x) => x.cny).length,
      medianPeakPct: realMed, placeboMaxPct: rd(placeboMax), placeboMedianPct: rd(median(placebo)),
      // 回穩天數只在「會漲」的作物有意義；21 天內沒回來的次數另計
      medianRecoveryDays: rises && rec.length ? median(rec) : null,
      neverRecovered: used.length - rec.length,
      level: rises ? 'rises' : realMed < CALM_PCT ? 'calm' : 'unclear',
    };
  }

  const withImpact = events.map((e) => {
    const { from, to, ...pub } = e;
    const a = byEvent[e.id];
    if (!a || !a.peaks.length) return { ...pub, impact: null };
    // 每一次寒流的影響只看量大的作物（跟頁面清單同一批），不然冷門品項的雜訊會灌進中位數
    const big = a.rows.filter((r) => (byCrop[r.key]?.volumeMedian ?? 0) >= 10_000);
    return { ...pub, impact: big.length ? {
      crops: big.length, medianPeakPct: median(big.map((r) => r.peakPct)),
      worst: big.sort((x, y) => y.peakPct - x.peakPct).slice(0, 5),
    } : null };
  });
  const cropList = Object.values(byCrop);
  const usedEv = withImpact.filter((e) => e.used && e.impact);
  const summary = {
    events: events.length, usedEvents: usedEv.length, cnyEvents: withImpact.filter((e) => e.cnyOverlap).length,
    crops: cropList.length, rises: cropList.filter((c) => c.level === 'rises').length, calm: cropList.filter((c) => c.level === 'calm').length,
    worstEvent: usedEv.length ? [...usedEv].sort((a, b) => b.impact.medianPeakPct - a.impact.medianPeakPct)[0].id : null,
  };

  const out = {
    builtAt: new Date().toISOString(), lastDate: last_date, tempLastDate: tLast,
    definition: { coldC: COLD_C, station: hist.station, mergeGap: MERGE_GAP, beforeDays: BEFORE_DAYS, afterDays: AFTER_DAYS,
      smoothDays: SMOOTH * 2 + 1, recoverRatio: RECOVER_RATIO, risePct: RISE_PCT, calmPct: CALM_PCT, minSamples: MIN_SAMPLES,
      minControls: MIN_CONTROLS, cnyBefore: CNY_BEFORE, cnyAfter: CNY_AFTER, placeboShifts: PLACEBO_SHIFTS,
      source: hist._source, definitionSource: hist._definition },
    latest: latest && { ...withImpact.find((e) => e.id === latest.id), daysSince },
    now: latest && daysSince != null && daysSince <= AFTER_DAYS ? {
      id: latest.id, start: latest.start, end: latest.end, minTemp: latest.minTemp, cnyOverlap: latest.cnyOverlap, daysSince, minVolume: MIN_NOW_VOLUME,
      crops: nowRows.sort((a, b) => b.pct - a.pct),
    } : null,
    summary, events: withImpact, byCrop,
  };
  await writeFile(join(PAGE, 'coldwave.json'), JSON.stringify(out));

  console.error(`寒流 ${events.length} 次（2012 起，臺北站 ≤ ${COLD_C}℃，氣溫資料到 ${tLast}）；往例用 ${usedEv.length} 次，其中碰到春節 ${usedEv.filter((e) => e.cnyOverlap).length} 次`);
  console.error(`  有往例的作物 ${cropList.length} 個：會漲 ${summary.rises}、不太受影響 ${summary.calm}；最近一次 ${latest ? `${latest.start} 最低 ${latest.minTemp}℃，${daysSince} 天前` : '無'}`);
  for (const c of cropList.filter((x) => x.level === 'rises' && x.volumeMedian >= 10_000).sort((a, b) => b.medianPeakPct - a.medianPeakPct).slice(0, 12)) {
    console.error(`  ${c.plv3.padEnd(8)} 漲 ${c.medianPeakPct}%（平移最高 ${c.placeboMaxPct}%）${c.medianRecoveryDays ?? '—'} 天回穩  ${c.samples} 次`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
