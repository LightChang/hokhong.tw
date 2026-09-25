// 產出 public/llms.txt（導覽＋引用前提）與 public/llms-full.txt（可引用全文），兩份都是程式產生。
//
// llms.txt 原本是手寫的靜態檔，結果 2026-09-25 盤點時裡面每一個數字都過期了
// （寫 1,469 萬筆、零售 2.0 倍、範圍 1.01–3.11、124 品項中 28 項有零售、21 個市場…），
// 而這正是生成引擎會整句抄走的檔——寫死的前提比沒有前提更糟。所以現在文案留在這支程式裡，
// 數字一律從 data/page/about.json（emit-page 算的）與 index/cheap-now/list-source 插值。
// llms-full.txt 同理：裡面的價格、旬漲跌、市場排行每天都在變，跟著 data/page/ 一起重算。
//
// 只收「資料品質達標」的頁面（indexable，見 emit-page.mjs 的 INDEX_IN 門檻：近 90 天至少
// 30 個交易日、累積量至少 10,000 公斤），跟站上排行榜、索引頁用的是同一組門檻——
// 資料量太薄的品項連站上自己都不會拿去排名，llms-full.txt 也不該替它背書。
//
// 用法：node transform/emit-llms-full.mjs（在 transform/run.mjs 的 build 之前跑，
// 寫進 public/llms-full.txt，astro build 會把 public/ 整份複製進 dist/）
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ROOT, DATA } from './_db.mjs';

const PAGE = join(DATA, 'page');
const OUT = join(ROOT, 'public', 'llms-full.txt');
const OUT_NAV = join(ROOT, 'public', 'llms.txt');
const SITE = 'https://hokhong.tw';

const loadJson = async (p) => JSON.parse(await readFile(p, 'utf-8'));
const fmt = (n, d = 2) => (n == null ? '—' : Number(n).toFixed(d).replace(/\.00$/, '').replace(/(\.\d*[1-9])0$/, '$1'));
const pct = (n) => (n == null ? '—' : `${n > 0 ? '+' : ''}${fmt(n, 1)}%`);
const vol = (n) => (n == null ? '—' : Number(n).toLocaleString('zh-TW'));

