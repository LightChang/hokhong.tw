// 節日用花：往年過年、清明、中元、母親節前，哪些花到貨變多、一把貴了多少
//
// 站主 2026-11-24 同意擴大到花卉，對象是花店、拜拜與母親節買花的人。「拜拜用什麼花」是民俗，
// 查不到可逐頁核對的官方說法，所以這裡不講「該買什麼」，只講批發市場實際發生過的事：
// 往年節前兩週，全國花卉市場哪些花的日均到貨比一個月前多、價格比一個月前高或低。
// 到貨變多代表大家在那幾天真的買它，比民俗清單可靠，而且每天會跟著資料更新。
//
// 節前窗 = 節日前 14 天到前 1 天；基準窗 = 節前 43 到 29 天（跟 festival.mjs 同一段，
// 避開節前漲勢又不離太遠）。兩窗都至少 MIN_DAYS 個交易日才算那一年。
// 這是「節前跟一個月前比」的原始變化，含季節走勢，不扣對照年：清明、母親節是固定國曆，
// 同曆日每年都離節日一樣近，找不到對照年（festival.mjs 檔頭有同樣的說明）。頁面因此只寫
// 「往年節前兩週比一個月前」，不寫成「節日造成的漲幅」。
//
// 擋門（2026-11-24 訂，照當時全國花卉的分佈）：
//   至少 MIN_YEARS 年算得出來；基準窗日均到貨至少 MIN_BASE_VOL 把（擋掉冷門花，冷門花
//   多兩把就是 +50%）；到貨中位數多 MIN_VOL_UP% 以上、而且一半以上的年份都多這麼多，才列進清單。
//
// 產出 data/page/festival-flower.json：
//   { lastDate, byFestival: { cny|qingming|zhongyuan|mothers: { name, label, flowers: [...] } }, byCrop: { <plv3_key>: { <id>: {...} } } }
//
// 用法：node transform/festival-flower.mjs（要在 emit-page 之後，才讀得到花卉品項頁的最近價格）
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect, q, DATA, ROOT } from './_db.mjs';

const PAGE = join(DATA, 'page');
const AGG = join(DATA, 'agg');
const PRE_FROM = 14, PRE_TO = 1;
const BASE_FROM = 43, BASE_TO = 29;
const MIN_DAYS = 5;
const MIN_YEARS = 8;
const MIN_BASE_VOL = 1000;     // 把／交易日（全國合計）
const MIN_VOL_UP = 20;         // %
const TOP = 8;

// 母親節：五月第二個星期日（國曆，不在 festivals.json 裡，用算的）
const mothersDay = (y) => {
  const d = new Date(Date.UTC(y, 4, 1));
  const firstSun = 1 + ((7 - d.getUTCDay()) % 7);
  return `${y}-05-${String(firstSun + 7).padStart(2, '0')}`;
};
// page = 有節日頁的網址 id（母親節沒有節日頁，只在花卉頁講）
const TYPES = [
  { id: 'cny', key: 'eve', name: '過年', label: '除夕', page: 'cny' },
  { id: 'qingming', key: 'qingming', name: '清明', label: '清明', page: 'qingming' },
  { id: 'zhongyuan', key: 'zhongyuan', name: '中元普渡', label: '中元', page: 'zhongyuan' },
  { id: 'mothers', key: null, name: '母親節', label: '母親節', page: null },
];

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
};
const addDays = (iso, n) => new Date(Date.parse(iso) + n * 86_400_000).toISOString().slice(0, 10);

