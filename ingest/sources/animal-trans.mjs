// 畜禽交易行情：毛豬（批發市場）與家禽產地價（白肉雞／雞蛋／鵝／鴨／紅羽土雞）。
// 用法：node ingest/sources/animal-trans.mjs [id ...]  → ingest/raw/<id>.json.gz
//
// 與 farm-trans 不同，這幾支**一次就能抓到全部歷史**（合計約 11.6 萬列），
// 所以每天整份覆蓋，不做按日分檔。實測筆數與起訖日：
//   hog          99,898 列  民國 098.11.27 起（交易日期是民國年 YYYMMDD）
//   chicken-egg   5,802 列  2010/10/07 起（日期是西元 YYYY/MM/DD）
//   goose-duck    5,802 列  2010/10/07 起
//   red-chicken   4,549 列  2014/04/01 起
//
// 端點名稱是從各資料集頁面原始碼取得的，不是猜的；UnitId 對 AnimalTransData 無效
// （四個 UnitId 都回毛豬），真正決定資料的是 aspx 檔名。
import { fileURLToPath } from 'node:url';
import { SERVICE, getPaged, save } from './_moa.mjs';

const M = `${SERVICE}/FromM`;

export const sources = [
  { id: 'hog', name: '毛豬交易行情', dateField: '交易日期', roc: true,
    url: `${M}/AnimalTransData.aspx?IsTransData=1&UnitId=026` },
  { id: 'chicken-egg', name: '家禽交易行情（白肉雞／雞蛋）', dateField: '日期', roc: false,
    url: `${M}/PoultryTransBoiledChickenData.aspx?IsTransData=1&UnitId=056` },
  { id: 'goose-duck', name: '家禽交易行情（肉鵝／番鴨／鴨蛋）', dateField: '日期', roc: false,
    url: `${M}/PoultryTransGooseDuckData.aspx?IsTransData=1&UnitId=058` },
  { id: 'red-chicken', name: '家禽交易行情（紅羽土雞）', dateField: '日期', roc: false,
    url: `${M}/PoultryTransLocalRedChickenData.aspx?IsTransData=1&UnitId=080` },
];

async function main() {
  const want = process.argv.slice(2);
  for (const s of sources) {
    if (want.length && !want.includes(s.id)) continue;
    const rows = await getPaged(s.url);
    if (!rows.length) throw new Error(`${s.id}: 回傳 0 列`);
    await save(`animal-${s.id}`, rows);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