async function main() {
  const t0 = Date.now();

  // ── 榜單：本旬全國漲跌排行（跟 /cheap/ 同一份資料，門檻見 cheap-now.json 的 filters）
  const cheapNow = await loadJson(join(PAGE, 'cheap-now.json'));

  // ── 全部達門檻的品項：跟 /crop/{slug}/ 同一份資料（單一全國頁，不含市場子頁）
  const cropIdx = await loadJson(join(PAGE, 'index.json'));
  const indexableCrops = cropIdx.crops.filter((c) => c.indexable);
  const cropDetails = [];
  for (const c of indexableCrops) {
    try { cropDetails.push(await loadJson(join(PAGE, 'crop', `${c.slug}.json`))); }
    catch { /* 索引裡有但檔案漏了：略過，不讓單一品項擋掉整份輸出 */ }
  }

  // ── 市場：跟 /market/{slug}/ 同一份資料
  const marketFiles = (await readdir(join(PAGE, 'market'))).filter((f) => f.endsWith('.json'));
  const markets = [];
  for (const f of marketFiles) markets.push(await loadJson(join(PAGE, 'market', f)));
  markets.sort((a, b) => a.code.localeCompare(b.code));

  // ── 肉蛋：跟 /meat/{slug}/ 同一份資料
  const meat = await loadJson(join(PAGE, 'meat', 'index.json'));

  const lastDate = cheapNow.lastDate;
  const lines = [];

  lines.push('# 好康 hó-khang — 全文資料（AI 引用用）');
  lines.push('');
  lines.push(`> 本檔由 transform/emit-llms-full.mjs 於每日 transform pipeline 自動產生，內容取自站台`);
  lines.push(`> 當次轉換的 data/page/ 產出，跟網站頁面同一份資料、同一天更新。不是手寫摘要。`);
  lines.push(`> `);
  lines.push(`> 前提與口徑說明（單位換算、涵蓋範圍、已知限制）請先讀 ${SITE}/llms.txt ——`);
  lines.push(`> 那份是導覽與前提，這份是把 ${SITE}/llms.txt「主要頁面」清單下每一種頁型的`);
  lines.push(`> 實質內容展開成全文，兩者互補、請一起讀。`);
  lines.push(`> `);
  lines.push(`> 涵蓋範圍：全國漲跌排行（前 ${cheapNow.cheaper.length + cheapNow.pricier.length} 名，`);
  lines.push(`> 候選 ${cheapNow.candidates} 項）、資料品質達標品項 ${cropDetails.length} 項`);
  lines.push(`> （近 90 天交易日 ≥30、累積量 ≥10,000 公斤——跟站上排行榜同一組門檻，`);
  lines.push(`> 未達標的品項不收，資料太薄不該被引用）、批發市場 ${markets.length} 個、`);
  lines.push(`> 肉蛋品項 ${meat.items.length} 項。資料截至 ${lastDate}。`);
  lines.push(`> `);
  lines.push(`> 資料來源：農業部農糧署「農產品交易行情」與產地價格查報系統、`);
  lines.push(`> 臺中市公有零售市場訪價、農業部毛豬交易行情、中央畜產會產地行情。`);
  lines.push(`> 政府資料開放授權條款第 1 版；資料著作權屬各政府機關，本站不重新散布原始資料，`);
  lines.push(`> 只做加值整理。本站程式碼 MIT。`);
  lines.push('');

  // ── 1. 本旬全國漲跌排行 ──
  lines.push('## 本旬全國漲跌排行');
  lines.push('');
  lines.push(`基準：${cheapNow.basis}。門檻：旬交易量 ≥${vol(cheapNow.filters.minVolumeKg)} 公斤、`);
  lines.push(`近三年同旬至少 ${cheapNow.filters.minBaseYears} 年有量，符合 ${cheapNow.candidates} 項，`);
  lines.push(`以下各列前 ${cheapNow.cheaper.length} 名（完整榜單見 ${SITE}/cheap/）。資料至 ${lastDate}。`);
  lines.push('');
  lines.push(`### 比近三年同旬便宜（${cheapNow.targetXun}）`);
  for (const it of cheapNow.cheaper) lines.push(rankLine(it));
  lines.push('');
  lines.push(`### 比近三年同旬貴（${cheapNow.targetXun}）`);
  for (const it of cheapNow.pricier) lines.push(rankLine(it));
  lines.push('');

  // ── 2. 品項全國頁 ──
  lines.push('## 品項全國行情（依站上俗名排序）');
  lines.push('');
  lines.push(`每項含：批發價（元/公斤）、與近三年同旬均價比、與去年同月比、`);
  lines.push(`臺中零售實測（若有）、產地價與產地→批發→零售價格鏈（若對得起來）、當令縣市。`);
  lines.push(`資料至 ${lastDate}，各品項頁：${SITE}/crop/{slug}/。`);
  lines.push('');
  cropDetails.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hant-TW'));
  for (const c of cropDetails) lines.push(cropLine(c));
  lines.push('');

  // ── 3. 市場榜單 ──
  lines.push('## 批發市場當旬最便宜／最貴品項');
  lines.push('');
  lines.push(`每市場列當旬（各市場截至的最近一旬，多數為 ${cheapNow.targetXun}）前 5 便宜、前 5 貴，`);
  lines.push(`括號內為與近三年同旬均價比。市場頁：${SITE}/market/{slug}/。`);
  lines.push('');
  for (const m of markets) lines.push(marketLine(m));
  lines.push('');

  // ── 4. 肉蛋 ──
  lines.push('## 毛豬、家禽與蛋');
  lines.push('');
  lines.push(`毛豬為批發成交價；家禽與蛋為中央畜產會**產地價**，不是零售也不是批發。`);
  lines.push(`比較基準為各品項自己的近幾年同旬產地均價，年數列在每一列的括號內；雞蛋因來源在民國`);
  lines.push(`114 年 9 月換算法，只能比 1 年，其餘品項多為 3 年。`);
  lines.push(`資料截至 ${meat.lastDate}（${meat.xunLabel}）。品項頁：${SITE}/meat/{slug}/。`);
  lines.push('');
  for (const it of meat.items) lines.push(meatLine(it));
  lines.push('');

  lines.push('---');
  lines.push(`產生時間：${new Date().toISOString()}　資料截至：${lastDate}`);
  lines.push(`本檔為程式產生，若與 ${SITE}/llms.txt 或站上頁面數字不一致，一律以站上當前頁面為準`);
  lines.push(`（本檔跟頁面同一次 build 產生，正常情況下不會不一致；不一致代表部署有問題）。`);

  const text = lines.join('\n') + '\n';
  await writeFile(OUT, text, 'utf-8');
  const kb = (Buffer.byteLength(text, 'utf-8') / 1024).toFixed(0);
  console.error(`llms-full.txt：${kb} KB，品項 ${cropDetails.length}、市場 ${markets.length}、肉蛋 ${meat.items.length}，${((Date.now() - t0) / 1000).toFixed(1)}s`);

  // ── llms.txt：導覽與「引用前請先讀這幾條」。文案固定，數字全部插值。
  const about = await loadJson(join(PAGE, 'about.json'));
  const listSrc = await loadJson(join(PAGE, 'list-source.json'));
  const navText = navDoc({ about, cropIdx, cheapNow, listSrc, lastDate });
  await writeFile(OUT_NAV, navText, 'utf-8');
  console.error(`llms.txt：${(Buffer.byteLength(navText, 'utf-8') / 1024).toFixed(1)} KB`);
}

