// 頁面層：data/agg → data/page/**.json，一頁一檔，Astro build 只做讀檔。
//
// 服務對象是「買菜的人」，所以這一層要把資料翻譯成他懂的東西：
//   官方名 → 俗名（甘藍 → 高麗菜）        overrides/crop-common-name.json
//   批發價 → 實際攤價（有台中實測才給）    overrides/crop-retail-map.json
//   現在當季嗎                            ingest/raw/peak-season-origin
//   太貴的話改買什麼（同官方中類）         plv3_key 第 4–5 碼就是 PLV2
//
// 主數字是「比常年便宜/貴幾 %」而不是絕對價格：實測零售是批發的 2.1 倍但範圍 1.01–3.11，
// 用單一倍數推估一定會錯；相對變化則在批發與零售之間可傳遞。
//
// 用法：node transform/emit-page.mjs [--report]
import { mkdir, writeFile, rm, readFile, readdir } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect, q, one, DATA, RAW, ROOT, num } from './_db.mjs';

const AGG = join(DATA, 'agg');
const PAGE = join(DATA, 'page');
const OVERRIDES = join(ROOT, 'overrides');
const rd = (v, p = 2) => (v == null ? null : +Number(v).toFixed(p));
const loadGz = async (p) => JSON.parse(gunzipSync(await readFile(p)).toString());
const loadJson = async (p, fb) => JSON.parse(await readFile(p, 'utf-8').catch(() => JSON.stringify(fb)));
// CROP_UID → 官方作物名（PLV3）。產地價只有品名沒有代碼，要靠這個落到站上的作物。
const uidName = (unified, uid) => (uid ? unified.find((u) => u.CROP_UID === uid)?.PLV3_NAME || null : null);

const INDEX_IN = { days90: 30, volume90: 10_000 };
const INDEX_OUT = { days90: 15, volume90: 3_000 };
const MIN_VOL = 5_000;        // 進漲跌榜的最低旬交易量
const MIN_YEARS = 3;          // 至少要有幾年同旬基準
const ALT_MAX_PCT = 20;       // 替代品自己不能貴超過 20%
const CATTY = 0.6;            // 1 台斤 = 0.6 公斤

const qualityScore = (days90, volume90, years) =>
  rd(Math.min(10, days90 / 9 + Math.log10(Math.max(volume90, 1)) + Math.min(years, 14) / 3), 2);

