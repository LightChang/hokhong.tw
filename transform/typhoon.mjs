// 颱風對菜價的實際影響：標註 + 對比
//
// 回答兩個問題：
//   1. 現在貴，是不是因為颱風？   → 最近一次颱風的日期與至今天數
//   2. 還要多久才會回穩？          → 歷次颱風後，該作物平均幾天回到颱風前的價格
//
// 「回穩」定義：颱風警報結束後，全國加權均價回到「颱風前 14 天均價 × 1.1」以內的第一天。
// 30 天內沒回到就記為未回穩（例如產季被打斷的情況）。
//
// 產出 data/page/typhoon.json：
//   { typhoons: [...], byCrop: { <plv3_key>: { samples, medianRecoveryDays, medianPeakPct, latest } } }
//
// 用法：node transform/typhoon.mjs
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect, q, one, RAW, DATA, readL1, num } from './_db.mjs';

const PAGE = join(DATA, 'page');
const AGG = join(DATA, 'agg');
const MAP = join(DATA, 'identity', 'crop-map.parquet');
const BEFORE_DAYS = 14;      // 颱風前的基準期
const AFTER_DAYS = 30;       // 觀察期
const RECOVER_RATIO = 1.1;   // 回到基準 ×1.1 以內算回穩
const AFFECTED_PCT = 20;     // 高峰要比颱風前貴兩成以上，才算「這次颱風真的有影響」
const MIN_SAMPLES = 3;       // 至少幾次「有影響」的颱風才給中位數
// 「現在還沒回穩」的量門檻：颱風前日均量低於這個數的作物不進榜。
// 沒有這道門檻，榜首會是最新一天全國只成交 5 公斤的菾菜（實測 2026-09-26）——
// 薄量作物的均價本來就會在幾倍之間亂跳，那不是颱風造成的。
const MIN_NOW_VOLUME = 1000;  // 公斤／日

