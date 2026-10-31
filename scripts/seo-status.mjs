#!/usr/bin/env node
// 線上現況：GSC 收錄與曝光、GA4 自然搜尋流量。
//
// 為什麼要有這支：文件裡不留寫死的數字。收錄數、曝光、session 每天都在動，
// 寫進 Markdown 隔天就是錯的，而且錯得很有說服力。要看現況就跑這支。
//
//   node scripts/seo-status.mjs           # 全部
//   node scripts/seo-status.mjs index     # 只看收錄（sitemap + 逐頁抽查）
//   node scripts/seo-status.mjs rich      # 只看結構化資料被 Google 認出來沒
//   node scripts/seo-status.mjs traffic   # 只看曝光與流量
//   node scripts/seo-status.mjs types     # 按頁型算「每百頁點擊」，加減頁的依據（GROWTH.md 方法論第 2 條）
//   node scripts/seo-status.mjs gaps      # 查詢缺口：名次 >20、落地頁對不上、問題型查詢（方法論第 3 條）
//
// types／gaps 不在 all 裡：要拉整份 sitemap 與 query×page，判讀時才跑。
//
// 存取方式：不下載金鑰。以 gcloud 使用者 token 模擬服務帳號
// hokhong-index@hokhong-tw.iam.gserviceaccount.com；token 不會印出來。
// 先決條件：gcloud auth login 過，且服務帳號已在 GSC／GA 後台加為使用者。

import { execFileSync } from 'node:child_process';

const SA = 'hokhong-index@hokhong-tw.iam.gserviceaccount.com';
const SITE = 'sc-domain:hokhong.tw';
const PROP = 'properties/553897299';
const ORIGIN = 'https://hokhong.tw';

const only = process.argv[2] ?? 'all';
const want = (s) => (only === 'all' && !['types', 'gaps'].includes(s)) || only === s;

// GSC 資料有 2–3 天延遲，把今天算進去會看到假的下跌
const iso = (d) => d.toISOString().slice(0, 10);
const end = iso(new Date(Date.now() - 864e5));
const start = iso(new Date(Date.now() - 28 * 864e5));

const token = await (async () => {
  let userToken;
  try {
    userToken = execFileSync('gcloud', ['auth', 'print-access-token'], { encoding: 'utf-8' }).trim();
  } catch {
    console.error('拿不到 gcloud token。先跑 `gcloud auth login`。');
    process.exit(1);
  }
  const r = await fetch(
    `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${SA}:generateAccessToken`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${userToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        scope: [
          'https://www.googleapis.com/auth/webmasters',
          'https://www.googleapis.com/auth/analytics.readonly',
        ],
        lifetime: '3600s',
      }),
    },
  );
  const j = await r.json();
  if (!j.accessToken) {
    console.error('模擬服務帳號失敗：', JSON.stringify(j).slice(0, 300));
    process.exit(1);
  }
  return j.accessToken;
})();

