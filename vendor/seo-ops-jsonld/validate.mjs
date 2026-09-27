// JSON-LD 驗證器（四站共用）。
// 規則全部來自 rules.json（官方文件查證結果）＋站台設定（jsonld-pages.json）；本檔不寫死任何欄位。
// validateHtml() 是純函式：輸入 HTML 字串＋規則，回傳問題清單。
// 檔案 I/O（loadRules / loadSiteConfig / validateDist）另列在檔尾，供 astro:build:done 與 CLI 使用。

import { readFile, readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SEVERITY_ORDER = { off: 0, info: 1, warning: 2, error: 3 };

// ---------- 小工具 ----------

const asArray = (v) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
const isPresent = (v) =>
  v !== undefined && v !== null && !(typeof v === 'string' && v.trim() === '') && !(Array.isArray(v) && v.length === 0);
const typesOf = (node) => asArray(node && node['@type']).filter((t) => typeof t === 'string');

/** 依點號路徑取值；每一步遇到陣列自動攤平（JSON-LD 任何值都可能是陣列）。 */
function getValues(node, path) {
  let cur = [node];
  for (const key of path.split('.')) {
    const next = [];
    for (const c of cur) {
      if (c && typeof c === 'object' && !Array.isArray(c)) for (const v of asArray(c[key])) next.push(v);
    }
    cur = next;
  }
  return cur.filter(isPresent);
}

/** 'a.b[].c.d' → { base: 'a.b', rest: 'c.d' }；沒有 [] 回傳 null */
function splitEach(path) {
  const i = path.indexOf('[]');
  if (i < 0) return null;
  return { base: path.slice(0, i), rest: path.slice(i + 2).replace(/^\./, '') };
}

/** 單頁網址模式：* 比對一段、** 比對任意長度；整串比對 */
export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === '*' && glob[i + 1] === '*') { re += '.*'; i++; }
    else if (ch === '*') re += '[^/]*';
    else re += ch.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}
const matchAny = (page, patterns = []) => patterns.some((p) => globToRegExp(p).test(page));

// ---------- 抽出 ld+json 區塊 ----------

