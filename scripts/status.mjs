#!/usr/bin/env node
// 本機現況：資料層、頁面層、排程層各有幾列幾頁幾支，以及線上跑到哪。
//
// 為什麼要有這支：文件裡不留寫死的數字。列數、頁數、幾支來源、幾步轉換、覆蓋率、
// 有零售實測的品項數——全都會隨每日資料更新或程式增刪而變，寫進 Markdown 隔天就是錯的，
// 而且錯得很有說服力（2026-09-25 盤點：README 寫「轉換層 8 支九步」，實際 11 步；
// 寫「取得層 5 支」，實際 12 支）。要看現況就跑這支，輸出即事實。
//
//   node scripts/status.mjs            # 全部（本機三節 + 線上兩節）
//   node scripts/status.mjs data page  # 幾個區段可以一次給
//   node scripts/status.mjs steps      # 取得層幾支、轉換層幾步
//   node scripts/status.mjs data       # 各層列數、日數、覆蓋率、目錄與檔案大小
//   node scripts/status.mjs page       # 頁數、可收錄比例、零售與價格鏈覆蓋、颱風
//   node scripts/status.mjs release    # data-history / data-current 資產大小（需 gh）
//   node scripts/status.mjs online     # 最近一次 daily.yml、線上 sitemap、Pages 設定（需 gh/curl）
//
// 純讀既有產物，不重算、不 build。本機 checkout 的 data/ 可能落後線上好幾天
// （每日更新發生在 Actions 的 runner 上），所以「線上現況」要看 online 節，不是 data 節。
// 姊妹工具：scripts/seo-status.mjs（線上收錄與流量）、scripts/seo-audit.mjs（dist/ 的 SEO 現況）。

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { steps as transformSteps } from '../transform/run.mjs';
import { jobs as ingestJobs } from '../ingest/run.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const SECTIONS = ['steps', 'data', 'page', 'release', 'online'];
const asked = process.argv.slice(2);
const want = (s) => asked.length === 0 || asked.includes('all') || asked.includes(s);
const p = (...a) => join(ROOT, ...a);

