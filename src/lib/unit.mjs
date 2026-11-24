// 價格單位切換（100 克／1 斤／1 公斤）。伺服器端與瀏覽器端共用這一支，所以不得 import node 模組。
//
// 頁面上的價格一律以「每公斤幾元」存在 data-kg，畫面文字照使用者選的單位換算（1 斤＝600 公克＝0.6 公斤）。
// 預設是斤：買菜的人在攤子上聽到的是「一斤多少」。選擇存在 localStorage，全站同一份。
export const UNITS = [
  { key: 'g100', label: '100 克', per: '100克', kg: 0.1 },
  { key: 'catty', label: '1 斤', per: '斤', kg: 0.6 },
  { key: 'kg', label: '1 公斤', per: '公斤', kg: 1 },
];
export const DEFAULT_UNIT = 'catty';
export const UNIT_STORE = 'hk-unit';
export const CATTY_KG = 0.6;

// 花卉不能切：批發市場的切花以「把」成交，價格是元/把、交易量是把（2026-11-24 對過台北花卉產銷公司
// 月報「資料來源：農產品交易行情站，單位 元/把」的各市場數字，與本站原始資料逐筆相符）。
// 開放資料的欄位說明寫元/公斤，那是蔬果的單位，花卉照寫是錯的。所以花卉固定用這一個單位，不換算。
export const BUNCH = { key: 'bunch', label: '1 把', per: '把', kg: 1 };
export const unitOf = (key) => (key === BUNCH.key ? BUNCH : UNITS.find((u) => u.key === key) ?? UNITS.find((u) => u.key === DEFAULT_UNIT));
// 依種類代碼給「來源單位」的各種寫法：價格（元/公斤、元/把）、句中的「每公斤／每把」、交易量單位
export const tcUnit = (tc) => (tc === 'N06'
  ? { price: '元/把', per: '每把', one: '一把', vol: '把', chart: BUNCH.key }
  : { price: '元/公斤', per: '每公斤', one: '一公斤', vol: '公斤', chart: null });
export const perLabel = (key) => `元/${unitOf(key).per}`;
// 來源單位 → 每公斤：零售是元/台斤，毛豬批發是元/公斤，家禽蛋產地價是元/台斤
export const toKg = (v, srcUnit) => (v == null ? null : srcUnit === '元/台斤' || srcUnit === '元/斤' ? v / CATTY_KG : v);
export const fromKg = (perKg, key) => (perKg == null ? null : perKg * unitOf(key).kg);
// 十元以下留一位小數（100 克常常只有幾塊錢），以上取整數：攤子上沒有人喊 53.2 元
export const fmtNum = (v) => {
  if (v == null || !Number.isFinite(v)) return '—';
  const r = Math.round(v * 10) / 10;   // 先捨入再判斷，9.98 才不會變成「10.0」
  return r < 10 ? r.toFixed(1) : String(Math.round(v));
};
// data-kg 元素裡面的 HTML（數字與單位分開排版）。只放數字與固定字串，不會有注入問題。
// fmt＝'buy' 是買點那一行「38 以下可買」：它一定緊接在同單位的價格下面，單位不重複寫（手機上放不下）
// fmt＝'diff' 是買菜清單上「跟上次來比」：perKg 是帶正負號的差額（每公斤）
export const pxHtml = (perKg, key = DEFAULT_UNIT, fmt = '') => fmt === 'buy'
  ? `${fmtNum(fromKg(perKg, key))} 以下可買`
  : fmt === 'diff'
    ? `比上次${perKg < 0 ? '便宜' : '貴'} ${fmtNum(fromKg(Math.abs(perKg), key)).replace(/\.0$/, '')} 元`
    : `<b>${fmtNum(fromKg(perKg, key))}</b><small> ${perLabel(key)}</small>`;
// 瀏覽器端：使用者上次選的單位。私密視窗、封鎖網站資料時 localStorage 會丟例外，當成沒選過
export const storedUnit = () => {
  try { return unitOf(localStorage.getItem(UNIT_STORE)).key; } catch { return DEFAULT_UNIT; }
};