async function main() {
  await mkdir(PAGE, { recursive: true });
  const con = await connect();
  const { festivals } = JSON.parse(await readFile(join(ROOT, 'overrides', 'festivals.json'), 'utf-8'));
  const idx = JSON.parse(await readFile(join(PAGE, 'index.json'), 'utf-8'));
  // 花卉品項 → 站上的品項頁（同一 plv3_key 只取一筆）
  const cropByKey = new Map(idx.crops.filter((c) => c.tcType === 'N06').map((c) => [c.plv3Key, c]));

  const rows = await q(con, `SELECT plv3_key, plv3, trans_date::VARCHAR AS d,
        sum(volume) AS v, sum(wavg_price * volume) / sum(volume) AS p
      FROM read_parquet('${join(AGG, 'plv3_day.parquet')}')
     WHERE tc_type = 'N06' AND volume > 0 AND wavg_price > 0
     GROUP BY 1, 2, 3`);
  const lastDate = rows.reduce((m, r) => (r.d > m ? r.d : m), '');
  const byKey = new Map();
  for (const r of rows) {
    if (!byKey.has(r.plv3_key)) byKey.set(r.plv3_key, { plv3: r.plv3, days: new Map() });
    byKey.get(r.plv3_key).days.set(r.d, { v: Number(r.v), p: Number(r.p) });
  }

  const win = (days, date, from, to) => {
    let v = 0, pv = 0, n = 0;
    for (let k = from; k >= to; k--) {
      const e = days.get(addDays(date, -k));
      if (!e) continue;
      v += e.v; pv += e.p * e.v; n++;
    }
    return n >= MIN_DAYS ? { perDay: v / n, price: pv / v, n } : null;
  };

  const byFestival = {}, byCrop = {};
  for (const t of TYPES) {
    const dates = t.key
      ? festivals.map((f) => f[t.key]).filter(Boolean)
      : festivals.map((f) => mothersDay(f.year));
    const done = dates.filter((d) => d <= lastDate);
    const list = [];
    for (const [key, c] of byKey) {
      const yrs = [];
      for (const d of done) {
        const pre = win(c.days, d, PRE_FROM, PRE_TO), base = win(c.days, d, BASE_FROM, BASE_TO);
        if (!pre || !base) continue;
        yrs.push({ year: Number(d.slice(0, 4)), baseVol: base.perDay,
          volPct: (pre.perDay / base.perDay - 1) * 100, pricePct: (pre.price / base.price - 1) * 100 });
      }
      if (yrs.length < MIN_YEARS) continue;
      if (median(yrs.map((y) => y.baseVol)) < MIN_BASE_VOL) continue;
      const volPct = median(yrs.map((y) => y.volPct));
      const pricePct = median(yrs.map((y) => y.pricePct));
      const upYears = yrs.filter((y) => y.volPct >= MIN_VOL_UP).length;
      const stat = {
        years: yrs.length, upYears, from: Math.min(...yrs.map((y) => y.year)), to: Math.max(...yrs.map((y) => y.year)),
        volPct: Math.round(volPct), pricePct: Math.round(pricePct),
      };
      const listed = volPct >= MIN_VOL_UP && upYears >= yrs.length / 2;
      const crop = cropByKey.get(key);
      if (listed && crop) {
        const doc = await readFile(join(PAGE, 'crop', `${crop.slug}.json`), 'utf-8').then(JSON.parse).catch(() => null);
        // 最近一個有成交的交易日（跟品項頁 h1 下那句同一個數字）
        const dayMap = new Map();
        for (const r of doc?.daily90 ?? []) {
          if (!(r.price > 0 && r.volume > 0)) continue;
          const a = dayMap.get(r.d) ?? { pv: 0, v: 0 };
          a.pv += r.price * r.volume; a.v += r.volume; dayMap.set(r.d, a);
        }
        const lastD = [...dayMap.keys()].sort().at(-1);
        list.push({
          key, slug: crop.slug, name: crop.name, ...stat,
          day: lastD ? { date: lastD, price: +(dayMap.get(lastD).pv / dayMap.get(lastD).v).toFixed(1) } : null,
          change: doc?.change ? { xun: doc.change.xun, pct: doc.change.changePct, baseline: doc.change.baseline3y } : null,
        });
      }
      if (listed) {
        byCrop[key] ??= {};
        byCrop[key][t.id] = stat;
      }
    }
    list.sort((a, b) => b.volPct - a.volPct);
    const next = dates.filter((d) => d > lastDate).sort()[0] ?? (t.key ? null : mothersDay(Number(lastDate.slice(0, 4)) + 1));
    byFestival[t.id] = { name: t.name, label: t.label, page: t.page, next, flowers: list.slice(0, TOP) };
  }

  const out = {
    builtAt: new Date().toISOString(), lastDate,
    definition: { pre: [PRE_FROM, PRE_TO], base: [BASE_FROM, BASE_TO], minYears: MIN_YEARS, minBaseVol: MIN_BASE_VOL, minVolUp: MIN_VOL_UP },
    byFestival, byCrop,
  };
  await writeFile(join(PAGE, 'festival-flower.json'), JSON.stringify(out));
  for (const [id, f] of Object.entries(byFestival)) {
    console.error(`  ${f.name.padEnd(5)} 下次 ${f.next ?? '—'}　${f.flowers.length} 種：`
      + f.flowers.map((x) => `${x.name} 量 +${x.volPct}%／價 ${x.pricePct > 0 ? '+' : ''}${x.pricePct}%（${x.upYears}/${x.years}）`).join('、'));
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