const api = async (url, body) => {
  const r = await fetch(url, {
    method: body ? 'POST' : 'GET',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return r.json();
};
// URL 檢查 API 會偶發回 500，重試一次就好。不重試的話輸出裡會出現看起來像站台問題的
// ERROR，但其實站台沒事——這種假警報比沒有輸出更糟。
const inspect = async (u) => {
  for (let i = 0; i < 3; i++) {
    const d = await api('https://searchconsole.googleapis.com/v1/urlInspection/index:inspect', {
      inspectionUrl: u, siteUrl: SITE, languageCode: 'zh-TW',
    });
    if (!d.error || d.error.code < 500) return d;
    await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
  }
  return { error: { code: 500, message: '重試 3 次仍失敗' } };
};

const enc = encodeURIComponent(SITE);
const pad = (s, n) => String(s).padEnd(n);
const num = (v) => Number(v ?? 0).toLocaleString('en-US');

// 每個頁型各抽一個代表
const SAMPLE = [
  '/', '/cheap/', '/crop/', '/crop/n04-00201002001/', '/crop/n04-00201002001/104/',
  '/market/n04-109/', '/meat/', '/meat/egg-wholesale/', '/about/',
];

console.log(`期間 ${start} ~ ${end}（不含今天：GSC 有 2–3 天延遲）`);

if (want('index')) {
  console.log('\n===== sitemap =====');
  const sm = await api(`https://searchconsole.googleapis.com/webmasters/v3/sites/${enc}/sitemaps`);
  for (const s of sm.sitemap ?? []) {
    const c = (s.contents ?? [{}])[0];
    console.log(`  ${s.path}`);
    console.log(`    送出 ${(s.lastSubmitted ?? '').slice(0, 16)}　下載 ${(s.lastDownloaded ?? '').slice(0, 16)}`);
    console.log(`    errors ${s.errors}　warnings ${s.warnings}　submitted ${num(c.submitted)}`);
    console.log(`    indexed ${num(c.indexed)}  ← 這個欄位會落後好幾天，不要拿它當收錄進度`);
  }

  console.log('\n===== 逐頁抽查（收錄進度以這裡為準）=====');
  for (const p of SAMPLE) {
    const d = await inspect(ORIGIN + p);
    if (d.error) { console.log(`  ${pad(p, 44)} ERROR ${d.error.code} ${(d.error.message ?? '').slice(0, 60)}`); continue; }
    const i = d.inspectionResult?.indexStatusResult ?? {};
    const notes = [];
    if (i.robotsTxtState && !['ALLOWED', 'ROBOTS_TXT_STATE_UNSPECIFIED'].includes(i.robotsTxtState)) notes.push(`✗robots=${i.robotsTxtState}`);
    if (i.pageFetchState && !['SUCCESSFUL', 'PAGE_FETCH_STATE_UNSPECIFIED'].includes(i.pageFetchState)) notes.push(`✗fetch=${i.pageFetchState}`);
    if (i.googleCanonical && i.userCanonical && i.googleCanonical !== i.userCanonical) notes.push(`✗canonical→${i.googleCanonical}`);
    console.log(`  ${pad(p, 44)} ${pad(i.verdict ?? '?', 8)} ${i.coverageState ?? '?'}  檢索 ${(i.lastCrawlTime ?? '').slice(0, 10) || '—'} ${notes.join(' ')}`);
  }
}

if (want('rich')) {
  console.log('\n===== 結構化資料，Google 認出來沒 =====');
  console.log('  （檢索日早於最近一次部署就代表還沒看到，不是錯誤）');
  for (const p of ['/crop/n04-00201002001/', '/cheap/', '/meat/egg-wholesale/']) {
    const d = await inspect(ORIGIN + p);
    const r = d.inspectionResult ?? {};
    const x = r.richResultsResult;
    const crawl = (r.indexStatusResult?.lastCrawlTime ?? '').slice(0, 10) || '—';
    if (!x) { console.log(`  ${pad(p, 44)} 尚未回報　檢索 ${crawl}`); continue; }
    console.log(`  ${pad(p, 44)} ${x.verdict}　檢索 ${crawl}`);
    for (const it of x.detectedItems ?? []) {
      console.log(`      ${it.richResultType}: ${(it.items ?? []).length} 項`);
      for (const one of it.items ?? []) {
        for (const iss of one.issues ?? []) console.log(`        ISSUE ${iss.severity}: ${iss.issueMessage}`);
      }
    }
  }
}

if (want('traffic')) {
  console.log('\n===== GSC 曝光與點擊 =====');
  const q = (dims, rowLimit) =>
    api(`https://searchconsole.googleapis.com/webmasters/v3/sites/${enc}/searchAnalytics/query`,
      { startDate: start, endDate: end, dimensions: dims, rowLimit });

  const byDate = await q(['date'], 100);
  if (!byDate.rows?.length) {
    console.log('  期間內沒有任何曝光（新站正常；有數字之後才談關鍵字調整）');
  } else {
    const imp = byDate.rows.reduce((s, r) => s + r.impressions, 0);
    const clk = byDate.rows.reduce((s, r) => s + r.clicks, 0);
    console.log(`  有曝光的天數 ${byDate.rows.length}　總曝光 ${num(imp)}　總點擊 ${num(clk)}`);
    for (const r of byDate.rows.slice(-7)) {
      console.log(`    ${r.keys[0]}  曝光 ${pad(num(r.impressions), 6)} 點擊 ${num(r.clicks)}`);
    }
  }

  console.log('\n  前 10 個查詢：');
  const byQuery = await q(['query'], 10);
  if (!byQuery.rows?.length) console.log('    （還沒有）');
  else for (const r of byQuery.rows) {
    console.log(`    ${pad(r.keys[0].slice(0, 28), 30)} 曝光 ${pad(num(r.impressions), 6)} 點擊 ${pad(num(r.clicks), 4)} 排名 ${r.position.toFixed(1)}`);
  }

  console.log('\n===== GA4 流量來源 =====');
  const ga = await api(`https://analyticsdata.googleapis.com/v1beta/${PROP}:runReport`, {
    dateRanges: [{ startDate: start, endDate: end }],
    dimensions: [{ name: 'sessionSourceMedium' }],
    metrics: [{ name: 'sessions' }, { name: 'activeUsers' }],
    limit: 20,
  });
  if (!ga.rows?.length) console.log('  期間內沒有流量');
  else {
    let tot = 0;
    for (const r of ga.rows) {
      const src = r.dimensionValues[0].value;
      const s = Number(r.metricValues[0].value);
      tot += s;
      const mark = src === 'google / organic' ? '  ← 自然搜尋' : '';
      console.log(`  ${pad(src, 28)} session ${pad(s, 5)} 使用者 ${r.metricValues[1].value}${mark}`);
    }
    console.log(`  合計 session ${tot}`);
  }
}

// 頁型＝路徑形狀。品項×市場頁（/crop/x/y/）佔 sitemap 大宗，要跟品項頁分開看，
// 才知道爬取預算花在哪一型、哪一型值得加頁或收緊。
const pageType = (path) => {
  const seg = path.split('/').filter(Boolean);
  if (!seg.length) return '首頁';
  const [top] = seg;
  if (seg.length === 1) return `/${top}/`;
  if (top === 'crop') return seg.length === 2 ? '/crop/x/' : '/crop/x/y/';
  return `/${top}/x/`;
};
const gscRows = async (dims, extra = {}) => {
  const out = [];
  for (let startRow = 0; ; startRow += 25000) {
    const d = await api(`https://searchconsole.googleapis.com/webmasters/v3/sites/${enc}/searchAnalytics/query`,
      { startDate: start, endDate: end, dimensions: dims, rowLimit: 25000, startRow, ...extra });
    out.push(...(d.rows ?? []));
    if ((d.rows ?? []).length < 25000) return out;
  }
};
const pathOf = (u) => new URL(u).pathname;

if (want('types')) {
  console.log('\n===== 按頁型：每百頁點擊 =====');
  const xml = await (await fetch(`${ORIGIN}/sitemap-0.xml`)).text();
  const inMap = new Map();
  for (const [, u] of xml.matchAll(/<loc>([^<]+)<\/loc>/g)) {
    const t = pageType(pathOf(u));
    inMap.set(t, (inMap.get(t) ?? 0) + 1);
  }
  const agg = new Map();
  for (const r of await gscRows(['page'])) {
    const t = pageType(pathOf(r.keys[0]));
    const a = agg.get(t) ?? { pages: 0, imp: 0, clk: 0, pos: 0 };
    a.pages++; a.imp += r.impressions; a.clk += r.clicks; a.pos += r.position * r.impressions;
    agg.set(t, a);
  }
  const types = [...new Set([...inMap.keys(), ...agg.keys()])]
    .sort((x, y) => (agg.get(y)?.clk ?? 0) - (agg.get(x)?.clk ?? 0) || (inMap.get(y) ?? 0) - (inMap.get(x) ?? 0));
  console.log(`  ${pad('頁型', 14)}${pad('sitemap', 9)}${pad('有曝光', 8)}${pad('曝光', 9)}${pad('點擊', 7)}${pad('CTR', 7)}${pad('名次', 7)}每百頁點擊`);
  for (const t of types) {
    const n = inMap.get(t) ?? 0;
    const a = agg.get(t) ?? { pages: 0, imp: 0, clk: 0, pos: 0 };
    const ctr = a.imp ? `${(a.clk / a.imp * 100).toFixed(1)}%` : '—';
    const pos = a.imp ? (a.pos / a.imp).toFixed(1) : '—';
    const per = n ? (a.clk / n * 100).toFixed(1) : '（不在 sitemap）';
    console.log(`  ${pad(t, 14)}${pad(n, 9)}${pad(a.pages, 8)}${pad(num(a.imp), 9)}${pad(a.clk, 7)}${pad(ctr, 7)}${pad(pos, 7)}${per}`);
  }
}

// 問題型查詢是 AEO 主軸（「一句話答不完」）對不對的唯一數字，見 GROWTH.md AEO 表
const QUESTION = /會不會|貴不貴|為什麼|為何|颱風|過年|春節|休市|一斤|多少錢|划算|便宜|什麼時候|幾月|哪裡/;

if (want('gaps')) {
  const rows = await gscRows(['query', 'page']);
  const fmt = (r) => `${pad(r.keys[0].slice(0, 22), 24)} ${pad(pathOf(r.keys[1]).slice(0, 34), 36)} 曝光 ${pad(r.impressions, 5)} 點擊 ${pad(r.clicks, 3)} 名次 ${r.position.toFixed(1)}`;

  console.log('\n===== 缺口一：有曝光、名次 >20（同查詢只列最好的那頁）=====');
  const best = new Map();
  for (const r of rows) {
    const b = best.get(r.keys[0]);
    if (!b || r.position < b.position) best.set(r.keys[0], r);
  }
  const far = [...best.values()].filter((r) => r.position > 20).sort((a, b) => b.impressions - a.impressions);
  for (const r of far.slice(0, 30)) console.log(`  ${fmt(r)}`);
  if (!far.length) console.log('  （沒有）');

  console.log('\n===== 缺口二：同一查詢落在多頁（互搶或落地頁不對）=====');
  const byQ = new Map();
  for (const r of rows) byQ.set(r.keys[0], [...(byQ.get(r.keys[0]) ?? []), r]);
  const split = [...byQ.entries()].filter(([, rs]) => rs.length > 1)
    .map(([q, rs]) => [q, rs.sort((a, b) => b.impressions - a.impressions)])
    .sort((a, b) => b[1].reduce((s, r) => s + r.impressions, 0) - a[1].reduce((s, r) => s + r.impressions, 0));
  for (const [q, rs] of split.slice(0, 15)) {
    console.log(`  ${q}`);
    for (const r of rs.slice(0, 4)) console.log(`      ${pad(pathOf(r.keys[1]).slice(0, 40), 42)} 曝光 ${pad(r.impressions, 5)} 名次 ${r.position.toFixed(1)}`);
  }
  if (!split.length) console.log('  （沒有）');

  console.log('\n===== 問題型查詢 =====');
  const qs = [...best.keys()].filter((q) => QUESTION.test(q));
  const qrows = rows.filter((r) => QUESTION.test(r.keys[0]));
  const qi = qrows.reduce((s, r) => s + r.impressions, 0);
  const qc = qrows.reduce((s, r) => s + r.clicks, 0);
  const ti = rows.reduce((s, r) => s + r.impressions, 0);
  console.log(`  ${qs.length} 個查詢，曝光 ${num(qi)}（佔 ${ti ? (qi / ti * 100).toFixed(1) : 0}%），點擊 ${qc}`);
  for (const q of qs.sort((a, b) => best.get(b).impressions - best.get(a).impressions).slice(0, 20)) {
    console.log(`  ${fmt(best.get(q))}`);
  }
}

console.log('');