// ── llms.txt 的內容。會變的數字一律由參數帶進來，函式裡不寫死任何現況值。
function navDoc({ about, cropIdx, cheapNow, listSrc, lastDate }) {
  const rocY = (iso) => (iso ? Number(iso.slice(0, 4)) - 1911 : '—');
  const wan = (n) => (n == null ? '—' : Math.round(n / 10000).toLocaleString('en-US'));
  const names = (xs) => (xs ?? []).map((x) => x.name).join('、');
  const byType = cropIdx.markets.reduce((acc, m) => ((acc[m.tcType] = (acc[m.tcType] ?? 0) + 1), acc), {});
  const typeText = [['N04', '蔬菜'], ['N05', '水果'], ['N06', '花卉']]
    .filter(([k]) => byType[k]).map(([k, label]) => `${label} ${byType[k]}`).join('、');
  const r = about.retail ?? {};
  const cov = about.coverage ?? {};
  const mk = about.markets ?? {};
  const ty = about.typhoon ?? {};
  const below = about.chain?.blocked?.['wholesale-below-origin'] ?? 0;

  return `# 好康 hó-khang — 台灣農產品行情

> 回答一個問題：**這週買菜，什麼划算、什麼先別買。**主數字是「比近三年同一旬便宜／貴幾 %」，
> 不是價格。資料為農業部農糧署批發市場交易行情，民國 ${rocY(mk.firstDate)} 年起共 ${wan(cov.l1Rows)} 萬筆交易紀錄，每日更新。

## 引用這個站之前，請先讀這幾條

這些是最常被講錯的地方。引用站上數字時請一併帶上，否則結論會失真。

- **「全國」不是全台灣。** 全台果菜批發市場有 47 家（2026-09-11 農糧署回覆），只有農糧署輔導的**行情報導站**每日上傳，
  站上的「全國」是這些報導站的交易量加權平均。目前涵蓋 ${mk.total} 個市場、${cropIdx.counts.markets} 個市場×類別頁
  （${typeText}）。**臺南沒有蔬果行情，只有花卉。**
- **批發價不是你在菜市場付的錢。** 批發價單位是**元/公斤**。零售÷批發的中位數約 ${r.ratioMedian} 倍，
  但範圍從 ${r.ratioMin?.ratio} 到 ${r.ratioMax?.ratio} 倍都有（${names(r.cheapEnd)}幾乎沒有加價，${names(r.dearEnd)}高到 ${r.ratioMax?.ratio} 倍）。
  用單一倍數推估攤價一定會錯，本站也不推估。
- **零售價只有一個縣市。** 來源是臺中市 ${r.markets} 個公有零售市場的實測訪價，單位**元/台斤**，
  取近 ${r.days} 個訪價日的中位數。站上 ${listSrc.crops.length} 個可買品項中只有 **${r.items} 項**有零售實測，其餘只給批發價。
  全台查證過沒有第二個縣市開放同型資料。
- **比較基準是「近三年同一旬」，不是昨天、也不是去年同期。** 農產品季節性很強，
  九月的高麗菜本來就比三月貴；跟去年同月比又可能剛好撞到去年的颱風。
  一律用最近一個**已經結束**的旬（目前是 ${cheapNow.targetXun}）。
- **排行榜有門檻。** 只收該旬交易量 ${(cheapNow.filters?.minVolume ?? 5000).toLocaleString('en-US')} 公斤以上、且近三年同旬都有量的品項，目前 ${cheapNow.candidates} 個。
- **品項名稱經過改寫。** 行情站用農業分類正式名稱，本站改用一般人的講法
  （甘藍→高麗菜、檬果→芒果、枸櫞→檸檬、韭蔥→蒜苗、隼人瓜→龍鬚菜），每頁都標出原名。
- **價格鏈只有少數品項有。** 產地價與批發價不是同一種貨：目前 ${about.chain?.candidates} 個對得上產地品名的品項裡，
  有 ${below} 個算出「農民賣得比批發市場還貴」，所以只有 ${about.chain?.comparable} 個通過檢查、${about.chain?.threeLayer} 個有完整三層。
- **花卉的品項對應不完整。** 官方統一代碼在花卉只涵蓋交易量的 ${cov.byType?.N06}%（蔬菜 ${cov.byType?.N04}%、水果 ${cov.byType?.N05}%），
  對不上的不計入作物層統計。
- **不預測價格。** 站上的颱風段落是 ${ty.firstYear} 年以來 ${ty.count} 次颱風的**往例統計**，不是預測。
- **肉蛋與蔬果是兩套資料。** 毛豬是批發成交價（元/公斤，民國 98 年 11 月起）；
  家禽與蛋是中央畜產會**產地行情**（元/台斤，2010 年 10 月起），產地價既不是零售價也不是批發價。
  雞蛋產地價因來源在民國 114 年 9 月換算法，只比得到一年。

## 主要頁面

- [這週買菜什麼划算](${SITE}/)：首頁，當旬最划算與最該避開的品項
- [完整榜單](${SITE}/cheap/)：該旬全部品項的便宜／變貴排序
- [找食材](${SITE}/crop/)：蔬菜、水果、肉蛋、花卉的品項清單與搜尋
- [市場](${SITE}/market/)：各批發市場現在什麼便宜、到貨量
- [這些數字怎麼來的](${SITE}/about/)：口徑、涵蓋範圍、已知問題的完整說明
- [可引用全文](${SITE}/llms-full.txt)：所有達門檻品項與市場的當前數字

## 頁面型別

- \`/crop/{slug}/\`：單一品項的全國行情。月均價全史、與近三年同旬比、與去年同月比、
  各市場價差、颱風往例、產地→批發→零售價格鏈
- \`/crop/{slug}/{市場代號}/\`：單一品項在單一市場的行情，與全國均價對照
- \`/market/{slug}/\`：單一市場的當旬最便宜／最貴品項與每日到貨量
- \`/meat/{slug}/\`：毛豬、白肉雞、紅羽土雞、雞蛋、鴨蛋、肉鵝、番鴨

## 這個站有而官方平台沒有的

官方平台（農業部田邊好幫手、蔬果行情站）只保留**兩年**資料。以下四項只有這裡做得到：

1. 跨年比較：今年這時候比近三年同期貴多少
2. 事件標註：颱風後通常漲多少、約幾天回穩（${ty.count} 次颱風的往例）
3. 產地→批發→零售的縱向對照，以及農民拿到你付的錢的幾成
4. 「現在什麼便宜」的入口：不必先知道品名就能查

## 資料來源與授權

- 批發行情：農業部農糧署「農產品交易行情」，政府資料開放授權條款第 1 版
- 產地價：農糧署農產品產地價格查報系統
- 零售價：臺中市公有零售市場訪價
- 毛豬：農業部毛豬交易行情；家禽與蛋：中央畜產會產地行情
- 市場座標與名稱：OpenStreetMap（© OpenStreetMap contributors，ODbL）
- 本站程式碼 MIT；資料著作權屬各政府機關，本站不重新散布原始資料

資料每日凌晨取得並重抓最近 7 天（部分市場會延遲上傳，官方也會事後修正）。
資料截至民國 ${rocY(lastDate)}/${lastDate.slice(5, 7)}/${lastDate.slice(8, 10)}；本檔與站上頁面同一次 build 產生。
`;
}