const n = (v) => (v == null ? '—' : Number(v).toLocaleString('en-US'));
const mb = (b) => (b < 1024 * 1024 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1024 / 1024).toFixed(1)} MB`);
const json = (rel) => JSON.parse(readFileSync(p(rel), 'utf8'));
const has = (rel) => existsSync(p(rel));
const h = (s) => console.log(`\n── ${s} ${'─'.repeat(Math.max(0, 56 - s.length))}`);
const miss = (what, how) => console.log(`  ${what}：查不到（${how}）`);

const dirBytes = (rel) => {
  let total = 0;
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const f = join(d, e.name);
      if (e.isDirectory()) walk(f);
      else total += statSync(f).size;
    }
  };
  if (existsSync(p(rel))) walk(p(rel));
  return total;
};
const countFiles = (rel, ext) => {
  let c = 0;
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(d, e.name));
      else if (e.name.endsWith(ext)) c++;
    }
  };
  if (existsSync(p(rel))) walk(p(rel));
  return c;
};
const sh = (cmd, args) => execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

// ── 排程層：幾支來源、幾步轉換 ─────────────────────────
if (want('steps')) {
  h('排程層');
  const byFreq = ingestJobs.reduce((a, j) => ((a[j.freq] = (a[j.freq] ?? 0) + 1), a), {});
  const freqText = Object.entries(byFreq).map(([f, c]) => `${f} ${c}`).join('、');
  console.log(`  取得層：${ingestJobs.length} 支（${freqText}；關鍵 ${ingestJobs.filter((j) => j.critical).length} 支）`);
  console.log(`          ${ingestJobs.map((j) => j.id).join(' ')}`);
  console.log(`  取得程式檔：${readdirSync(p('ingest/sources')).filter((f) => f.endsWith('.mjs')).length} 支於 ingest/sources/`);
  console.log(`  轉換層：${transformSteps.length} 步（最後一步是 ${transformSteps.at(-1).id}，跑完 dist/ 就是最新站台）`);
  console.log(`          ${transformSteps.map((s) => s.id).join(' → ')}`);
  console.log('  各支的上次成功與下次到期：node ingest/run.mjs --list');
}

// ── 資料層 ───────────────────────────────────────────
if (want('data')) {
  h('資料層（本機 checkout）');
  if (has('data/parquet/farm_trans.meta.json')) {
    const m = json('data/parquet/farm_trans.meta.json');
    console.log(`  L1 行情：${n(m.rows)} 列 / ${n(m.days)} 個交易日 / ${m.first}–${m.last}（民國）`);
    console.log(`           builtAt ${m.builtAt}${m.emptyRawDays?.length ? ` / 空檔日 ${m.emptyRawDays.length}` : ''}`);
  } else miss('L1 行情', '先跑 node transform/run.mjs');
  if (has('data/parquet/origin_price.meta.json')) {
    const m = json('data/parquet/origin_price.meta.json');
    console.log(`  產地價：${n(m.rows)} 列 / ${n(m.products)} 個品名 / ${n(m.counties)} 縣市；最新全國旬 ${m.latestNationalXun.year}-${m.latestNationalXun.month} 第 ${m.latestNationalXun.xun} 旬（${n(m.latestNationalXun.products)} 品名）`);
  }
  if (has('data/observation/observe.meta.json')) {
    const m = json('data/observation/observe.meta.json');
    console.log(`  observation：current ${n(m.currentRows)} 列；上次 ${m.scope} 未變 ${n(m.unchanged)} / 修正 ${n(m.changed)} / 新增 ${n(m.added)}（${m.ranAt}）`);
  }
  if (has('data/identity/identity.meta.json')) {
    const m = json('data/identity/identity.meta.json');
    console.log(`  作物身分：${n(m.codes)} 個代碼 → 自動接受 ${n(m.autoAccepted)}、待人看 ${n(m.reviewQueue)}（官方分類不符 ${n(m.officialCategoryMismatch)}、衍生分類外溢 ${n(m.derivedCategoryLeak)}）`);
    for (const [rule, v] of Object.entries(m.byRule).sort((a, b) => b[1].volumeShare - a[1].volumeShare)) {
      console.log(`      ${rule.padEnd(20)} 代碼 ${String(v.codes).padStart(5)}  交易量 ${String(v.volumeShare).padStart(6)}%`);
    }
  }
  if (has('data/coverage.meta.json')) {
    const m = json('data/coverage.meta.json');
    const all = Number(m.steps[0].rows), vol = Number(m.steps[0].volume);
    const blocked = m.steps.find((s) => s.step.startsWith('5'));
    console.log(`  對帳：${m.reconciled ? '通過' : '✗ 未通過'}；孤兒列 ${n(m.orphanRows)}（${m.checkedAt}）`);
    for (const s of m.steps) console.log(`      ${s.step.padEnd(24)} ${n(s.rows).padStart(12)} 列  ${n(Math.round(s.volume)).padStart(14)} 公斤`);
    if (blocked) console.log(`      被 confidence 擋掉：列數 ${(100 * Number(blocked.rows) / all).toFixed(2)}%、交易量 ${(100 * Number(blocked.volume) / vol).toFixed(2)}%`);
    const ys = Object.values(m.byYear);
    console.log(`      逐年交易量覆蓋率 ${Math.min(...ys)}–${Math.max(...ys)}%（每年一個值，全部：jq .byYear data/coverage.meta.json）`);
  }
  if (has('data/agg/agg.meta.json')) {
    const m = json('data/agg/agg.meta.json');
    console.log(`  聚合：來源 ${n(m.source.rows)} 列 / ${n(m.source.crops)} 作物 / ${n(m.source.markets)} 市場`);
    for (const [t, v] of Object.entries(m.tables)) console.log(`      ${t.padEnd(12)} ${n(v.rows).padStart(10)} 列  ${(v.ms / 1000).toFixed(1)}s`);
  }
  h('磁碟佔用（本機；歷史 raw 不在 checkout 裡時會偏小）');
  for (const d of ['data', 'data/parquet/farm_trans', 'data/observation', 'data/agg', 'data/page', 'ingest/raw']) {
    console.log(`  ${d.padEnd(26)} ${mb(dirBytes(d)).padStart(10)}`);
  }
  console.log(`  parquet 檔數：${countFiles('data/parquet/farm_trans', '.parquet')}（一天一檔）`);
}

// ── 頁面層 ───────────────────────────────────────────
if (want('page')) {
  h('頁面層');
  if (!has('data/page/index.json')) {
    miss('頁面層', '先跑 node transform/run.mjs');
  } else {
    const idx = json('data/page/index.json');
    console.log(`  資料到 ${idx.lastDate}；builtAt ${idx.builtAt}`);
    console.log(`  品項 ${n(idx.counts.crops)} / 市場 ${n(idx.counts.markets)} / 品項×市場 ${n(idx.counts.cropMarket)}`);
    console.log(`  per-page JSON 檔數：${countFiles('data/page', '.json')}`);

    if (has('data/page/page-state.ndjson')) {
      const rows = readFileSync(p('data/page/page-state.ndjson'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      const ok = rows.filter((r) => r.indexable).length;
      const byKind = {};
      for (const r of rows) {
        const k = r.path.split('/')[1] || 'root';
        byKind[k] ??= { all: 0, ok: 0 };
        byKind[k].all++;
        if (r.indexable) byKind[k].ok++;
      }
      console.log(`  品質門檻：${n(rows.length)} 頁中 ${n(ok)} 頁可收錄（${(100 * ok / rows.length).toFixed(1)}%），其餘 noindex`);
      for (const [k, v] of Object.entries(byKind)) console.log(`      ${k.padEnd(14)} ${String(v.ok).padStart(5)} / ${String(v.all).padStart(5)}`);
    }

    // 零售、價格鏈、市場座標、覆蓋率：emit-page 已經算進 about.json（站上 /about/ 讀的就是它），
    // 這裡直接引用，不自己再算一套——兩套算法會給出兩個都自稱正確的數字。
    if (has('data/page/about.json')) {
      const a = json('data/page/about.json');
      console.log(`  零售實測：${a.retail.items} 個品項有臺中 ${a.retail.markets} 個公有零售市場的實測價（近 ${a.retail.days} 個訪價日中位數）`);
      console.log(`      零售÷批發 ${a.retail.ratioMin?.ratio}（${a.retail.ratioMin?.name}）–${a.retail.ratioMax?.ratio}（${a.retail.ratioMax?.name}）倍，中位數 ${a.retail.ratioMedian}`);
      console.log(`  價格鏈：對得上產地品名 ${a.chain.candidates} 個 → 通過 ${a.chain.comparable} 個，三層俱全 ${a.chain.threeLayer} 個`);
      for (const [r, c] of Object.entries(a.chain.blocked).sort((x, y) => y[1] - x[1])) console.log(`      擋下 ${r.padEnd(24)} ${c}`);
      console.log(`  市場：${a.markets.total} 個（有座標 ${a.markets.withGeo}；缺座標 ${a.markets.missingGeo.map((m) => m.name).join('、') || '無'}）`);
      console.log(`  交易量覆蓋率：${Object.entries(a.coverage?.byType ?? {}).filter(([k]) => k).map(([k, v]) => `${k} ${v}%`).join('、')}`);
      if (a.typhoon) console.log(`  颱風：${a.typhoon.firstYear} 年以來 ${a.typhoon.count} 次、${a.typhoon.crops} 個作物算得出回穩天數`);
    } else {
      miss('about.json', '先跑 node transform/emit-page.mjs');
    }

    // 俗名改寫的筆數只有逐頁才知道（about.json 不需要它）
    const files = readdirSync(p('data/page/crop')).filter((f) => f.endsWith('.json'));
    let alias = 0;
    for (const f of files) {
      const d = json(join('data/page/crop', f));
      if (d.official && d.name !== d.official) alias++;
    }
    console.log(`  俗名與官方名不同：${alias} 個品項`);

    if (has('data/page/list-source.json')) {
      const ls = json('data/page/list-source.json');
      console.log(`  買菜清單／品項搜尋來源：${ls.crops.length} 個可買品項、預設清單 ${ls.defaults.length} 樣、${mb(statSync(p('data/page/list-source.json')).size)}`);
    }
    if (has('data/page/cheap-now.json')) {
      const c = json('data/page/cheap-now.json');
      console.log(`  這週划算：基準 ${c.targetXun}，過門檻候選 ${n(c.candidates)} 個 → 榜單便宜 ${c.cheaper.length} / 變貴 ${c.pricier.length}`);
    }
    if (has('data/page/typhoon.json')) {
      const t = json('data/page/typhoon.json');
      console.log(`  最近一次颱風距今 ${t.latest?.daysSince} 天`);
    }
  }
}

// ── 資料 release ─────────────────────────────────────
if (want('release')) {
  h('data release（資料不進 git，放在 release）');
  for (const tag of ['data-history', 'data-current']) {
    try {
      const out = JSON.parse(sh('gh', ['release', 'view', tag, '--json', 'assets,publishedAt']));
      console.log(`  ${tag}（${out.publishedAt}）`);
      for (const a of out.assets) console.log(`      ${a.name.padEnd(24)} ${mb(a.size).padStart(10)}  更新 ${a.updatedAt ?? '—'}`);
    } catch {
      miss(tag, '需要 gh CLI 且已登入：gh auth status');
    }
  }
}

// ── 線上 ─────────────────────────────────────────────
if (want('online')) {
  h('線上（每日更新真的發生的地方）');
  try {
    const runs = JSON.parse(sh('gh', ['run', 'list', '--workflow=daily.yml', '-L', '5', '--json', 'conclusion,createdAt,updatedAt,databaseId']));
    for (const r of runs) {
      const mins = ((new Date(r.updatedAt) - new Date(r.createdAt)) / 60000).toFixed(1);
      console.log(`  ${r.createdAt}  ${String(r.conclusion).padEnd(8)} ${mins} 分  run ${r.databaseId}`);
    }
    console.log('  逐步耗時與各層列數（這一支才是線上現況的權威輸出）：');
    console.log(`      gh run view ${runs[0]?.databaseId} --log | less`);
  } catch {
    miss('daily.yml 執行紀錄', '需要 gh CLI 且已登入');
  }
  try {
    const pages = JSON.parse(sh('gh', ['api', 'repos/LightChang/hokhong.tw/pages']));
    console.log(`  Pages：${pages.html_url}  cname=${pages.cname}  build=${pages.build_type}  https_enforced=${pages.https_enforced}  憑證 ${pages.https_certificate?.state} 到 ${pages.https_certificate?.expires_at ?? '—'}`);
  } catch {
    miss('Pages 設定', '需要 gh CLI 且已登入');
  }
  try {
    const xml = sh('curl', ['-sS', 'https://hokhong.tw/sitemap-0.xml']);
    console.log(`  線上 sitemap 收錄 ${(xml.match(/<loc>/g) ?? []).length} 頁`);
    const head = sh('curl', ['-sSI', 'https://hokhong.tw/']);
    console.log(`  首頁 ${head.split('\n')[0].trim()}；${head.split('\n').find((l) => /^last-modified/i.test(l))?.trim() ?? ''}`);
  } catch {
    miss('線上站台', '無外網或 curl 失敗');
  }
}

const unknown = asked.filter((a) => a !== 'all' && !SECTIONS.includes(a));
if (unknown.length) {
  console.error(`未知的區段 ${unknown.join(' ')}；可用：${SECTIONS.join(' ')}（或不給參數跑全部）`);
  process.exit(1);
}
console.log('');
