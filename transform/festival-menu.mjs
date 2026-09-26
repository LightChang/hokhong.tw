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
  const out = [];
  for (const f of menu.festivals) {
    // 網址用小寫 id，往例與日期用 key（中秋的兩個鍵不同字：midautumn vs midAutumn）。
    // 沒有 key 就當成跟 id 同字，但表裡缺 key 要吵——這種對不上會安靜地讓倒數消失。
    const key2 = f.key ?? f.id;
    if (!f.key) errors.push(`${f.name}：overrides/festival-menu.json 少了 key 欄位`);
    const dishes = [];
    const seen = new Map();          // 同一個節日裡食材去重，但記住哪幾道菜要用
    for (const d of f.dishes) {
      const items = [];
      for (const name of d.have) {
        const crop = cropByName.get(name);
        const meatSlug = meatAlias[name];
        if (!crop && !meatSlug) {
          // 表裡寫了一個站上沒有的名字：一定要吵，不能靜靜跳過
          errors.push(`${f.name}／${d.dish}：食材「${name}」對不到任何品項（要嘛改名字，要嘛移到 noPrice）`);
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
              festivalPct: fes?.byCrop?.[crop.plv3Key]?.[key2]?.medianPeakPct ?? null,
              festivalDaysBefore: fes?.byCrop?.[crop.plv3Key]?.[key2]?.medianDaysBefore ?? null,
            };
          } else {
            const m = meatBySlug.get(meatSlug);
            if (!m) { errors.push(`${f.name}／${d.dish}：肉蛋別名「${name}」指向 ${meatSlug}，但 meat/index.json 沒有這個品項`); continue; }
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
      dishes.push({
        dish: d.dish, items, noPrice: d.noPrice ?? [], source: d.source,
        unverified: d.unverified === true, avoid: d.avoid ?? null, avoidWhy: d.avoidWhy ?? null,
        coverage: rd((d.have.length / (d.have.length + (d.noPrice?.length ?? 0))) * 100, 0),
      });
    }
    const ingredients = [...seen.entries()].map(([key, v]) => ({ key, ...v }));
    const noPriceAll = [...new Set(f.dishes.flatMap((d) => d.noPrice ?? []))];
    out.push({
      id: f.id, name: f.name, when: f.when, note: f.note,
      dishes, ingredients, noPrice: noPriceAll,
      coverage: rd((ingredients.length / (ingredients.length + noPriceAll.length)) * 100, 0),
      // 每個節日各自的下一次日期與倒數（festival.json 的 nextAll 涵蓋全部節日）
      next: fes?.nextAll?.[key2] ?? null,
      // 有沒有漲幅往例：只有算得出對照年的節日才有（尾牙、元宵、中元、冬至沒有，理由見 festival.mjs）
      hasHistory: !!fes?.byFestival?.[key2],
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
  }));

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