function rankLine(it) {
  const retail = it.retail ? `；零售 ${fmt(it.retail.perKg, 1)} 元/公斤・${fmt(it.retail.perCatty, 1)} 元/台斤（臺中零售實測 ${it.retail.samples} 筆）` : '';
  return `- ${it.name}（${it.official !== it.name ? it.official + '｜' : ''}${it.plv2}）：批發 ${fmt(it.wholesale, 2)} 元/公斤，` +
    `較近三年同旬均價 ${fmt(it.baseline3y, 2)} ${pct(it.changePct)}${retail}。旬交易量 ${vol(it.volume)} 公斤。`;
}

function cropLine(c) {
  const ch = c.chain;
  const retail = c.retail ? `零售 ${fmt(c.retail.perKg, 1)} 元/公斤・${fmt(c.retail.perCatty, 1)} 元/台斤（臺中實測 ${c.retail.samples} 筆／${c.retail.days} 天，涵蓋率 ${fmt((c.retail.cover ?? 0) * 100, 0)}%）` : '零售：無臺中實測';
  const chain = ch?.comparable
    ? `產地 ${fmt(ch.origin, 1)} 元/公斤（${ch.originItem}，產地→批發 ${fmt(ch.originToWholesale, 2)} 倍，農民約拿售價 ${fmt(ch.farmerShare, 0)}%）`
    : '產地價：與批發價對不起來或缺，未列';
  const latest = c.latest ? `${c.latest.ym} 月均價 ${fmt(c.latest.price, 2)} 元/公斤` : '無最新月均價';
  const chg = c.change ? `較近三年同旬（${c.change.xun}）均價 ${fmt(c.change.baseline3y, 2)} ${pct(c.change.changePct)}` : '無同旬基準';
  const yoy = c.yoy ? `，較去年同月 ${pct(c.yoy.changePct)}` : '';
  const season = c.seasonal ? `；當令縣市：${(c.seasonCounties || []).join('／') || '未列'}` : '';
  return `- ${c.name}（${c.official !== c.name ? c.official + '｜' : ''}${c.plv1}-${c.plv2}）：${latest}，${chg}${yoy}。${retail}。${chain}${season}。`;
}

function marketLine(m) {
  const top = (arr) => (arr || []).slice(0, 5).map((x) => `${x.name} ${fmt(x.price, 1)}(${pct(x.changePct)})`).join('、');
  return `- ${m.name}（代號 ${m.code}｜${m.tc_type}）${m.xun}：最便宜 ${top(m.cheapest) || '無'}；最貴 ${top(m.priciest) || '無'}。`;
}

function meatLine(it) {
  return `- ${it.item}：${fmt(it.price, 1)} ${it.unit}，較近 ${it.refYears} 年同旬產地均價 ${fmt(it.refPrice, 1)} ${pct(it.changePct)}（近 ${it.days} 天）。`;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
