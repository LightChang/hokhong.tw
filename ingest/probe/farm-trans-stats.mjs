// 回補資料統計：回答 README §7 第 2–4 項。
// 用法：node --max-old-space-size=8192 ingest/probe/farm-trans-stats.mjs > ingest/probe/farm-trans-stats.json
// 讀 ingest/raw/farm-trans/**.json.gz 與 ingest/raw/market-rest-farm.json.gz，不寫其他檔。
import { readdir, readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const RAW = join(dirname(fileURLToPath(import.meta.url)), '..', 'raw');
const load = async (p) => JSON.parse(gunzipSync(await readFile(p)).toString());
const TYPE = { 蔬菜: 'N04', 水果: 'N05', 花卉: 'N06' };
const span = (m, k, d) => {
  const s = m.get(k);
  if (!s) m.set(k, { first: d, last: d, rows: 1 });
  else { s.last = d; s.rows++; }
};

// 官方休市日曆 → Set("N04|104|2026-09-07")
const restCal = new Set();
for (const r of await load(join(RAW, 'market-rest-farm.json.gz'))) {
  const y = Number(r.YearMonth.slice(0, 3)) + 1911, m = r.YearMonth.slice(3);
  for (const d of r.ClosedDate.split('、').map((s) => s.trim()).filter(Boolean))
    restCal.add(`${TYPE[r.MarketType]}|${r.MarketNo}|${y}-${m}-${d.padStart(2, '0')}`);
}

const dir = join(RAW, 'farm-trans');
const files = [];
for (const y of (await readdir(dir)).filter((n) => /^\d{4}$/.test(n)).sort())
  for (const f of (await readdir(join(dir, y))).sort()) files.push({ date: f.slice(0, 10), path: join(dir, y, f) });

const perYear = {};
const markets = new Map();        // "N04|104|台北二" → span
const codeNames = new Map();      // "N04|FA1" → Map(name → span)
const nameCodes = new Map();      // "N04|黃秋葵" → Set(code)
const restRecord = new Set();     // "N04|104|date"
const traded = new Set();         // "N04|104|date"
let rows = 0, nullType = 0, dupKeys = 0, emptyDays = 0;
const nullTypeSample = [];

for (const { date, path } of files) {
  const data = await load(path);
  const y = date.slice(0, 4);
  perYear[y] ??= { days: 0, emptyDays: 0, rows: 0 };
  perYear[y].days++;
  if (data.length === 0) { emptyDays++; perYear[y].emptyDays++; }
  const seen = new Set();
  for (const r of data) {
    rows++; perYear[y].rows++;
    const t = r['種類代碼'];
    if (t == null) { nullType++; if (nullTypeSample.length < 5) nullTypeSample.push(r); continue; }
    const mk = `${t}|${r['市場代號']}`;
    const key = `${mk}|${r['作物代號']}`;
    if (seen.has(key)) dupKeys++;
    seen.add(key);
    span(markets, `${mk}|${r['市場名稱']}`, date);
    if (r['作物代號'] === 'rest') { restRecord.add(`${mk}|${date}`); continue; }
    traded.add(`${mk}|${date}`);
    const ck = `${t}|${r['作物代號']}`;
    if (!codeNames.has(ck)) codeNames.set(ck, new Map());
    span(codeNames.get(ck), r['作物名稱'], date);
    const nk = `${t}|${r['作物名稱']}`;
    if (!nameCodes.has(nk)) nameCodes.set(nk, new Set());
    nameCodes.get(nk).add(r['作物代號']);
  }
}

// 休市判別：以「有交易過的 (種類, 市場)」在其活躍期間內的每一天分類
const first = files[0]?.date, last = files.at(-1)?.date;
const activeMk = new Map();
for (const [k, s] of markets) {
  const mk = k.split('|').slice(0, 2).join('|');
  const a = activeMk.get(mk);
  activeMk.set(mk, { first: a && a.first < s.first ? a.first : s.first, last: a && a.last > s.last ? a.last : s.last });
}
const restMatrix = {};
for (const [mk, s] of activeMk) {
  const c = { traded: 0, restRecordAndCal: 0, restRecordOnly: 0, calOnlyNoRows: 0, missing: 0, tradedOnCalRest: 0 };
  for (let d = new Date(`${s.first}T00:00:00Z`); d.toISOString().slice(0, 10) <= s.last; d.setUTCDate(d.getUTCDate() + 1)) {
    const k = `${mk}|${d.toISOString().slice(0, 10)}`;
    const cal = restCal.has(k), rec = restRecord.has(k), tr = traded.has(k);
    if (tr) { c.traded++; if (cal) c.tradedOnCalRest++; }
    else if (rec) cal ? c.restRecordAndCal++ : c.restRecordOnly++;
    else cal ? c.calOnlyNoRows++ : c.missing++;
  }
  restMatrix[mk] = { ...s, ...c };
}

const multiName = [...codeNames].filter(([, m]) => m.size > 1)
  .map(([k, m]) => ({ code: k, names: Object.fromEntries([...m].sort((a, b) => a[1].first.localeCompare(b[1].first))) }));
const multiCode = [...nameCodes].filter(([, s]) => s.size > 1).map(([k, s]) => ({ name: k, codes: [...s] }));
const codesPerType = {};
for (const k of codeNames.keys()) { const t = k.split('|')[0]; codesPerType[t] = (codesPerType[t] ?? 0) + 1; }

console.log(JSON.stringify({
  range: { first, last, files: files.length, emptyDays },
  rows, nullType, nullTypeSample, dupKeys, perYear, codesPerType,
  markets: Object.fromEntries([...markets].sort()),
  codeWithMultipleNames: { count: multiName.length, items: multiName },
  nameWithMultipleCodes: { count: multiCode.length, items: multiCode },
  restMatrix,
}, null, 1));