async function main() {
  const report = process.argv.includes('--report');
  const con = await connect();

  // ── 人工資產與參考資料
  const commonName = (await loadJson(join(OVERRIDES, 'crop-common-name.json'), { names: {} })).names ?? {};
  const retailMap = (await loadJson(join(OVERRIDES, 'crop-retail-map.json'), { columns: {} })).columns ?? {};
  const unified = await loadGz(join(RAW, 'crop-unified.json.gz'));
  const season = await loadGz(join(RAW, 'peak-season-origin.json.gz'));
  // 產地價只有品名沒有代碼，要靠官方對應表的 SAP（產地價格查詢系統）落到作物
  const crosswalk = await loadGz(join(RAW, 'crop-crosswalk.json.gz'));

  // plv3_key（CROP_UID 前 11 碼）→ 大類/中類名稱。PLV2 在第 4–5 碼，不必改 identify 就能拿到。
  const taxo = new Map();
  for (const u of unified) {
    const key = u.CROP_UID.slice(0, 11);
    if (!taxo.has(key)) taxo.set(key, { plv1: u.PLV1_NAME, plv2: u.PLV2_NAME, plv3: u.PLV3_NAME });
  }

  const nameOf = (official) => commonName[official]?.common ?? official;
  const aliasOf = (official) => commonName[official]?.also ?? [];

  // ── 產地價：只顯示「對得起來」的品項。
  //
  // 產地價查的是特定品種／等級，批發價是全品種加權，多數品項相除會得到荒謬的結果
  // （文旦產地 99 → 批發 21，農民賣得比批發貴）。實測 65 個可比品項有 21 個倒掛。
  // 判準見 transform/STORAGE.md §10：同一旬、倍數 1.0–4.0、一個作物只能對一個產地品名。
  const originNameMap = (await loadJson(join(OVERRIDES, 'crop-origin-name-map.json'), { names: {} })).names ?? {};
  const sapName = new Map();
  for (const r of crosswalk) if (r.SRC_SYS_ID === 'SAP') sapName.set(r.SRC_CNAME.trim(), r.CROP_UID);
  const originFile = join(DATA, 'parquet', 'origin_price.parquet');
  const RATIO_MIN = 1.0, RATIO_MAX = 4.0;

  let originXun = null;
  const originByCrop = new Map();
  try {
    const OP = `read_parquet('${originFile}')`;
    originXun = await one(con, `SELECT year, month, xun FROM ${OP}
      WHERE period_type = 'xun' AND is_national AND price > 0
      ORDER BY year DESC, month DESC, xun DESC LIMIT 1`);
    const rows = await q(con, `SELECT product_name, price FROM ${OP}
      WHERE period_type = 'xun' AND is_national AND price > 0
        AND year = ${originXun.year} AND month = ${originXun.month} AND xun = ${originXun.xun}`);
    const counties = await q(con, `SELECT product_name, county, round(median(price), 1) AS price FROM ${OP}
      WHERE period_type = 'xun' AND NOT is_national AND price > 0 AND county IS NOT NULL
        AND year = ${originXun.year} AND month = ${originXun.month} AND xun = ${originXun.xun}
      GROUP BY 1, 2`);
    const byCounty = new Map();
    for (const r of counties) {
      if (!byCounty.has(r.product_name)) byCounty.set(r.product_name, []);
      byCounty.get(r.product_name).push({ county: r.county, price: rd(r.price, 1) });
    }
    // 產地品名 → 官方作物名：先查人工表，再查官方 SAP 對應
    const hits = new Map();
    for (const r of rows) {
      const manual = originNameMap[r.product_name];
      const official = manual !== undefined ? manual : uidName(unified, sapName.get(r.product_name));
      if (!official) continue;
      if (!hits.has(official)) hits.set(official, []);
      hits.get(official).push({ productName: r.product_name, price: rd(r.price, 1), counties: (byCounty.get(r.product_name) ?? []).sort((a, b) => a.price - b.price).slice(0, 4) });
    }
    for (const [official, list] of hits) {
      // 一個作物對到多個產地品名（番茄的黑柿與牛蕃茄）→ 無法判斷哪個代表，不顯示
      originByCrop.set(official, list.length === 1 ? list[0] : { ambiguous: list.map((x) => x.productName) });
    }
  } catch (e) {
    // 只有「檔案還沒產生」才是可略過的情況；其他錯誤照實拋出。
    // （踩過：程式碼的 ReferenceError 被這裡吞成「先跑 origin-price.mjs」，害我查錯方向）
    const msg = e.message.split('\n')[0];
    if (!/No files found|IO Error|does not exist/i.test(msg)) throw e;
    console.error(`（略過產地價：找不到 ${originFile}——先跑 transform/origin-price.mjs）`);
  }

  // ── 台中零售：近 30 個訪價日的中位數（元/台斤）。多欄對同一作物時取有值比例最高的欄。
  const retailFiles = (await readdir(join(RAW, 'taichung-retail')).catch(() => [])).filter((f) => f.endsWith('.json.gz')).sort();
  const retailByCrop = new Map();
  if (retailFiles.length) {
    const rows = await loadGz(join(RAW, 'taichung-retail', retailFiles.at(-1)));
    const days = [...new Set(rows.map((r) => r['訪價日期']))].sort().slice(-30);
    const recent = rows.filter((r) => days.includes(r['訪價日期']));
    // 多個欄位對到同一作物（鳳梨 3 個品種、梨 3 種、寬皮柑 4 種）時，把所有欄位的訪價
    // 合在一起算中位數。只取覆蓋率最高的單一欄會白丟樣本：鳳梨最高那欄只有 38% 的訪價日
    // 有值，三欄合起來才涵蓋大部分日子。品種間有價差，但中位數本來就是要抓「市場上這類
    // 東西大概多少錢」，不是某一品種的牌價。
    const byCrop = new Map();
    for (const [col, crop] of Object.entries(retailMap)) {
      if (!crop) continue;
      if (!byCrop.has(crop)) byCrop.set(crop, []);
      byCrop.get(crop).push(col);
    }
    for (const [crop, cols] of byCrop) {
      const vs = recent.flatMap((r) => cols.map((c) => Number(r[c]))).filter((v) => v > 0).sort((a, b) => a - b);
      if (!vs.length) continue;
      const median = vs[Math.floor(vs.length / 2)];
      retailByCrop.set(crop, {
        perCatty: rd(median, 1), perKg: rd(median / CATTY, 1),
        cover: rd(vs.length / (recent.length * cols.length), 2),
        columns: cols, samples: vs.length, days: days.length,
      });
    }
  }

  // ── 當季：本月盛產且站上有資料
  const [{ last_date }] = await q(con, `SELECT max(trans_date)::VARCHAR AS last_date FROM read_parquet('${join(AGG, 'plv3_day.parquet')}')`);
  const thisMonth = Number(last_date.slice(5, 7));
  const seasonalNames = new Set(
    season.filter((s) => Number((s.month ?? '').trim()) === thisMonth).map((s) => s.crop),
  );
  const seasonOrigin = new Map();
  for (const s of season) {
    if (Number((s.month ?? '').trim()) !== thisMonth) continue;
    const a = seasonOrigin.get(s.crop) ?? new Set();
    if (s.county) a.add(s.county);
    seasonOrigin.set(s.crop, a);
  }
  const since90 = new Date(new Date(last_date).getTime() - 89 * 86400_000).toISOString().slice(0, 10);

  // ── 聚合資料
  const monthly = await q(con, `SELECT year, month, tc_type, plv3_key, plv3, market_code, wavg_price, volume, n_days
    FROM read_parquet('${join(AGG, 'plv3_month.parquet')}') ORDER BY year, month`);
  const daily90 = await q(con, `SELECT trans_date::VARCHAR AS d, tc_type, plv3_key, plv3, market_code, wavg_price, volume, min_price, max_price
    FROM read_parquet('${join(AGG, 'plv3_day.parquet')}') WHERE trans_date >= DATE '${since90}' ORDER BY trans_date`);
  const marketDay90 = await q(con, `SELECT trans_date::VARCHAR AS d, tc_type, market_code, volume, wavg_price, n_codes, n_crops
    FROM read_parquet('${join(AGG, 'market_day.parquet')}') WHERE trans_date >= DATE '${since90}' ORDER BY trans_date`);
  const xun = await q(con, `SELECT year, month, xun, tc_type, plv3_key, plv3, market_code, wavg_price, volume
    FROM read_parquet('${join(AGG, 'plv3_xun.parquet')}') WHERE market_code = 'ALL'`);
  const marketNames = new Map(
    (await q(con, `SELECT DISTINCT "市場代號" AS code, "市場名稱" AS name, coalesce("種類代碼", '') AS tc
       FROM read_parquet('${join(DATA, 'parquet', 'farm_trans')}/year=${last_date.slice(0, 4)}/*.parquet', union_by_name=true)`))
      .map((r) => [`${r.tc}|${r.code}`, r.name]));

  // ── 作物
  const crops = new Map();
  for (const r of monthly) {
    if (!r.plv3_key || !(r.plv3 ?? '').trim()) continue;
    const key = `${r.tc_type}|${r.plv3_key}`;
    if (!crops.has(key)) {
      const t = taxo.get(r.plv3_key) ?? {};
      crops.set(key, {
        tc_type: r.tc_type, plv3_key: r.plv3_key, official: r.plv3,
        name: nameOf(r.plv3), also: aliasOf(r.plv3),
        plv1: t.plv1 ?? null, plv2: t.plv2 ?? null,
        retail: null,   // 官方名會對到多個作物實體，組完後才掛（見下方 attachRetail）
        // 當季是「這個月盛產、可以買」的意思，花卉不在這個語境裡（百合、蝴蝶蘭曾被標成當季）
        seasonal: r.tc_type !== 'N06' && seasonalNames.has(r.plv3),
        seasonCounties: [...(seasonOrigin.get(r.plv3) ?? [])],
        national: [], byMarket: new Map(),
      });
    }
    const c = crops.get(key);
    const point = { ym: `${num(r.year)}-${String(num(r.month)).padStart(2, '0')}`, price: rd(r.wavg_price), volume: rd(num(r.volume), 0), days: num(r.n_days) };
    if (r.market_code === 'ALL') c.national.push(point);
    else {
      if (!c.byMarket.has(r.market_code)) c.byMarket.set(r.market_code, []);
      c.byMarket.get(r.market_code).push(point);
    }
  }
  for (const r of daily90) {
    const c = crops.get(`${r.tc_type}|${r.plv3_key}`);
    if (!c) continue;
    (c.daily ??= []).push({ d: r.d, market: r.market_code, price: rd(r.wavg_price), volume: rd(num(r.volume), 0), min: rd(r.min_price), max: rd(r.max_price) });
  }

  // ── 零售價回掛：一個官方名可能對到多個作物實體
  // 「紅龍果」就有三筆：N06 花卉一筆、N05 兩筆（其中一筆近 90 天只交易 6 天、批發 5 元）。
  // 照官方名一律掛的話，三筆都拿到同一個零售價，於是算出「零售是批發的 0.59 倍」和「21 倍」。
  // 規則：花卉不掛（零售表是蔬果攤價），其餘只掛給近 90 天交易日最多的那一筆。
  // 代表實體：同一個官方名底下，近 90 天交易日最多、且不是花卉的那一筆。
  // 零售價與產地價都只掛給它——這兩份資料的 key 都是官方名，照名字一律掛就會出事。
  const primarySlugByOfficial = new Map();
  {
    const best = new Map();
    for (const c of crops.values()) {
      if (c.tc_type === 'N06') continue;
      const days = new Set((c.daily ?? []).map((x) => x.d)).size;
      const prev = best.get(c.official);
      if (!prev || days > prev.days) best.set(c.official, { crop: c, days });
    }
    for (const [official, { crop }] of best) {
      primarySlugByOfficial.set(official, `${crop.tc_type.toLowerCase()}-${crop.plv3_key}`);
      if (retailByCrop.has(official)) crop.retail = retailByCrop.get(official);
    }
  }

  // ── 漲跌：最近一個「已結束」的旬 vs 近三年同旬
  const lastCompleteXun = (iso) => {
    const d = new Date(iso);
    let y = d.getUTCFullYear(), m = d.getUTCMonth() + 1;
    const day = d.getUTCDate();
    let x = day <= 10 ? 1 : day <= 20 ? 2 : 3;
    const endDay = (yy, mm, xx) => (xx === 1 ? 10 : xx === 2 ? 20 : new Date(Date.UTC(yy, mm, 0)).getUTCDate());
    if (day < endDay(y, m, x)) { x -= 1; if (x === 0) { x = 3; m -= 1; if (m === 0) { m = 12; y -= 1; } } }
    return { year: y, month: m, xun: x };
  };
  const target = lastCompleteXun(last_date);
  const xunLabel = `${target.year}-${String(target.month).padStart(2, '0')} ${['上', '中', '下'][target.xun - 1]}旬`;

  const changes = [];
  for (const cur of xun) {
    if (num(cur.year) !== target.year || num(cur.month) !== target.month || num(cur.xun) !== target.xun) continue;
    if (!(num(cur.volume) >= MIN_VOL) || !cur.wavg_price) continue;
    const hist = xun.filter((r) => r.plv3_key === cur.plv3_key && r.tc_type === cur.tc_type
      && num(r.month) === target.month && num(r.xun) === target.xun
      && num(r.year) < target.year && num(r.year) >= target.year - 3
      && num(r.volume) >= MIN_VOL && r.wavg_price);
    if (hist.length < MIN_YEARS) continue;
    const base = hist.reduce((s, r) => s + Number(r.wavg_price), 0) / hist.length;
    if (!base) continue;
    const c = crops.get(`${cur.tc_type}|${cur.plv3_key}`);
    if (!c) continue;
    changes.push({
      slug: `${cur.tc_type.toLowerCase()}-${cur.plv3_key}`,
      name: c.name, official: c.official, also: c.also, tcType: cur.tc_type,
      plv2: c.plv2, seasonal: c.seasonal, seasonCounties: c.seasonCounties,
      retail: c.retail, wholesale: rd(cur.wavg_price),
      baseline3y: rd(base), changePct: rd((Number(cur.wavg_price) - base) / base * 100, 1),
      volume: rd(num(cur.volume), 0), baseYears: hist.length,
    });
  }
  changes.sort((a, b) => a.changePct - b.changePct);

  // 替代品：同官方中類、同期也有量、而且自己沒有變貴。只給 1 個——買菜的人要的是一個明確建議。
  //
  // 曾經試過「已推薦過的降權」來避免版面重複，結果是把最划算的讓給了排前面的品項，
  // 後面的只能拿到「改買韭菜 +13%」這種還在漲的替代品。使用者價值優先於版面多樣性：
  // 同一個高麗菜被推薦三次沒關係，那本來就是現在最划算的葉菜。
  const withAlt = (item) => {
    if (!item.plv2) return [];
    return changes
      .filter((o) => o.plv2 === item.plv2 && o.slug !== item.slug && o.changePct <= ALT_MAX_PCT && o.tcType === item.tcType)
      .sort((a, b) => a.changePct - b.changePct)
      .slice(0, 1)
      .map((o) => ({ slug: o.slug, name: o.name, changePct: o.changePct, retail: o.retail, wholesale: o.wholesale }));
  };

  // 首頁只給「菜」——花卉不屬於買菜情境，但仍保留在 /cheap 的完整榜單
  const food = changes.filter((c) => c.tcType !== 'N06');
  const home = {
    lastDate: last_date,
    targetXun: xunLabel,
    basis: `最近完整旬（${xunLabel}）全國加權均價 vs 近三年同旬平均`,
    filters: { minVolumeKg: MIN_VOL, minBaseYears: MIN_YEARS },
    cheap: food.slice(0, 6),
    pricey: food.slice(-6).reverse().map((c) => ({ ...c, alternatives: withAlt(c) })),
    seasonalNow: [...crops.values()]
      .filter((c) => c.seasonal && c.tc_type !== 'N06' && (c.daily?.length ?? 0) > 0)
      .map((c) => ({ slug: `${c.tc_type.toLowerCase()}-${c.plv3_key}`, name: c.name, counties: c.seasonCounties.slice(0, 3) }))
      .slice(0, 12),
    month: thisMonth,
  };

  // ── 寫檔
  const pageState = [];
  let written = 0;
  if (!report) {
    await rm(PAGE, { recursive: true, force: true });
    for (const d of ['crop', 'market', 'crop-market']) await mkdir(join(PAGE, d), { recursive: true });
  }

  const changeBySlug = new Map(changes.map((c) => [c.slug, c]));
  const cropIndex = [];
  for (const [, c] of crops) {
    const nat = c.national;
    const recent = nat.at(-1);
    const sameMonthLastYear = nat.find((p) => p.ym === `${Number(recent?.ym.slice(0, 4)) - 1}-${recent?.ym.slice(5)}`);
    const days90 = new Set((c.daily ?? []).map((x) => x.d)).size;
    const volume90 = (c.daily ?? []).reduce((s, x) => s + (x.volume ?? 0), 0);
    const years = new Set(nat.map((p) => p.ym.slice(0, 4))).size;
    const score = qualityScore(days90, volume90, years);
    const indexable = days90 >= INDEX_IN.days90 && volume90 >= INDEX_IN.volume90;
    const slug = `${c.tc_type.toLowerCase()}-${c.plv3_key}`;
    const change = changeBySlug.get(slug) ?? null;

    // 價格鏈：產地 → 批發 → 零售。批發要取「產地那一旬」的價，不能用最新月（產地晚約一個月）。
    let chain = null;
    // 同一官方名只有代表實體能組價格鏈：否則「紅龍果」的花卉筆和只交易 6 天的那筆
    // 都會拿到同一份產地價，憑空生出一條鏈
    const og = primarySlugByOfficial.get(c.official) === slug ? originByCrop.get(c.official) : null;
    if (og && originXun) {
      const xr = xun.find((r) => r.plv3_key === c.plv3_key && r.tc_type === c.tc_type && r.market_code === 'ALL'
        && num(r.year) === num(originXun.year) && num(r.month) === num(originXun.month) && num(r.xun) === num(originXun.xun));
      const wholesale = xr?.wavg_price ? rd(xr.wavg_price) : null;
      const label = `${num(originXun.year)}-${String(num(originXun.month)).padStart(2, '0')} ${['上', '中', '下'][num(originXun.xun) - 1]}旬`;
      if (og.ambiguous) {
        chain = { comparable: false, reason: 'ambiguous-origin-item', detail: og.ambiguous, xun: label };
      } else if (wholesale && og.price) {
        const ratio = +(wholesale / og.price).toFixed(2);
        chain = ratio >= RATIO_MIN && ratio <= RATIO_MAX
          ? { comparable: true, xun: label, origin: og.price, originItem: og.productName, originCounties: og.counties,
              wholesale, retailPerKg: c.retail?.perKg ?? null,
              originToWholesale: ratio,
              wholesaleToRetail: c.retail?.perKg ? +(c.retail.perKg / wholesale).toFixed(2) : null,
              // 農民佔比會被當結論讀，所以要讓前端知道它建立在多少訪價上：
              // 過季水果（柿子 cover 0.13）的零售中位數只來自產季那幾週，不能跟全年天天有價的葉菜等量齊觀
              retailCover: c.retail?.cover ?? null,
              retailSamples: c.retail?.samples ?? null,
              farmerShare: c.retail?.perKg ? Math.round((og.price / c.retail.perKg) * 100) : null }
          : { comparable: false, reason: ratio < RATIO_MIN ? 'wholesale-below-origin' : 'ratio-too-high',
              detail: { origin: og.price, wholesale, ratio }, xun: label };
      }
    }

    const doc = {
      kind: 'crop', slug, tcType: c.tc_type, plv3Key: c.plv3_key,
      name: c.name, official: c.official, also: c.also,
      plv1: c.plv1, plv2: c.plv2, chain,
      retail: c.retail, seasonal: c.seasonal, seasonCounties: c.seasonCounties,
      change: change && { changePct: change.changePct, baseline3y: change.baseline3y, xun: xunLabel, volume: change.volume },
      alternatives: change ? withAlt(change) : [],
      lastDate: last_date,
      latest: recent ? { ym: recent.ym, price: recent.price, volume: recent.volume } : null,
      yoy: recent && sameMonthLastYear?.price ? { lastYearPrice: sameMonthLastYear.price, changePct: rd((recent.price - sameMonthLastYear.price) / sameMonthLastYear.price * 100, 1) } : null,
      monthly: nat,
      markets: [...c.byMarket].map(([code, series]) => ({
        code, name: marketNames.get(`${c.tc_type}|${code}`) ?? null,
        latest: series.at(-1) ?? null, months: series.length,
      })).sort((a, b) => (b.latest?.volume ?? 0) - (a.latest?.volume ?? 0)),
      daily90: c.daily ?? [],
      quality: { days90, volume90: rd(volume90, 0), years, score, indexable },
    };
    if (!report) { await writeFile(join(PAGE, 'crop', `${slug}.json`), JSON.stringify(doc)); written++; }
    pageState.push({ path: `/crop/${slug}`, qualityScore: score, indexable: indexable ? 1 : 0, days90, computedAt: last_date });
    cropIndex.push({ slug, tcType: c.tc_type, plv3Key: c.plv3_key, name: c.name, official: c.official, seasonal: c.seasonal, changePct: change?.changePct ?? null, indexable });

    for (const [code, series] of c.byMarket) {
      const d90 = (c.daily ?? []).filter((x) => x.market === code);
      const v90 = d90.reduce((s, x) => s + (x.volume ?? 0), 0);
      const dd = new Set(d90.map((x) => x.d)).size;
      const cmIndexable = dd >= INDEX_IN.days90 && v90 >= INDEX_IN.volume90;
      const cmSlug = `${slug}-${code}`;
      if (!report) {
        await writeFile(join(PAGE, 'crop-market', `${cmSlug}.json`), JSON.stringify({
          kind: 'crop-market', slug: cmSlug, tcType: c.tc_type, plv3Key: c.plv3_key,
          name: c.name, official: c.official,
          marketCode: code, marketName: marketNames.get(`${c.tc_type}|${code}`) ?? null,
          lastDate: last_date, monthly: series, daily90: d90,
          quality: { days90: dd, volume90: rd(v90, 0), score: qualityScore(dd, v90, new Set(series.map((p) => p.ym.slice(0, 4))).size), indexable: cmIndexable },
        }));
        written++;
      }
      pageState.push({ path: `/crop/${slug}/${code}`, qualityScore: qualityScore(dd, v90, 1), indexable: cmIndexable ? 1 : 0, days90: dd, computedAt: last_date });
    }
  }

  // ── 市場
  const markets = new Map();
  for (const r of marketDay90) {
    const key = `${r.tc_type}|${r.market_code}`;
    if (!markets.has(key)) markets.set(key, { tc_type: r.tc_type, code: r.market_code, name: marketNames.get(key) ?? null, daily: [] });
    markets.get(key).daily.push({ d: r.d, volume: rd(num(r.volume), 0), price: rd(r.wavg_price), codes: num(r.n_codes), crops: num(r.n_crops) });
  }
  // 市場 × 作物的漲跌：這個市場現在什麼最便宜。
  // 門檻比全國榜寬鬆（單一市場的量本來就小），但仍要求近三年同旬都有量。
  const MKT_MIN_VOL = 1_000;
  // ⚠ 上面的 xun 是用 WHERE market_code='ALL' 查的（全國榜與價格鏈用），裡面沒有各市場的列。
  // 各市場要另外查，而且只取比較會用到的那幾旬，不要把百萬列全載進記憶體。
  const xunMkt = await q(con, `SELECT year, month, xun, tc_type, plv3_key, market_code, wavg_price, volume
    FROM read_parquet('${join(AGG, 'plv3_xun.parquet')}')
    WHERE market_code <> 'ALL' AND month = ${target.month} AND xun = ${target.xun}
      AND year BETWEEN ${target.year - 3} AND ${target.year}`);

  const mktChange = new Map();   // "tc|market" → [{ plv3Key, name, changePct, price, volume }]
  for (const cur of xunMkt) {
    if (num(cur.year) !== target.year || num(cur.month) !== target.month || num(cur.xun) !== target.xun) continue;
    if (!(num(cur.volume) >= MKT_MIN_VOL) || !cur.wavg_price) continue;
    const c = crops.get(`${cur.tc_type}|${cur.plv3_key}`);
    if (!c) continue;
    const hist = xunMkt.filter((r) => r.plv3_key === cur.plv3_key && r.tc_type === cur.tc_type && r.market_code === cur.market_code
      && num(r.year) < target.year && num(r.volume) >= MKT_MIN_VOL && r.wavg_price);
    if (hist.length < MIN_YEARS) continue;
    const base = hist.reduce((s, r) => s + Number(r.wavg_price), 0) / hist.length;
    if (!base) continue;
    const key = `${cur.tc_type}|${cur.market_code}`;
    if (!mktChange.has(key)) mktChange.set(key, []);
    mktChange.get(key).push({
      slug: `${cur.tc_type.toLowerCase()}-${cur.plv3_key}`,
      plv3Key: cur.plv3_key, name: c.name, seasonal: c.seasonal,
      price: rd(cur.wavg_price), baseline3y: rd(base),
      changePct: rd((Number(cur.wavg_price) - base) / base * 100, 1),
      volume: rd(num(cur.volume), 0),
    });
  }
  for (const list of mktChange.values()) list.sort((a, b) => a.changePct - b.changePct);

  const marketIndex = [];
  for (const [, m] of markets) {
    const top = [...crops.values()]
      .filter((c) => c.tc_type === m.tc_type)
      .map((c) => ({ name: c.name, official: c.official, plv3Key: c.plv3_key, tcType: c.tc_type, volume: (c.daily ?? []).filter((x) => x.market === m.code).reduce((s, x) => s + (x.volume ?? 0), 0) }))
      .filter((x) => x.volume > 0)
      .sort((a, b) => b.volume - a.volume).slice(0, 20);
    const changes = mktChange.get(`${m.tc_type}|${m.code}`) ?? [];
    const days90 = m.daily.length;
    const volume90 = m.daily.reduce((s, x) => s + (x.volume ?? 0), 0);
    const score = qualityScore(days90, volume90, 14);
    const indexable = days90 >= INDEX_IN.days90 && volume90 >= INDEX_IN.volume90;
    const slug = `${m.tc_type.toLowerCase()}-${m.code}`;
    if (!report) {
      await writeFile(join(PAGE, 'market', `${slug}.json`), JSON.stringify({
        kind: 'market', slug, ...m, lastDate: last_date,
        topCrops: top,
        // 這個市場現在什麼最便宜／最貴（跟該市場自己的近三年同旬比）
        xun: xunLabel,
        cheapest: changes.slice(0, 10),
        priciest: changes.slice(-10).reverse(),
        changeCount: changes.length,
        quality: { days90, volume90: rd(volume90, 0), score, indexable },
      }));
      written++;
    }
    pageState.push({ path: `/market/${slug}`, qualityScore: score, indexable: indexable ? 1 : 0, days90, computedAt: last_date });
    marketIndex.push({ slug, tcType: m.tc_type, code: m.code, name: m.name, days90, indexable });
  }

  // ── 買菜清單的資料來源
  // 靜態站沒有後端，清單是前端用 localStorage 記的，所以要把「所有品項現在貴不貴」
  // 整包給前端自己查。只放清單需要的欄位，173 個品項約 20 KB。

  // 官方中類（PLV2）太細也太書面——漿果類、仁果類、鱗莖類不是買菜的人腦中的分類。
  // 併成選單用的日常分類，陣列順序就是選單的分組順序，最後兩條是通吃，不會有漏網的。
  const CAT = [
    ['葉菜', (a, b, tc) => tc === 'N04' && b === '葉菜類'],
    ['瓜類', (a, b, tc) => tc === 'N04' && b === '瓜菜類'],
    ['根莖', (a, b, tc) => tc === 'N04' && (b === '莖菜類' || b === '根菜類' || b === '藷類')],
    ['菇類', (a, b, tc) => tc === 'N04' && b === '菇蕈類'],
    ['蔥蒜', (a, b, tc) => tc === 'N04' && b === '鱗莖類'],
    ['茄果椒', (a, b, tc) => tc === 'N04' && b === '果菜類'],
    ['豆類', (a, b, tc) => tc === 'N04' && (b === '豆菜類' || b === '豆類')],
    ['花椰菜', (a, b, tc) => tc === 'N04' && b === '花菜類'],
    ['芽菜', (a, b, tc) => tc === 'N04' && b === '芽菜類'],
    ['柑橘', (a, b, tc) => tc === 'N05' && b === '柑橘類'],
    ['水果', (a, b, tc) => tc === 'N05'],
    ['其他蔬菜', (a, b, tc) => tc === 'N04'],
  ];
  const CAT_ORDER = CAT.map(([n]) => n);
  const catOf = (c) => CAT.find(([, f]) => f(c.plv1, c.plv2, c.tc_type))?.[0] ?? '其他蔬菜';

  const listSource = {
    lastDate: last_date, xun: xunLabel,
    // 預設清單：一般家庭常買的，全部確認過站上有頁面且資料足夠
    defaults: ['高麗菜', '青江菜', '空心菜', '地瓜葉', '青蔥', '洋蔥', '蘿蔔', '胡蘿蔔',
      '馬鈴薯', '小黃瓜', '番茄', '玉米', '香蕉', '木瓜', '鳳梨', '西瓜'],
    crops: [...crops.values()]
      .filter((c) => c.tc_type !== 'N06')
      .map((c) => {
        const slug = `${c.tc_type.toLowerCase()}-${c.plv3_key}`;
        const ch = changeBySlug.get(slug);
        const d90 = new Set((c.daily ?? []).map((x) => x.d)).size;
        const v90 = (c.daily ?? []).reduce((s, x) => s + (x.volume ?? 0), 0);
        if (!(d90 >= INDEX_IN.days90 && v90 >= INDEX_IN.volume90)) return null;
        return {
          slug, name: c.name, tcType: c.tc_type, cat: catOf(c),
          changePct: ch?.changePct ?? null,
          wholesale: ch?.wholesale ?? c.national.at(-1)?.price ?? null,
          retailPerCatty: c.retail?.perCatty ?? null,
          seasonal: c.seasonal,
          alt: ch ? (withAlt(ch)[0]?.name ?? null) : null,
        };
      })
      .filter(Boolean)
      // 選單的分組順序＝CAT 的宣告順序，所以先按分類排，同分類內才按名稱
      .sort((a, b) => (CAT_ORDER.indexOf(a.cat) - CAT_ORDER.indexOf(b.cat))
        || a.name.localeCompare(b.name, 'zh-Hant')),
  };

  if (!report) {
    await writeFile(join(PAGE, 'list-source.json'), JSON.stringify(listSource));
    await writeFile(join(PAGE, 'home.json'), JSON.stringify(home, null, 1));
    await writeFile(join(PAGE, 'cheap-now.json'), JSON.stringify({
      lastDate: last_date, targetXun: xunLabel, basis: home.basis, filters: home.filters,
      candidates: changes.length,
      cheaper: changes.slice(0, 40), pricier: changes.slice(-40).reverse(),
    }, null, 1));
    await writeFile(join(PAGE, 'index.json'), JSON.stringify({
      builtAt: new Date().toISOString(), lastDate: last_date,
      crops: cropIndex.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hant')), markets: marketIndex,
      counts: { crops: cropIndex.length, markets: marketIndex.length, cropMarket: pageState.filter((p) => p.path.split('/').length === 4).length },
    }));
    await writeFile(join(PAGE, 'page-state.ndjson'), pageState.map((x) => JSON.stringify(x)).join('\n') + '\n');
  }

  const ix = pageState.filter((p) => p.indexable).length;
  console.error(`頁面 ${pageState.length} 個（作物 ${cropIndex.length}、市場 ${marketIndex.length}、作物×市場 ${pageState.length - cropIndex.length - marketIndex.length}）`);
  console.error(`可收錄 ${ix} 個（${(ix / pageState.length * 100).toFixed(1)}%）`);
  console.error(`漲跌榜 ${changes.length} 個品項（其中菜 ${food.length}）；首頁便宜 ${home.cheap.length}、貴 ${home.pricey.length}、當季 ${home.seasonalNow.length}`);
  console.error(`俗名對照 ${Object.keys(commonName).length} 筆、台中實測零售對到 ${retailByCrop.size} 個作物`);
  console.error(`有替代建議的貴品項：${home.pricey.filter((p) => p.alternatives.length).map((p) => `${p.name}→${p.alternatives.map((a) => a.name).join('/')}`).join('、') || '無'}`);
  console.error(`寫出 ${written} 個檔案 → data/page/`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
