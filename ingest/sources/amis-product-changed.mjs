// 農產品批發市場交易行情站「品名代碼沿革」：代碼新增／更名／合併／改作他用的官方紀錄。
// 只有 HTML，這裡把表格原樣轉成 [{section, code, name, note}]，note 不解析。
// 用法：node ingest/sources/amis-product-changed.mjs → ingest/raw/amis-product-changed.json.gz
import { fileURLToPath } from 'node:url';
import { save } from './_moa.mjs';

export const meta = {
  id: 'amis-product-changed',
  name: '品名代碼沿革',
  org: '農業部農糧署',
  homepage: 'https://amis.afa.gov.tw/main/ProductChanged.aspx',
  license: '政府網站資料開放宣告',
  updateFreq: 'UNVERIFIED',
  format: 'html',
  entity: 'reference',
  endpoints: ['https://amis.afa.gov.tw/main/ProductChanged.aspx'],
  recordCount: 126,
  verifiedAt: '2026-09-11',
};

const text = (s) => s.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();

export async function fetchRaw() {
  const res = await fetch(meta.endpoints[0], {
    headers: { 'User-Agent': 'hokhong.tw-ingest/0.1 (+https://hokhong.tw)' },
    signal: AbortSignal.timeout(90_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = (await res.text()).replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, '');
  const rows = [];
  let section = null;
  for (const [, tr] of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
    const cells = [...tr.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map((m) => text(m[1])).filter((c, i, a) => a.some(Boolean));
    if (cells.length === 1 && ['蔬菜', '水果', '花卉', '盆花'].includes(cells[0])) section = cells[0];
    else if (cells.length === 3 && section && cells[0] !== '品名代號') rows.push({ section, code: cells[0], name: cells[1], note: cells[2] });
  }
  return rows;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await save(meta.id, await fetchRaw());
