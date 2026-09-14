// 農業資料開放平臺的參考表與低頻資料集，一次全抓。
// 用法：node ingest/sources/moa-reference.mjs [id ...]   → ingest/raw/<id>.json.gz
import { mkdir, writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RAW, SERVICE, getJson, getPaged, save } from './_moa.mjs';

// endpoint 皆為 2026-09-11 實際打通的 URL；paged=true 表示用 $top/$skip 抓完
export const sources = [
  { id: 'crop-unified', name: '農作物統一名稱與代碼', unit: 'LC7YWlenhLuP', url: `${SERVICE}/TransService.aspx?UnitId=LC7YWlenhLuP`, paged: true },
  { id: 'crop-crosswalk', name: '農作物統一代碼與農業相關系統之農作物代碼對應', unit: 'xVOXUErUYXJK', url: `${SERVICE}/TransService.aspx?UnitId=xVOXUErUYXJK`, paged: true },
  { id: 'market-rest-farm', name: '果菜及花卉市場休市', unit: 'I01', url: `${SERVICE}/FromM/MarketRestFarm.aspx`, paged: true },
  { id: 'origin-price', name: '農產品產地價格資料（旬／日）', unit: 'WVOiWSdDjWxx', url: `${SERVICE}/TransService.aspx?UnitId=WVOiWSdDjWxx`, paged: true },
  { id: 'origin-price-monthly', name: '農產品產地價格（月平均價格）', unit: '652', url: `${SERVICE}/DataFileService.aspx?UnitId=652` },
  { id: 'peak-season-origin', name: '每月盛產農產品產地', unit: '061', url: `${SERVICE}/DataFileService.aspx?UnitId=061` },
  { id: 'crop-forecast', name: '農情預測', unit: '4P84xEv6hd22', url: `${SERVICE}/TransService.aspx?UnitId=4P84xEv6hd22`, paged: true },
  // 只回傳最近 2 天（實測 20260910–20260911），是滾動視窗 → 按抓取日分檔累積，不能覆寫
  { id: 'tap-trans', name: '產銷履歷與有機蔬果行情', unit: 'H44', url: `${SERVICE}/FromM/TAPData.aspx`, paged: true, daily: true },
];

async function main() {
  const want = process.argv.slice(2);
  for (const s of sources) {
    if (want.length && !want.includes(s.id)) continue;
    const rows = s.paged ? await getPaged(s.url) : await getJson(s.url);
    if (s.daily) {
      const today = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
      const file = join(RAW, s.id, `${today}.json.gz`);
      await mkdir(join(RAW, s.id), { recursive: true });
      await writeFile(file, gzipSync(JSON.stringify(rows)));
      console.error(`${s.id}: ${rows.length} rows → ${file}`);
    } else {
      await save(s.id, rows);
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
