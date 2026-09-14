// 作物身分：批發市場代碼（MAM）→ 官方統一代碼 CROP_UID，蔬菜／水果／花卉全做。
//
// 為什麼需要規則：官方對應表只涵蓋全史 3,197 個代碼中的 1,718 個（交易量 96.63%）。
// 缺口幾乎全在花卉（2,195 個代碼只對上 1,055 個）與 114 年新增的進口細分代碼。
//
// ⚠ 三個實測踩到的坑，規則設計必須擋住（2026-09-12）：
//   1. 代碼前綴會跨種類重複：FB1 是蔬菜「花椰菜-青梗」，FB106 是花卉「火鶴花-丘比特」。
//      砍尾找母代碼若不檢查種類，346 筆裡有 268 筆會對到別的作物（火鶴花 → 花椰菜）。
//   2. 來源的「作物名稱」可能是 null（L1 有 4,225 列），而統一代碼表剛好有 1 筆 CNAME 是空字串。
//      名稱比對若不擋空值，233 個代碼會全部誤對到同一筆「農產品加工類」。
//   3. tc_type（N04/N05/N06）與 PLV1_NAME（蔬菜類/果樹類/花卉類）**不是同一套分類**：
//      西瓜在交易站是水果、官方是蔬菜類；玉米在交易站是蔬菜、官方是雜糧類。
//      所以種類檢查只能用來擋「自己推導出來的」對應，不能用來否決官方對應表。
//
// 產出：
//   data/identity/crop-map.parquet        代碼 → CROP_UID，含 rule / confidence
//   data/identity/review-queue.ndjson     confidence < 0.8 的，依交易量排序等人工判斷
//
// 用法：
//   node transform/identify.mjs           # 重算對應表
//   node transform/identify.mjs --report  # 只印報告，不寫檔
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect, q, RAW, DATA, ROOT, readL1, num } from './_db.mjs';

const IDENTITY = join(DATA, 'identity');
const OVERRIDES = join(ROOT, 'overrides');
const loadGz = async (p) => JSON.parse(gunzipSync(await readFile(p)).toString());
const loadJson = async (p, fallback) => JSON.parse(await readFile(p, 'utf8').catch(() => JSON.stringify(fallback)));

// confidence >= 0.8 才自動採用（沿用 seh.tw ARCHITECTURE §3 的門檻）
const RULES = [
  { id: 'override', confidence: 1.0, note: '人工指定（overrides/crop-code-map.json），優先於一切' },
  { id: 'official-crosswalk', confidence: 1.0, note: '官方對應表直接命中。權威來源，不做種類檢查（見坑 3）' },
  { id: 'other-bucket', confidence: 1.0, note: '名稱本身是「其他」的收攏桶，不對到具體作物' },
  { id: 'import-prefix', confidence: 0.9, note: 'I 開頭 → 同碼 F 開頭（進口花卉），需種類相符' },
  { id: 'parent-code', confidence: 0.85, note: '去尾 1–3 碼對上母代碼，需種類相符（不檢查會大量錯配）' },
  { id: 'name-exact', confidence: 0.85, note: '名稱去品種後綴後與統一名稱相同，需名稱非空且種類相符' },
  { id: 'no-source-name', confidence: 0.0, note: '來源沒給作物名稱或種類代碼，資訊不足，不硬對' },
  { id: 'unmapped', confidence: 0.0, note: '對不上，進 review queue' },
];
const CONF = Object.fromEntries(RULES.map((r) => [r.id, r.confidence]));

