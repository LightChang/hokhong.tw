#!/usr/bin/env node
// 從香港天文台「公曆與農曆日期對照表」產生 overrides/lunar-calendar.json（每週菜單用的節日與節氣日期）。
//
// 為什麼不用程式算農曆：ICU／各種農曆套件在朔日接近午夜時會差一天（2027 春節就是，見 overrides/festivals.json _note），
// 本站一律以天文台表為準。天文台表是公開的逐年純文字檔：
//   https://www.hko.gov.hk/tc/gts/time/calendar/text/files/T<年>c.txt
//
//   node scripts/hko-calendar.mjs 2025 2026 2027 2028     # 抓這幾年、覆寫 overrides/lunar-calendar.json
//   node scripts/hko-calendar.mjs --dir=/path 2025 ...    # 改讀本機已下載的 T<年>c.txt
//
// 年份要連續（前一年的表才知道新年第一天屬於哪個農曆月）。每年年底補下一年再跑一次。
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const args = process.argv.slice(2);
const dir = args.find((a) => a.startsWith('--dir='))?.slice(6);
const years = args.filter((a) => /^\d{4}$/.test(a)).map(Number).sort();
if (!years.length) { console.error('用法：node scripts/hko-calendar.mjs 2025 2026 2027 2028'); process.exit(2); }

const MONTHS = ['正月', '二月', '三月', '四月', '五月', '六月', '七月', '八月', '九月', '十月', '十一月', '十二月'];
const DAYS = ['初一', '初二', '初三', '初四', '初五', '初六', '初七', '初八', '初九', '初十',
  '十一', '十二', '十三', '十四', '十五', '十六', '十七', '十八', '十九', '二十',
  '廿一', '廿二', '廿三', '廿四', '廿五', '廿六', '廿七', '廿八', '廿九', '三十'];
// 農曆節點（月、日）。除夕另算（十二月最後一天）。
const LUNAR = {
  cny: [1, 1], tiangong: [1, 9], yuanxiao: [1, 15], tianchuan: [1, 20], touya: [2, 2], mazu: [3, 23],
  duanwu: [5, 5], qixi: [7, 7], zhongyuan: [7, 15], midAutumn: [8, 15], chongyang: [9, 9],
  weiya: [12, 16], songshen: [12, 24],
};

const rows = [];
for (const y of years) {
  const url = `https://www.hko.gov.hk/tc/gts/time/calendar/text/files/T${y}c.txt`;
  const text = dir ? await readFile(join(dir, `T${y}c.txt`), 'utf-8')
    : await fetch(url, { headers: { 'user-agent': 'hokhong.tw-maint (+https://hokhong.tw)' } }).then((r) => {
      if (!r.ok) throw new Error(`${url} → ${r.status}`); return r.text();
    });
  for (const line of text.split(/\r?\n/)) {
    const m = /^(\d{4})年(\d{1,2})月(\d{1,2})日\s+(\S+)\s+星期\S\s*(\S*)/.exec(line.trim());
    if (!m) continue;
    const date = `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
    rows.push({ date, lunar: m[4], term: m[5] || null });
  }
}

// 逐日走：遇到月份標記（正月、閏六月…）就是該月初一；其餘是日名。第一個月份標記之前的日子無法判定月份，略過。
let month = null, leap = false;
const out = { terms: [], lunar: [] };
for (const r of rows) {
  let day;
  const mk = r.lunar.replace(/^閏/, '');
  if (MONTHS.includes(mk)) { month = MONTHS.indexOf(mk) + 1; leap = r.lunar.startsWith('閏'); day = 1; }
  else day = DAYS.indexOf(r.lunar) + 1;
  if (r.term) out.terms.push({ name: r.term, date: r.date });
  if (!month || day < 1) continue;
  r.m = month; r.d = day; r.leap = leap;
}
for (let i = 0; i < rows.length; i++) {
  const r = rows[i];
  if (!r.m || r.leap) continue;
  for (const [id, [m, d]] of Object.entries(LUNAR)) if (r.m === m && r.d === d) out.lunar.push({ id, date: r.date });
  // 除夕：下一天是正月初一
  if (rows[i + 1]?.m === 1 && rows[i + 1]?.d === 1) out.lunar.push({ id: 'eve', date: r.date });
}
out.lunar.sort((a, b) => a.date.localeCompare(b.date));

await writeFile(new URL('../overrides/lunar-calendar.json', import.meta.url), JSON.stringify({
  _what: '每週菜單用的農曆節點與二十四節氣的國曆日期。由 scripts/hko-calendar.mjs 從香港天文台逐年對照表產生，不要手改。',
  _source: 'https://www.hko.gov.hk/tc/gts/time/calendar/text/files/T<年>c.txt',
  _generatedAt: new Date().toISOString().slice(0, 10),
  years,
  lunar: out.lunar,
  terms: out.terms,
}, null, 1) + '\n');
console.log(`農曆節點 ${out.lunar.length} 筆、節氣 ${out.terms.length} 筆（${years[0]}–${years.at(-1)}）`);
