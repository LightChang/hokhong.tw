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
const want = (s) => only === 'all' || only === s;

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

console.log('');