// tc_type → 官方 PLV1 大類。只用於檢查自己推導的對應，不用於官方對應表。
const EXPECT_PLV1 = { N04: '蔬菜類', N05: '果樹類', N06: '花卉類' };
const baseName = (nm) => (nm ?? '').split(/[-（(]/)[0].trim();
// 收攏桶：名稱本身就是「其他」（OX1 其他、FA0 其他花類）。
// 「柚子-其他」不算——那是具體作物的其他品種，要對到柚子。
const isOtherBucket = (nm) => /^其他/.test((nm ?? '').trim());

async function main() {
  const report = process.argv.includes('--report');
  const con = await connect();

  const crosswalk = await loadGz(join(RAW, 'crop-crosswalk.json.gz'));
  const unified = await loadGz(join(RAW, 'crop-unified.json.gz'));
  const overrides = await loadJson(join(OVERRIDES, 'crop-code-map.json'), {});

  const mam = new Map();
  for (const r of crosswalk) if (r.SRC_SYS_ID === 'MAM') mam.set(r.SRC_ID.trim(), r.CROP_UID);
  const uid = new Map(unified.map((u) => [u.CROP_UID, u]));
  const byName = new Map();
  for (const u of unified) {
    const n = (u.CNAME ?? '').trim();
    if (n && !byName.has(n)) byName.set(n, u.CROP_UID);   // 空 CNAME 一定要排除（坑 2）
  }

  // 推導出的對應要通過種類檢查；查不到 PLV1 或 tc_type 不在表內時，視為不通過（保守）
  const plv1Ok = (tc, candidateUid) => {
    const want = EXPECT_PLV1[tc];
    if (!want) return false;
    return uid.get(candidateUid)?.PLV1_NAME === want;
  };
  const parentOf = (code, tc) => {
    for (const cut of [1, 2, 3]) {
      const p = code.slice(0, -cut);
      if (p.length && mam.has(p) && plv1Ok(tc, mam.get(p))) return p;
    }
    return null;
  };

  const codes = await q(con, `SELECT "種類代碼" tc, "作物代號" code, any_value("作物名稱") nm,
      sum("交易量") vol, count(*)::VARCHAR n, min("交易日期") first_seen, max("交易日期") last_seen
    FROM ${readL1()} WHERE "作物代號" <> 'rest' GROUP BY 1, 2`);

  const rows = [];
  for (const c of codes) {
    const code = c.code, nm = c.nm ?? '', tc = c.tc ?? '';
    let rule = 'unmapped', cropUid = null, via = null;
    const importCode = code.startsWith('I') ? 'F' + code.slice(1) : null;

    if (overrides[code]) { rule = 'override'; cropUid = overrides[code]; }
    else if (mam.has(code)) { rule = 'official-crosswalk'; cropUid = mam.get(code); }
    else if (isOtherBucket(nm)) { rule = 'other-bucket'; }
    else if (!nm.trim() || !tc) { rule = 'no-source-name'; }          // 坑 2：資訊不足就不硬對
    else if (importCode && mam.has(importCode) && plv1Ok(tc, mam.get(importCode))) {
      rule = 'import-prefix'; cropUid = mam.get(importCode); via = importCode;
    } else {
      const p = parentOf(code, tc);                                    // 坑 1：內含種類檢查
      const bn = baseName(nm);
      if (p) { rule = 'parent-code'; cropUid = mam.get(p); via = p; }
      else if (bn && byName.has(bn) && plv1Ok(tc, byName.get(bn))) {
        rule = 'name-exact'; cropUid = byName.get(bn); via = bn;
      }
    }

    let u = cropUid ? uid.get(cropUid) : null;
    // 對到的統一代碼若沒有作物層名稱（PLV3 為 000，代表「該大類下未指定作物」），
    // 那不是一個可以成頁的作物身分——退回 unmapped，不要產出無名作物（實測會生出 name 空白的頁面）
    if (u && !(u.PLV3_NAME ?? '').trim() && rule !== 'override') {
      rule = 'unmapped'; cropUid = null; via = null; u = null;
    }
    rows.push({
      tc_type: tc, crop_code: code, crop_name: nm,
      crop_uid: cropUid, rule, confidence: CONF[rule], via,
      plv1: u?.PLV1_NAME ?? null, plv3: u?.PLV3_NAME ?? null, plv4: u?.PLV4_NAME ?? null,
      plv3_key: cropUid ? cropUid.slice(0, 11) : null,   // PLV3 前綴 = 三層價格對齊的粒度
      volume: num(c.vol) ?? 0, rows: Number(c.n), first_seen: c.first_seen, last_seen: c.last_seen,
    });
  }

  // ── 報告
  const totalVol = rows.reduce((s, r) => s + r.volume, 0) || 1;
  const agg = new Map();
  for (const r of rows) {
    const a = agg.get(r.rule) ?? { codes: 0, volume: 0, mismatch: 0 };
    a.codes++; a.volume += r.volume;
    if (r.crop_uid && EXPECT_PLV1[r.tc_type] && r.plv1 !== EXPECT_PLV1[r.tc_type]) a.mismatch++;
    agg.set(r.rule, a);
  }
  console.error(`代碼 ${rows.length} 個，交易量 ${Math.round(totalVol).toLocaleString()} 公斤`);
  for (const { id, confidence } of RULES) {
    const a = agg.get(id);
    if (a) console.error(`  ${id.padEnd(19)} conf=${confidence.toFixed(2)} ${String(a.codes).padStart(5)} 代碼  交易量 ${(a.volume / totalVol * 100).toFixed(2)}%  種類不符 ${a.mismatch}`);
  }
  const auto = rows.filter((r) => r.confidence >= 0.8);
  console.error(`自動採用（conf >= 0.8）：${auto.length} 代碼 / 交易量 ${(auto.reduce((s, r) => s + r.volume, 0) / totalVol * 100).toFixed(2)}%`);

  // 自我檢查：推導規則的種類不符應該是 0；官方對應表允許不符（兩套分類本來就不同）
  const derived = ['import-prefix', 'parent-code', 'name-exact'];
  const leak = rows.filter((r) => derived.includes(r.rule) && EXPECT_PLV1[r.tc_type] && r.plv1 !== EXPECT_PLV1[r.tc_type]);
  console.error(leak.length === 0
    ? '自我檢查：推導規則的種類一致性 OK（0 筆不符）'
    : `⚠ 自我檢查失敗：推導規則有 ${leak.length} 筆種類不符 → ${leak.slice(0, 3).map((r) => `${r.crop_code}(${r.crop_name})→${r.plv3}`).join(', ')}`);
  const officialMismatch = agg.get('official-crosswalk')?.mismatch ?? 0;
  console.error(`官方對應表種類不符 ${officialMismatch} 筆（預期現象：西瓜屬蔬菜類、玉米屬雜糧類，非錯誤）`);

  for (const [tc, label] of [['N04', '蔬菜'], ['N05', '水果'], ['N06', '花卉'], ['', '種類為 null']]) {
    const rs = rows.filter((r) => r.tc_type === tc);
    if (!rs.length) continue;
    const ok = rs.filter((r) => r.confidence >= 0.8);
    const v = rs.reduce((s, r) => s + r.volume, 0) || 1;
    console.error(`  ${(tc || 'NULL').padEnd(5)} ${label.padEnd(10)} ${ok.length}/${rs.length} 代碼  交易量 ${(ok.reduce((s, r) => s + r.volume, 0) / v * 100).toFixed(1)}%`);
  }
  if (report) return;

  await mkdir(IDENTITY, { recursive: true });
  const tmp = join(IDENTITY, 'crop-map.json');
  await writeFile(tmp, JSON.stringify(rows));
  await con.run(`COPY (SELECT * FROM read_json_auto('${tmp}')) TO '${join(IDENTITY, 'crop-map.parquet')}' (FORMAT parquet, COMPRESSION zstd)`);

  const queue = rows.filter((r) => r.confidence < 0.8)
    .sort((a, b) => b.volume - a.volume)
    .map((r, i) => ({
      id: `rq_crop_${String(i + 1).padStart(4, '0')}`,
      kind: r.rule === 'no-source-name' ? 'crop-no-source-name' : 'crop-unmapped',
      payload: { tc_type: r.tc_type, crop_code: r.crop_code, crop_name: r.crop_name, volume: Math.round(r.volume), first_seen: r.first_seen, last_seen: r.last_seen },
      suggested: null, status: 'open', decidedAt: null,
    }));
  await writeFile(join(IDENTITY, 'review-queue.ndjson'), queue.map((x) => JSON.stringify(x)).join('\n') + '\n');
  await writeFile(join(IDENTITY, 'identity.meta.json'), JSON.stringify({
    builtAt: new Date().toISOString(), codes: rows.length,
    autoAccepted: auto.length, reviewQueue: queue.length,
    byRule: Object.fromEntries([...agg].map(([k, v]) => [k, { codes: v.codes, volumeShare: +(v.volume / totalVol * 100).toFixed(2) }])),
    derivedCategoryLeak: leak.length, officialCategoryMismatch: officialMismatch,
  }, null, 1) + '\n');
  console.error(`review queue：${queue.length} 筆 → data/identity/review-queue.ndjson`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
