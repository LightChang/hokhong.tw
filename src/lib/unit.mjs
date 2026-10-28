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

export const unitOf = (key) => UNITS.find((u) => u.key === key) ?? UNITS.find((u) => u.key === DEFAULT_UNIT);
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
// data-kg 元素裡面的 HTML（數字與單位分開排版）。只放數字與固定字串，不會有注入問題
export const pxHtml = (perKg, key = DEFAULT_UNIT) =>
  `<b>${fmtNum(fromKg(perKg, key))}</b><small> ${perLabel(key)}</small>`;
// 瀏覽器端：使用者上次選的單位。私密視窗、封鎖網站資料時 localStorage 會丟例外，當成沒選過
export const storedUnit = () => {
  try { return unitOf(localStorage.getItem(UNIT_STORE)).key; } catch { return DEFAULT_UNIT; }
};