const iso = (d) => d.toISOString().slice(0, 10);
const shift = (isoStr, days) => {
  const d = new Date(`${isoStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return iso(d);
};

async function main() {
  const con = await connect();
  await mkdir(PAGE, { recursive: true });

  const raw = JSON.parse(gunzipSync(await readFile(join(RAW, 'cwa-typhoon-warnings.json.gz'))).toString());
  // 只取有批發資料的年份（L1 從 2012 起）
  const typhoons = raw
    .filter((t) => t.sea_start_datetime >= '2012')
    .map((t) => ({
      id: t.id, name: t.cht_name, eng: t.eng_name,
      start: t.sea_start_datetime.slice(0, 10), end: t.sea_end_datetime.slice(0, 10),
      intensity: { s: '強烈', m: '中度', w: '輕度' }[t.max_intensity] ?? t.max_intensity,
      windSpeed: Number(t.max_wind_speed) || null,
      warnings: Number(t.warning_count) || null,
    }))
    .sort((a, b) => a.start.localeCompare(b.start));

  // 最近一次颱風與最新交易日：下面「現在還沒回穩」要用，所以在掃資料之前先問出來
  const [{ last_date }] = await q(con, `SELECT max(trans_date)::VARCHAR AS last_date FROM read_parquet('${join(AGG, 'plv3_day.parquet')}')`);
  const latest = [...typhoons].reverse().find((t) => t.end <= last_date) ?? null;
  const daysSince = latest ? Math.round((new Date(last_date) - new Date(latest.end)) / 86400_000) : null;

  // 每個颱風的觀察窗：前 14 天到後 30 天
  const windows = typhoons.map((t) => ({ ...t, from: shift(t.start, -BEFORE_DAYS), to: shift(t.end, AFTER_DAYS) }));
  // 窗尾要延到最新交易日：颱風結束超過 30 天時，否則「現在的價格」會落在窗外拿不到
  const minFrom = windows[0].from;
  const maxTo = [windows.at(-1).to, last_date].sort().at(-1);

  // 作物 × 日 的全國加權均價（只取有身分的，與聚合層同一套判準）
  await con.run(`CREATE TEMP TABLE daily AS
    SELECT make_date(CAST(substr(t."交易日期", 1, 3) AS INT) + 1911,
                     CAST(substr(t."交易日期", 5, 2) AS INT),
                     CAST(substr(t."交易日期", 8, 2) AS INT)) AS d,
           m.plv3_key, any_value(m.plv3) AS plv3, any_value(m.tc_type) AS tc_type,
           sum(t."平均價" * t."交易量") / nullif(sum(t."交易量"), 0) AS price,
           sum(t."交易量") AS volume
      FROM ${readL1()} t
      JOIN read_parquet('${MAP}') m
        ON m.crop_code = t."作物代號" AND m.tc_type = coalesce(t."種類代碼", '')
     WHERE t."作物代號" <> 'rest' AND t."交易量" > 0
       AND m.confidence >= 0.8 AND m.plv3_key IS NOT NULL
     GROUP BY 1, 2`);

  const rows = await q(con, `SELECT d::VARCHAR AS d, plv3_key, any_value(plv3) AS plv3, any_value(tc_type) AS tc_type,
           any_value(price) AS price, any_value(volume) AS volume
    FROM daily WHERE d BETWEEN DATE '${minFrom}' AND DATE '${maxTo}' GROUP BY 1, 2 ORDER BY 1`);

  const byCropDay = new Map();
  for (const r of rows) {
    if (!byCropDay.has(r.plv3_key)) byCropDay.set(r.plv3_key, { plv3: r.plv3, tc: r.tc_type, days: new Map(), vols: new Map() });
    byCropDay.get(r.plv3_key).days.set(r.d, Number(r.price));
    byCropDay.get(r.plv3_key).vols.set(r.d, Number(r.volume));
  }

  const avg = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
  const median = (xs) => {
    if (!xs.length) return null;
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  };

  const byCrop = {};
  const byTyphoon = {};
  const nowRows = [];
  for (const [key, c] of byCropDay) {
    if (c.tc === 'N06') continue;            // 花卉不在買菜情境
    const events = [];
    for (const w of windows) {
      const base = [];
      for (let i = 1; i <= BEFORE_DAYS; i++) {
        const v = c.days.get(shift(w.start, -i));
        if (v) base.push(v);
      }
      const baseline = avg(base);
      if (!baseline || base.length < 5) continue;   // 颱風前資料太少，這次不採計

      // 先找高峰。⚠ 不能一邊掃一邊找回穩：颱風後漲勢通常延後幾天才到頂，
      // 從結束當天就找「低於基準」會在漲上去之前就命中，把回穩天數嚴重低估
      // （實測會得到「油菜漲 128% 但 2 天回穩」這種不合常識的結果）。
      let peak = null, peakDay = null;
      for (let i = 0; i <= AFTER_DAYS; i++) {
        const v = c.days.get(shift(w.end, i));
        if (v != null && (peak == null || v > peak)) { peak = v; peakDay = i; }
      }
      if (peak == null) continue;
      const peakPct = +(((peak - baseline) / baseline) * 100).toFixed(1);

      // 回穩只從高峰之後算起
      let recovery = null;
      for (let i = peakDay + 1; i <= AFTER_DAYS; i++) {
        const v = c.days.get(shift(w.end, i));
        if (v != null && v <= baseline * RECOVER_RATIO) { recovery = i; break; }
      }
      events.push({
        id: w.id, name: w.name, start: w.start, end: w.end, intensity: w.intensity,
        baseline: +baseline.toFixed(2),
        peak: +peak.toFixed(2),
        peakPct, peakDay,
        recoveryDays: recovery,
        // 有明顯上漲才算「受颱風影響」；沒漲的颱風不該拿來算回穩天數
        affected: peakPct >= AFFECTED_PCT,
      });
    }
    // ── 現在的狀態：以最近一次颱風為基準，這個作物現在比颱風前貴多少
    // 用的是「當下實際價格」，不是歷次颱風的中位數——使用者問的是現在該不該買。
    // 這段刻意放在 MIN_SAMPLES 過濾之前：某個作物就算歷史樣本不足以給中位數，
    // 現在貴不貴仍然答得出來，沒理由把它從清單上抹掉。
    if (latest) {
      const ev = events.find((e) => e.id === latest.id);
      if (ev) {
        const vs = [];
        for (let i = 1; i <= BEFORE_DAYS; i++) {
          const v = c.vols.get(shift(latest.start, -i));
          if (v) vs.push(v);
        }
        const preVolume = avg(vs);
        // 颱風結束之後最新的一天（不是資料集最後一天：這個作物可能已經沒量了）
        let nowDate = null, nowPrice = null;
        for (const [d, v] of c.days) {
          if (d > latest.end && v != null && (nowDate == null || d > nowDate)) { nowDate = d; nowPrice = v; }
        }
        if (nowPrice != null && preVolume != null && preVolume >= MIN_NOW_VOLUME) {
          nowRows.push({
            key, plv3: c.plv3, tcType: c.tc,
            baseline: +ev.baseline.toFixed(2),
            price: +nowPrice.toFixed(2),
            pct: +(((nowPrice - ev.baseline) / ev.baseline) * 100).toFixed(1),
            date: nowDate,
            preVolume: Math.round(preVolume),
            // 回穩的定義跟歷史統計同一把尺（基準 ×1.1），不要兩處各用一套
            recovered: nowPrice <= ev.baseline * RECOVER_RATIO,
          });
        }
      }
    }

    // 只拿「真的有漲」的颱風做結論。把沒受影響的也算進去，中位數會被拉到 1–2 天。
    const affected = events.filter((e) => e.affected);
    if (affected.length < MIN_SAMPLES) continue;
    const rec = affected.map((e) => e.recoveryDays).filter((x) => x != null);
    // 常態日均量：/typhoon/ 的「颱風前先買什麼」要用它把冷門品項擋掉。
    // 沒有這道門檻，榜首會是晚香玉筍、蠔菇、四棱豆這種買菜的人不會買的東西（實測）。
    const volumeMedian = median([...c.vols.values()].filter((v) => v > 0));
    byCrop[key] = {
      plv3: c.plv3, tcType: c.tc,
      volumeMedian: volumeMedian == null ? null : Math.round(volumeMedian),
      samples: events.length,
      affectedCount: affected.length,
      affectedRate: Math.round((affected.length / events.length) * 100),
      medianPeakPct: median(affected.map((e) => e.peakPct)),
      medianRecoveryDays: median(rec),
      neverRecovered: affected.length - rec.length,
      events: events.slice(-6),          // 只留最近 6 次供頁面顯示
    };

    // 橫向再切一次：同一次颱風掃過所有作物的樣子。/typhoon/ 頁要回答
    // 「哪一次最兇」，而 byCrop 的 events 只留最近 6 次，頁面自己組不出來。
    // 只採計進得了 byCrop 的作物（樣本 >= MIN_SAMPLES），數字才跟 byCrop 對得上。
    for (const e of events) {
      const t = (byTyphoon[e.id] ??= { cropsWithData: 0, affectedCrops: 0, peakPcts: [], recoveryDays: [], neverRecovered: 0, worst: [] });
      t.cropsWithData++;
      if (!e.affected) continue;
      t.affectedCrops++;
      t.peakPcts.push(e.peakPct);
      if (e.recoveryDays != null) t.recoveryDays.push(e.recoveryDays); else t.neverRecovered++;
      t.worst.push({ plv3: c.plv3, tcType: c.tc, key, peakPct: e.peakPct, recoveryDays: e.recoveryDays });
    }
  }

  // 每一次颱風的影響：掛回 typhoons 自己身上，頁面就不必再跑 167×71 的迴圈
  const withImpact = typhoons.map((t) => {
    const a = byTyphoon[t.id];
    if (!a || !a.affectedCrops) return { ...t, impact: null };
    return {
      ...t,
      impact: {
        cropsWithData: a.cropsWithData,
        affectedCrops: a.affectedCrops,
        affectedRate: Math.round((a.affectedCrops / a.cropsWithData) * 100),
        medianPeakPct: median(a.peakPcts),
        medianRecoveryDays: median(a.recoveryDays),
        neverRecovered: a.neverRecovered,
        worst: a.worst.sort((x, y) => y.peakPct - x.peakPct).slice(0, 5),
      },
    };
  });

  // /typhoon/ 頁的開場數字。這裡算好，頁面不自己統計（同一個數字兩處算＝兩處會不一樣）
  const cropList = Object.values(byCrop);
  const summary = {
    crops: cropList.length,
    typhoonsWithImpact: withImpact.filter((t) => t.impact).length,
    medianRecoveryDays: median(cropList.map((c) => c.medianRecoveryDays).filter((x) => x != null)),
    medianPeakPct: median(cropList.map((c) => c.medianPeakPct)),
    neverRecoveredCrops: cropList.filter((c) => c.neverRecovered > 0).length,
  };

  const out = {
    builtAt: new Date().toISOString(), lastDate: last_date,
    definition: { beforeDays: BEFORE_DAYS, afterDays: AFTER_DAYS, recoverRatio: RECOVER_RATIO, minSamples: MIN_SAMPLES },
    latest: latest && { ...latest, daysSince },
    summary,
    // 現在的狀態：依「比颱風前貴多少」排序，回穩的排在後面
    now: latest && {
      typhoonId: latest.id, name: latest.name, start: latest.start, end: latest.end, daysSince,
      minVolume: MIN_NOW_VOLUME,
      crops: nowRows.sort((a, b) => b.pct - a.pct),
      notRecovered: nowRows.filter((r) => !r.recovered).length,
      recovered: nowRows.filter((r) => r.recovered).length,
    },
    typhoons: withImpact,
    byCrop,
  };
  await writeFile(join(PAGE, 'typhoon.json'), JSON.stringify(out));

  const withData = Object.values(byCrop);
  console.error(`颱風 ${typhoons.length} 次（2012 起）；有足夠樣本的作物 ${withData.length} 個`);
  console.error(`最近一次：${latest ? `${latest.name}（${latest.start}~${latest.end}，${latest.intensity}），距最新交易日 ${daysSince} 天` : '無'}`);
  const sorted = withData.filter((c) => c.medianRecoveryDays != null).sort((a, b) => b.medianPeakPct - a.medianPeakPct);
  console.error(`\n颱風後漲最兇的 12 個（只計有影響的那幾次）：`);
  for (const c of sorted.slice(0, 12)) {
    console.error(`  ${c.plv3.padEnd(8)} 漲 ${String(c.medianPeakPct).padStart(6)}%  ${String(c.medianRecoveryDays).padStart(2)} 天回穩  ${c.affectedCount}/${c.samples} 次颱風有影響（${c.affectedRate}%）`);
  }
  const noRecover = withData.filter((c) => c.neverRecovered > 0).length;
  console.error(`\n有「30 天內回不去」紀錄的作物：${noRecover} 個`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
