// 「回報資料錯誤」的收件信箱（站主 2026-11-15 決定：五站一律用 service@yao.care，不用 GitHub issue、不用 Google 表單）。
// /about/ 與每頁頁尾的「回報資料錯誤」連結都由 correctionMailto() 產生；只改這裡，不要在頁面另寫信箱。
export const CORRECTION_EMAIL = 'service@yao.care';

/**
 * 預先填好主旨與欄位範本的 mailto 連結；pageUrl 是目前頁面的正式網址，拿不到就留空讓人自己填。
 * 主旨與內文用 encodeURIComponent：URLSearchParams 會把空白編成「+」，在郵件裡原樣顯示成加號。
 */
export function correctionMailto(pageUrl = '') {
  const subject = '[hokhong.tw] 資料錯誤回報';
  const body = [
    `資料頁：${pageUrl}`,
    '',
    '錯誤欄位：',
    '',
    '正確內容：',
    '',
    '來源證明（公告網址、截圖或聯絡方式）：',
    '',
    '是否為當事單位（是／否，單位名稱）：',
  ].join('\n');
  return `mailto:${CORRECTION_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}
