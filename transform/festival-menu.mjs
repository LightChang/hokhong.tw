// 節日菜單的食材，接上價格：這個節日要買的東西，現在哪些便宜、哪些要提前買
//
// 站上有價格，但使用者要買的是一頓飯。菜色與食材的對應寫在 overrides/festival-menu.json
// （文化知識，不在任何政府開放資料裡）；這一支只做兩件事：
//   1. 把俗名解析成站上的品項，**對不到就當場報錯**——寧可壞掉，不要靜靜漏掉一樣食材
//   2. 接上現在的價格、跟常年同旬比、產季、以及該節日的漲幅往例（festival.json）
//
// 「什麼時候買」的判斷只用兩件已經算好的事實：
//   該品項在這個節日前的漲幅往例（有往例才講，沒有就不講）
//   現在比常年同旬便宜或貴
// 不自己發明新的預測。
//
// 產出 data/page/festival-menu.json
//
// 用法：node transform/festival-menu.mjs
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA, ROOT, today } from './_db.mjs';

const PAGE = join(DATA, 'page');

const rd = (v, n = 1) => (v == null ? null : +Number(v).toFixed(n));

async function main() {
  await mkdir(PAGE, { recursive: true });
  const menu = JSON.parse(await readFile(join(ROOT, 'overrides', 'festival-menu.json'), 'utf-8'));
  const idx = JSON.parse(await readFile(join(PAGE, 'index.json'), 'utf-8'));
  const meatIdx = JSON.parse(await readFile(join(PAGE, 'meat', 'index.json'), 'utf-8'));
  const fes = await readFile(join(PAGE, 'festival.json'), 'utf-8').then(JSON.parse).catch(() => null);
  const prof = await readFile(join(PAGE, 'crop-profile.json'), 'utf-8').then(JSON.parse).catch(() => null);
  const cal = JSON.parse(await readFile(join(ROOT, 'overrides', 'lunar-calendar.json'), 'utf-8'));
  const recipeFile = JSON.parse(await readFile(join(ROOT, 'overrides', 'recipes.json'), 'utf-8'));

  // 俗名 → 品項。蔬果比對俗名與官方名，同名多筆時取可收錄且交易量大的那筆（火龍果有兩筆）
  const cropByName = new Map();
  for (const c of idx.crops) {
    for (const key of [c.name, c.official]) {
      if (!key) continue;
      const prev = cropByName.get(key);
      if (!prev || (c.indexable && !prev.indexable)) cropByName.set(key, c);
    }
  }
  // 肉蛋：表裡寫的是原料級的名字（毛豬、白肉雞、紅羽土雞、鴨蛋…），對到代表性的那一筆
  const meatAlias = {
    毛豬: 'hog', 白肉雞: 'broiler-18kg', 紅羽土雞: 'red-chicken-c-m',
    雞蛋: 'egg-farm', 鴨蛋: 'duck-egg', 正番鴨: 'muscovy-duck', 土番鴨: 'mule-duck', 肉鵝: 'goose',
  };
  const meatBySlug = new Map(meatIdx.items.map((m) => [m.slug, m]));

  const cropCache = new Map();
  const readCrop = async (slug) => {
    if (!cropCache.has(slug)) {
      cropCache.set(slug, await readFile(join(PAGE, 'crop', `${slug}.json`), 'utf-8').then(JSON.parse).catch(() => null));
    }
    return cropCache.get(slug);
  };

  const errors = [];

  // 一組菜色 → 解析好的菜與食材（節日、民俗節點、季節頁、每週菜單共用同一套，資料同源）
  // key2 只用來查「這個節日前的漲幅往例」，季節頁沒有往例就傳 null。
  const resolve = async (label, list, key2) => {
    const dishes = [];
    const seen = new Map();          // 同一頁裡食材去重，但記住哪幾道菜要用
    for (const d of list) {
      const items = [];
      for (const name of d.have) {
        const crop = cropByName.get(name);
        const meatSlug = meatAlias[name];
        if (!crop && !meatSlug) {
          // 表裡寫了一個站上沒有的名字：一定要吵，不能靜靜跳過
          errors.push(`${label}／${d.dish}：食材「${name}」對不到任何品項（要嘛改名字，要嘛移到 noPrice）`);
          continue;
        }
        const key = crop ? `crop:${crop.slug}` : `meat:${meatSlug}`;
        if (!seen.has(key)) {
          let item;
          if (crop) {
            const doc = await readCrop(crop.slug);
            const p = prof?.byCrop?.[`${crop.tcType}|${crop.plv3Key}`] ?? null;
            item = {
              kind: 'crop', slug: crop.slug, name: crop.name, path: `/crop/${crop.slug}/`,
              indexable: crop.indexable,
              changePct: doc?.change?.changePct ?? null,
              price: doc?.latest?.price ?? null,
              retailPerCatty: doc?.retail?.perCatty ?? null,
              seasonLabel: p?.season?.yearRound ? '全年' : (p?.season?.label ?? null),
              inSeason: p?.season ? (p.season.yearRound || p.season.months.includes(Number(today().slice(5, 7)))) : null,
              // 這個節日前會不會漲：只有算得出往例才講
              festivalPct: key2 ? fes?.byCrop?.[crop.plv3Key]?.[key2]?.medianPeakPct ?? null : null,
              festivalDaysBefore: key2 ? fes?.byCrop?.[crop.plv3Key]?.[key2]?.medianDaysBefore ?? null : null,
            };
          } else {
            const m = meatBySlug.get(meatSlug);
            if (!m) { errors.push(`${label}／${d.dish}：肉蛋別名「${name}」指向 ${meatSlug}，但 meat/index.json 沒有這個品項`); continue; }
            item = {
              kind: 'meat', slug: m.slug, name, item: m.item, path: `/meat/${m.slug}/`,
              indexable: true,
              changePct: m.changePct ?? null, price: m.price ?? null, unit: m.unit,
              retailPerCatty: m.retail?.[0]?.perCatty ?? null,
              // 肉是原料級不是部位級，頁面要講明
              raw: true,
            };
          }
          seen.set(key, { ...item, dishes: [] });
        }
        seen.get(key).dishes.push(d.dish);
        items.push(key);
      }
      if (!d.source) errors.push(`${label}／${d.dish}：沒有 source，不收沒有來源的菜`);
      dishes.push({
        dish: d.dish, items, noPrice: d.noPrice ?? [], source: d.source, sourceOrg: d.sourceOrg ?? null,
        unverified: d.unverified === true, avoid: d.avoid ?? null, avoidWhy: d.avoidWhy ?? null,
        coverage: rd((d.have.length / (d.have.length + (d.noPrice?.length ?? 0))) * 100, 0),
      });
    }
    const ingredients = [...seen.entries()].map(([key, v]) => ({ key, ...v }));
    const noPrice = [...new Set(list.flatMap((d) => d.noPrice ?? []))];
    return { dishes, ingredients, noPrice,
      coverage: rd((ingredients.length / (ingredients.length + noPrice.length)) * 100, 0) };
  };

  // 日期：農曆節點與節氣一律讀天文台表產生的 overrides/lunar-calendar.json（scripts/hko-calendar.mjs）
  const asOf = today();
  const occurrences = (dateKey) => (dateKey.startsWith('term:')
    ? cal.terms.filter((t) => t.name === dateKey.slice(5)).map((t) => t.date)
    : cal.lunar.filter((x) => x.id === dateKey).map((x) => x.date)).sort();
  const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
  const nextOf = (dateKey, label) => {
    const date = occurrences(dateKey).find((d) => d >= asOf);
    return date ? { label, date, daysUntil: daysBetween(asOf, date) } : null;
  };

  const out = [];
  for (const f of menu.festivals) {
    // 網址用小寫 id，往例用 key（中秋的兩個鍵不同字：midautumn vs midAutumn）。
    // 沒有 key 就當成跟 id 同字，但表裡缺 key 要吵——這種對不上會安靜地讓倒數消失。
    const key2 = f.key ?? f.id;
    if (!f.key) errors.push(`${f.name}：overrides/festival-menu.json 少了 key 欄位`);
    if (!f.date) errors.push(`${f.name}：overrides/festival-menu.json 少了 date 欄位（lunar-calendar.json 的節點 id 或 term:節氣名）`);
    const r = await resolve(f.name, f.dishes, key2);
    out.push({
      // note＝給使用者的建議（頁面顯示）；limit＝涵蓋範圍的限制（只在 /about/#m-festival 顯示，CLAUDE.md 紅線）
      id: f.id, kind: f.kind ?? 'festival', name: f.name, when: f.when, note: f.note ?? null, limit: f.limit ?? null,
      ...r,
      // 下一次日期與倒數（天文台表）；有漲幅往例的節日沿用 festival.json 的標籤（例：春節標「除夕」）
      next: f.date ? nextOf(f.date, fes?.nextAll?.[key2]?.label ?? f.name) : null,
      // 有沒有漲幅往例：只有算得出對照年的節日才有（理由見 festival.mjs）
      hasHistory: !!fes?.byFestival?.[key2],
      date: f.date ?? null,
    });
  }

  // ── 每週菜單（站主 2026-09-28）：從這週一起排 52 週，每週一個主題、至少 3 道有來源的菜。
  // 主題順序：農曆節日（kind festival）→ 民俗節點（folk）→ 有食俗的節氣（term）→ 當季（season）。
  // 大節日的前一週若沒有自己的主題，算成該節日的備料週。沒有食俗的節氣只當標籤（例：寒露・秋季盛產）。
  // 當季週從食譜池（overrides/recipes.json，每道有公開來源）挑：該週月份盛產的食材越多越前面、
  // 這週（只有這週有真的行情）比常年便宜的食材加分、前兩個當季週出現過的菜往後排。
  const SEASONS = [
    { id: 'spring', name: '春季盛產', months: [3, 4, 5] },
    { id: 'summer', name: '夏季盛產', months: [6, 7, 8] },
    { id: 'autumn', name: '秋季盛產', months: [9, 10, 11] },
    { id: 'winter', name: '冬季盛產', months: [12, 1, 2] },
  ];
  const seasonOfMonth = (m) => SEASONS.find((x) => x.months.includes(m));
  const RANK = { festival: 0, folk: 1, term: 2 };
  const PREP = new Set(['weiya', 'cny', 'qingming', 'duanwu', 'zhongyuan', 'midautumn', 'dongzhi']);
  const addDays = (iso, n) => new Date(Date.parse(iso) + n * 86_400_000).toISOString().slice(0, 10);
  const mondayOf = (iso) => addDays(iso, -((new Date(`${iso}T00:00:00Z`).getUTCDay() + 6) % 7));
  const isoWeek = (monday) => {
    const th = new Date(Date.parse(addDays(monday, 3)));
    const y = th.getUTCFullYear();
    const w = 1 + Math.floor((th - Date.UTC(y, 0, 1)) / (7 * 86_400_000));
    return `${y}-W${String(w).padStart(2, '0')}`;
  };
  const themes = out.filter((f) => f.date && f.dishes.length > 0);
  const WEEKS = 52;
  const start = mondayOf(asOf);
  const weeks = [];
  for (let i = 0; i < WEEKS; i++) {
    const mon = addDays(start, i * 7), sun = addDays(mon, 6);
    const inWeek = (d) => d >= mon && d <= sun;
    const hit = themes.map((f) => ({ f, date: occurrences(f.date).find(inWeek) }))
      .filter((x) => x.date)
      .sort((a, b) => (RANK[a.f.kind] - RANK[b.f.kind]) || a.date.localeCompare(b.date));
    const term = cal.terms.find((t) => inWeek(t.date)) ?? null;
    weeks.push({ iso: isoWeek(mon), start: mon, end: sun, thisWeek: i === 0,
      term: term?.name ?? null, month: Number(addDays(mon, 3).slice(5, 7)),
      theme: hit[0] ? { id: hit[0].f.id, kind: hit[0].f.kind, date: hit[0].date, prep: false } : null });
  }
  // 備料週：大節日的前一週若沒有主題，歸給該節日
  for (let i = 0; i < weeks.length - 1; i++) {
    const nx = weeks[i + 1].theme;
    if (!weeks[i].theme && nx && PREP.has(nx.id) && !nx.prep) weeks[i].theme = { ...nx, prep: true };
  }
  // 立冬補冬：節氣當週與下一週（下一週沒有主題才延續）
  for (let i = 0; i < weeks.length - 1; i++) {
    const t = weeks[i].theme;
    if (t?.kind === 'term' && !t.prep && !t.cont && !weeks[i + 1].theme) weeks[i + 1].theme = { ...t, prep: false, cont: true };
  }

  const recipes = (recipeFile?.recipes ?? []);
  const resolvedRecipe = new Map();
  for (const rc of recipes) {
    const r = await resolve(`食譜池（${rc.season}）`, [rc], null);
    resolvedRecipe.set(rc.dish, { ...rc, items: r.ingredients });
  }
  const monthOk = (it, m) => {
    if (it.kind !== 'crop') return false;
    const c = idx.crops.find((x) => x.slug === it.slug);
    const p = c && prof?.byCrop?.[`${c.tcType}|${c.plv3Key}`]?.season;
    return !!p && !p.yearRound && p.months.includes(m);
  };
  const recent = [];                 // 最近兩個用到食譜池的週用過的菜
  const lastUsed = new Map();        // 菜 → 上次出現在第幾週（越久沒出現越優先，讓整季輪過一遍）
  const pickSeason = (w, season, need) => {
    const pool = recipes.filter((rc) => [].concat(rc.season).includes(season.id))
      .map((rc) => resolvedRecipe.get(rc.dish))
      .filter(Boolean);
    const scored = pool.map((rc, k) => {
      const inSeason = rc.items.filter((it) => monthOk(it, w.month)).length;
      const cheap = w.thisWeek ? rc.items.filter((it) => (it.changePct ?? 0) <= -10).length : 0;
      const used = recent.slice(-2).some((r) => r.includes(rc.dish));
      // 同分時依週次輪替，不要每週都從同一道開始
      const rot = (k + weeks.indexOf(w) * 7) % Math.max(pool.length, 1);
      const fits = inSeason + cheap > 0 ? 0 : 1;          // 這週有盛產或便宜的食材 → 優先
      return { rc, key: [used ? 1 : 0, lastUsed.get(rc.dish) ?? -1, fits, -(inSeason * 2 + cheap), rot] };
    }).sort((a, b) => { for (let j = 0; j < a.key.length; j++) if (a.key[j] !== b.key[j]) return a.key[j] - b.key[j]; return 0; });
    const picked = [], mains = new Set();
    for (const { rc } of scored) {
      if (picked.length >= need) break;
      if (rc.main && mains.has(rc.main)) continue;      // 同一週主角不重複
      picked.push(rc); if (rc.main) mains.add(rc.main);
    }
    for (const { rc } of scored) { if (picked.length >= need) break; if (!picked.includes(rc)) picked.push(rc); }
    for (const rc of picked) lastUsed.set(rc.dish, weeks.indexOf(w));
    return picked;
  };
  const byId = new Map(out.map((f) => [f.id, f]));
  const dishRef = (d, from, pageId) => ({ dish: d.dish, source: d.source, sourceOrg: d.sourceOrg ?? null, from, page: pageId });
  for (const w of weeks) {
    const season = seasonOfMonth(w.month);
    w.season = season.id;
    if (w.theme) {
      const f = byId.get(w.theme.id);
      w.dishes = f.dishes.slice(0, 6).map((d) => dishRef(d, 'theme', f.id));
      if (w.dishes.length < 3) {
        const fill = pickSeason(w, season, 3 - w.dishes.length);
        recent.push(fill.map((d) => d.dish));
        w.dishes.push(...fill.map((d) => dishRef(d, 'season', season.id)));
      }
      w.name = w.theme.prep ? `${f.name}前一週` : f.name;
      w.page = f.id;
    } else {
      const picked = pickSeason(w, season, 4);
      recent.push(picked.map((d) => d.dish));
      w.dishes = picked.map((d) => dishRef(d, 'season', season.id));
      w.name = w.term ? `${w.term}・${season.name}` : season.name;
      w.page = season.id;
    }
  }
  const thin = weeks.filter((w) => w.dishes.length < 3);
  if (thin.length) errors.push(`每週菜單有 ${thin.length} 週不到 3 道菜（${thin.map((w) => w.iso).join('、')}）——食譜池不夠，補 overrides/recipes.json`);

  // 季節頁：顯示「這週」的菜單；不在這一季時顯示這一季最近的一週
  for (const season of SEASONS) {
    const wk = weeks.find((w) => w.page === season.id) ?? null;
    const list = wk ? wk.dishes.filter((d) => d.from === 'season').map((d) => resolvedRecipe.get(d.dish)) : [];
    const r = await resolve(season.name, list, null);
    out.push({
      id: season.id, kind: 'season', name: season.name, when: `國曆 ${season.months[0]}–${season.months.at(-1)} 月`,
      note: null, limit: null, ...r,
      next: wk ? { label: wk.name, date: wk.start, daysUntil: Math.max(0, daysBetween(asOf, wk.start)), week: wk.iso, thisWeek: wk.thisWeek } : null,
      hasHistory: false, date: null,
      weeks: weeks.filter((w) => w.page === season.id).map((w) => w.iso),
    });
  }

  if (errors.length) {
    for (const e of errors) console.error(`  ✗ ${e}`);
    throw new Error(`節日菜單有 ${errors.length} 個食材對不到品項——修好 overrides/festival-menu.json 再跑`);
  }

  // 最近的節日排前面：清單頁與「其他節日」都照這個順序，使用者看到的第一個就是快到的那個
  out.sort((a, b) => (a.next?.daysUntil ?? 9999) - (b.next?.daysUntil ?? 9999));

  await writeFile(join(PAGE, 'festival-menu.json'), JSON.stringify({
    builtAt: new Date().toISOString(), lastDate: idx.lastDate, asOf: today(),
    festivals: out,
    weeks,
  }));

  // 節日頁的「把蔬果食材加進買菜清單」會加入這個節日所有蔬果食材，其中有些品項交易量不夠、
  // 不在 emit-page 寫的 list-source.json 裡（例：春節的栗子），首頁清單就會默默少一樣。
  // emit-page 跑在這支之前，所以由這裡把缺的補進去（menu: false＝不出現在「加一項」選單，
  // 維持選單只列資料足夠的品項；但清單裡有它就照樣顯示）。
  const lsPath = join(PAGE, 'list-source.json');
  const ls = await readFile(lsPath, 'utf-8').then(JSON.parse).catch(() => null);
  if (ls) {
    const have = new Set(ls.crops.map((c) => c.slug));
    let added = 0;
    for (const i of out.flatMap((f) => f.ingredients)) {
      if (i.kind !== 'crop' || have.has(i.slug)) continue;
      have.add(i.slug);
      ls.crops.push({
        slug: i.slug, name: i.name, tcType: i.slug.slice(0, 3).toUpperCase(),
        cat: i.slug.startsWith('n05') ? '水果' : '其他蔬菜',
        changePct: i.changePct ?? null, wholesale: i.price ?? null,
        inSeason: i.inSeason ?? null, cheapestMonth: null, tyPct: null, fesPct: null,
        retailPerCatty: i.retailPerCatty ?? null, seasonal: false, alt: null, menu: false,
      });
      added++;
    }
    await writeFile(lsPath, JSON.stringify(ls));
    console.error(`買菜清單資料：補入節日食材 ${added} 項（不進選單）`);
  }

  console.error(`節日菜單：${out.length} 個節日`);
  for (const f of out) {
    const cheap = f.ingredients.filter((i) => (i.changePct ?? 0) <= -10).length;
    const dear = f.ingredients.filter((i) => (i.changePct ?? 0) >= 10).length;
    console.error(`  ${f.name.padEnd(5)} ${f.next ? `還有 ${String(f.next.daysUntil).padStart(3)} 天　` : '（無日期）　'}`
      + `${f.dishes.length} 道菜、${f.ingredients.length} 樣有價格的食材`
      + `（可定價 ${f.coverage}%）：現在比常年便宜 ${cheap} 樣、貴 ${dear} 樣`
      + `；沒有價格的 ${f.noPrice.length} 樣`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
