// llms-full.txt：讓 AI 助手一次取得可引用全文，不必逐頁爬 1,402 頁。
//
// 跟 public/llms.txt 不一樣：llms.txt 是手寫的導覽＋前提說明（「引用這個站之前，請先讀這幾條」），
// 很少改動；這份是**每次 transform 都重新產生**的資料全文，因為裡面的數字每天都在變
// （批發價、旬漲跌、市場排行……跟著 data/page/ 一起換）。所以放在 transform pipeline 裡、
// 讀 emit-page.mjs 的產出，而不是像 llms.txt 那樣手寫一份靜態檔——手寫的話隔天就是舊資料，
// 比沒有還糟（見 GEO.md「口徑改變時要一起改的地方」同一個道理）。
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