const OPEN_TAG = /<script\b([^>]*)>/gi;
const LD_TYPE = /\btype\s*=\s*(["']?)application\/ld\+json\1/i;

/**
 * 依瀏覽器規則抽出 <script type="application/ld+json">：內容到第一個 </script 為止。
 * 若該段 JSON 壞掉，但接到後面的 </script> 就能解析，代表資料字串內含 </script> 被截斷。
 */
export function extractJsonLd(html) {
  const blocks = [];
  const lower = html.toLowerCase();
  OPEN_TAG.lastIndex = 0;
  let m;
  while ((m = OPEN_TAG.exec(html))) {
    if (!LD_TYPE.test(m[1])) continue;
    const start = m.index + m[0].length;
    const end = lower.indexOf('</script', start);
    const raw = html.slice(start, end < 0 ? html.length : end);
    const block = { index: blocks.length, raw, data: undefined, parseError: null, truncated: false };
    try {
      block.data = JSON.parse(raw);
    } catch (err) {
      block.parseError = err.message;
      let next = end;
      for (let k = 0; k < 10 && next >= 0; k++) {
        next = lower.indexOf('</script', next + 1);
        if (next < 0) break;
        try {
          block.data = JSON.parse(html.slice(start, next));
          block.truncated = true;
          block.raw = html.slice(start, next);
          OPEN_TAG.lastIndex = next;
          break;
        } catch { /* 繼續往後接 */ }
      }
    }
    blocks.push(block);
    if (!block.truncated && end >= 0) OPEN_TAG.lastIndex = end;
  }
  return blocks;
}

/** 頂層節點：區塊本身（或陣列元素），以及 @graph 內的節點 */
function topLevelNodes(data) {
  const out = [];
  for (const item of asArray(data)) {
    if (!item || typeof item !== 'object') continue;
    if (Array.isArray(item['@graph'])) out.push(...item['@graph'].filter((n) => n && typeof n === 'object'));
    if (item['@type']) out.push(item);
  }
  return out;
}

/** 走訪所有物件節點（含巢狀），回呼 (node, jsonPath) */
function walk(value, fn, path = '$') {
  if (Array.isArray(value)) value.forEach((v, i) => walk(v, fn, `${path}[${i}]`));
  else if (value && typeof value === 'object') {
    fn(value, path);
    for (const [k, v] of Object.entries(value)) walk(v, fn, `${path}.${k}`);
  }
}

// ---------- 各項檢查 ----------

function checkRequired(node, rule, add) {
  const plain = rule.required.filter((r) => typeof r === 'string').concat(
    rule.required.filter((r) => r && typeof r === 'object' && r.path).map((r) => r.path));
  for (const entry of rule.required) {
    if (entry && typeof entry === 'object' && entry.anyOf) {
      checkAnyOf(node, entry.anyOf, add);
      continue;
    }
    const path = typeof entry === 'string' ? entry : entry.path;
    const exceptLast = typeof entry === 'object' && entry.exceptLast;
    const each = splitEach(path);
    if (each) {
      const items = getValues(node, each.base);
      items.forEach((item, i) => {
        if (exceptLast && i === items.length - 1) return;
        if (getValues(item, each.rest).length === 0)
          add('missing-required', `${each.base}[${i}].${each.rest}`, `缺必填欄位 ${each.base}[${i}].${each.rest}`);
      });
      continue;
    }
    // 父路徑本身也是必填且已缺，就不重複報子路徑
    const parent = path.includes('.') ? path.slice(0, path.lastIndexOf('.')) : null;
    if (parent && plain.includes(parent) && getValues(node, parent).length === 0) continue;
    if (getValues(node, path).length === 0) add('missing-required', path, `缺必填欄位 ${path}`);
  }
}

function checkAnyOf(node, paths, add) {
  const eachParts = paths.map(splitEach);
  if (eachParts.every((p) => p && p.base === eachParts[0].base)) {
    const items = getValues(node, eachParts[0].base);
    items.forEach((item, i) => {
      if (!eachParts.some((p) => getValues(item, p.rest).length > 0))
        add('missing-required', `${eachParts[0].base}[${i}]`,
          `${eachParts[0].base}[${i}] 缺必填欄位（需其一：${eachParts.map((p) => p.rest).join('、')}）`);
    });
    return;
  }
  if (!paths.some((p) => getValues(node, p).length > 0))
    add('missing-required', paths.join('|'), `缺必填欄位（需其一：${paths.join('、')}）`);
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/;

function checkDates(node, rule, add) {
  for (const spec of rule.dates || []) {
    for (const v of getValues(node, spec.path)) {
      if (typeof v !== 'string') { add('date-format', spec.path, `${spec.path} 不是字串：${JSON.stringify(v)}`); continue; }
      if (DATE_ONLY.test(v)) continue;
      const m = DATE_TIME.exec(v);
      if (!m) { add('date-format', spec.path, `${spec.path} 不是 ISO 8601 日期或日期時間：${v}`); continue; }
      if (spec.timeRequiresOffset && !m[4]) add('date-no-timezone', spec.path, `${spec.path} 有時間但沒有時區偏移：${v}`);
      if (spec.warnMidnight && m[1] === '00' && m[2] === '00' && (!m[3] || m[3] === '00'))
        add('date-midnight', spec.path, `${spec.path} 是午夜 00:00（不知道時間時應只寫日期）：${v}`, 'warning');
    }
  }
}

function checkLengths(node, rule, add) {
  for (const spec of rule.lengths || []) {
    if (spec.min === undefined && spec.max === undefined) continue;
    for (const v of getValues(node, spec.path)) {
      if (typeof v !== 'string') continue;
      const n = [...v].length;
      if ((spec.min !== undefined && n < spec.min) || (spec.max !== undefined && n > spec.max))
        add('length', spec.path, `${spec.path} 長度 ${n}，規定 ${spec.min ?? 0}–${spec.max ?? '∞'}`, spec.severity);
    }
  }
}

function checkMinItems(node, rule, add) {
  for (const spec of rule.minItems || []) {
    const n = getValues(node, spec.path).length;
    if (n > 0 && n < spec.min) add('min-items', spec.path, `${spec.path} 只有 ${n} 項，至少要 ${spec.min} 項`);
  }
}

function checkValues(node, rule, add) {
  for (const [path, spec] of Object.entries(rule.values || {})) {
    const re = new RegExp(spec.pattern);
    for (const v of getValues(node, path)) {
      if (typeof v === 'string' && !re.test(v)) add('value-format', path, `${path} 格式不符（${spec.note || spec.pattern}）：${v}`);
    }
  }
}

function checkRemovedProperties(node, rule, add) {
  for (const spec of rule.removedProperties || []) {
    const vals = getValues(node, spec.property);
    const hit = spec.valueType ? vals.some((v) => typesOf(v).includes(spec.valueType)) : vals.length > 0;
    if (hit) add('removed-property', spec.property, `${spec.property}${spec.valueType ? `（${spec.valueType}）` : ''}：${spec.note}`, spec.severity, spec.source);
  }
}

// ---------- 主函式 ----------

/**
 * @param {string} html
 * @param {{ page?: string, rules: object, site?: object }} opts
 * @returns {Array<{page:string, block:number|null, type:string|null, path:string|null, code:string, severity:string, message:string, source:string|null}>}
 */
export function validateHtml(html, { page = '', rules, site = {} }) {
  if (!rules || !rules.types) throw new Error('validateHtml: 缺 rules（請傳入 rules.json 內容）');
  const issues = [];
  const overrides = site.severity || {};
  const push = (issue) => {
    const sev = overrides[`${issue.code}:${issue.type}`] ?? overrides[issue.code] ?? issue.severity;
    if (sev === 'off') return;
    issues.push({ ...issue, severity: sev });
  };
  const g = rules.global || {};
  const blocks = extractJsonLd(html);
  const presentTypes = new Set();
  // optIn 規則（例如 ItemList 的 carousel 規則）只在站台設定該頁型 apply 時才套用
  const optedIn = new Set((site.pages || []).filter((e) => matchAny(page, [e.match])).flatMap((e) => e.apply || []));

  for (const b of blocks) {
    const base = { page, block: b.index };
    if (b.truncated) {
      push({ ...base, type: null, path: null, code: 'script-truncated', severity: g.scriptContent?.severity || 'error',
        message: 'JSON-LD 字串內含 </script>，瀏覽器與 Google 會在該處截斷，整塊失效（輸出前把 < 換成 \\u003c）',
        source: g.scriptContent?.source || null });
    } else if (b.parseError) {
      push({ ...base, type: null, path: null, code: 'json-parse', severity: g.jsonParse?.severity || 'error',
        message: `JSON 解析失敗：${b.parseError}`, source: g.jsonParse?.source || null });
      continue;
    }
    for (const seq of g.scriptContent?.forbiddenSequences || []) {
      if (seq === '</script') continue; // 已由截斷檢查處理
      if (b.raw.toLowerCase().includes(seq))
        push({ ...base, type: null, path: null, code: 'script-unsafe-sequence', severity: g.scriptContent.severity || 'error',
          message: `JSON-LD 內含 ${seq}，須跳脫為 \\u003c`, source: g.scriptContent.source });
    }

    // @context
    if (g.context) {
      for (const item of asArray(b.data)) {
        if (item && typeof item === 'object' && !g.context.expected.includes(item['@context']))
          push({ ...base, type: typesOf(item)[0] || null, path: '@context', code: 'context', severity: g.context.severity,
            message: `@context 應為 https://schema.org，實際：${JSON.stringify(item['@context'])}`, source: g.context.source });
      }
    }

    // 淘汰類型、絕對網址：整棵樹
    const abs = g.absoluteUrls;
    walk(b.data, (node, jpath) => {
      for (const t of typesOf(node)) {
        const dep = rules.deprecatedTypes?.[t];
        if (dep) push({ ...base, type: t, path: jpath, code: 'deprecated-type', severity: dep.severity,
          message: `${t}：${dep.status}（${dep.since}）。${dep.action}`, source: dep.source });
      }
      if (!abs) return;
      for (const prop of abs.properties) {
        for (const v of asArray(node[prop])) {
          if (typeof v !== 'string') continue;
          if (!/^https?:\/\/[^\s/]+/i.test(v))
            push({ ...base, type: typesOf(node)[0] || null, path: `${jpath}.${prop}`, code: 'relative-url', severity: abs.severity,
              message: `${prop} 不是絕對網址：${v}`, source: abs.source });
        }
      }
    });

    // 類型規則：頂層節點
    for (const node of topLevelNodes(b.data)) {
      const types = typesOf(node);
      types.forEach((t) => presentTypes.add(t));
      for (const [ruleName, rule] of Object.entries(rules.types)) {
        if (!types.some((t) => rule.match.includes(t))) continue;
        if (rule.optIn && !optedIn.has(ruleName)) continue;
        const add = (code, path, message, severity = 'error', source = rule.source) =>
          push({ ...base, type: ruleName === types[0] ? ruleName : `${types[0]}(${ruleName})`, path, code, severity, message, source });
        checkRequired(node, rule, add);
        checkDates(node, rule, add);
        checkLengths(node, rule, add);
        checkMinItems(node, rule, add);
        checkValues(node, rule, add);
        checkRemovedProperties(node, rule, add);
      }
    }
  }

  // 站台設定：頁型 → 必須有的類型
  for (const entry of site.pages || []) {
    if (!matchAny(page, [entry.match])) continue;
    for (const t of entry.require || []) {
      if (!presentTypes.has(t))
        push({ page, block: null, type: t, path: null, code: 'missing-page-type', severity: 'error',
          message: `此頁型（${entry.match}）必須輸出 ${t}`, source: null });
    }
    for (const t of entry.forbid || []) {
      if (presentTypes.has(t))
        push({ page, block: null, type: t, path: null, code: 'forbidden-page-type', severity: 'error',
          message: `此頁型（${entry.match}）不應輸出 ${t}`, source: null });
    }
  }
  return issues;
}

/** 依嚴重度過濾：minSeverity='error' 只留錯誤 */
export function filterIssues(issues, minSeverity = 'error') {
  return issues.filter((i) => SEVERITY_ORDER[i.severity] >= SEVERITY_ORDER[minSeverity]);
}

export function formatIssue(i) {
  return `[${i.severity}] ${i.page}${i.block !== null ? ` #${i.block}` : ''} ${i.type ?? '-'} ${i.code}: ${i.message}`;
}

// ---------- I/O（非純函式） ----------

export const RULES_PATH = fileURLToPath(new URL('./rules.json', import.meta.url));

export async function loadRules(path = RULES_PATH) {
  return JSON.parse(await readFile(path, 'utf8'));
}

export async function loadSiteConfig(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

/** dist 內 HTML 檔 → 頁面路徑：index.html→/、a/index.html→/a/、a/b.html→/a/b.html */
export function pagePathFromFile(distDir, file) {
  const rel = relative(distDir, file).split(sep).join('/');
  if (rel === 'index.html') return '/';
  if (rel.endsWith('/index.html')) return `/${rel.slice(0, -'index.html'.length)}`;
  return `/${rel}`;
}

async function listHtml(dir) {
  const out = [];
  for (const ent of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) out.push(...(await listHtml(p)));
    else if (ent.name.endsWith('.html')) out.push(p);
  }
  return out;
}

/**
 * 驗整個 build 輸出目錄。distDir 可為路徑字串或 astro:build:done 給的 dir（URL）。
 * @returns {{ pages: number, issues: object[] }}
 */
export async function validateDist(distDir, { rules, site = {} } = {}) {
  const dir = distDir instanceof URL ? fileURLToPath(distDir) : distDir;
  const ruleset = rules || (await loadRules());
  const issues = [];
  let pages = 0;
  for (const file of await listHtml(dir)) {
    const page = pagePathFromFile(dir, file);
    if (matchAny(page, site.exclude)) continue;
    pages++;
    issues.push(...validateHtml(await readFile(file, 'utf8'), { page, rules: ruleset, site }));
  }
  return { pages, issues };
}

// CLI：node validate.mjs <dist> [site-config.json] [--min=warning]
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const min = (args.find((a) => a.startsWith('--min=')) || '--min=error').slice(6);
  const [dist, cfg] = args.filter((a) => !a.startsWith('--'));
  if (!dist) { console.error('用法：node validate.mjs <dist> [jsonld-pages.json] [--min=error|warning|info]'); process.exit(2); }
  const site = cfg ? await loadSiteConfig(cfg) : {};
  const { pages, issues } = await validateDist(dist, { site });
  const shown = filterIssues(issues, min);
  for (const i of shown) console.log(formatIssue(i));
  const errors = filterIssues(issues, 'error').length;
  console.log(`JSON-LD：${pages} 頁，錯誤 ${errors}，顯示 ${shown.length} 則（>= ${min}）`);
  process.exitCode = errors ? 1 : 0;
}
