// 零售端資料。
//   taichung-retail：臺中市公有零售市場每日蔬果價格（元/台斤，0 = 當日未訪價）。來源只保留近一年，要自己每日累積。
//   dgbas-cpi-items：主計總處 消費者物價基本分類暨項目群指數（月，2013 起，指數非價格）。
// 用法：NODE_EXTRA_CA_CERTS=ingest/certs/twca-secure-ssl-2023g3.pem node ingest/sources/retail.mjs [id ...]
//   ws.dgbas.gov.tw 送出的憑證鏈缺 TWCA 中繼憑證（curl 靠 macOS keychain 過得了，Node 不行），
//   中繼憑證取自其 AIA：http://sslserver.twca.com.tw/cacert/secure_sha2_2023G3.crt
//   taichung-retail 寫 ingest/raw/taichung-retail/YYYY-MM-DD.json.gz（以抓取日命名，不覆蓋舊檔）
//   dgbas-cpi-items 寫 ingest/raw/dgbas-cpi-items.xml.gz（原始 XML）
import { mkdir, writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RAW, getJson } from './_moa.mjs';

export const sources = [
  {
    id: 'taichung-retail',
    name: '臺中市政府公有零售市場每日蔬果價格表',
    org: '臺中市政府經濟發展局',
    homepage: 'https://data.gov.tw/dataset/84539',
    url: 'https://newdatacenter.taichung.gov.tw/api/v1/no-auth/resource.download?rid=495aff49-3547-4055-aacd-f0781c6f733e',
  },
  {
    id: 'dgbas-cpi-items',
    name: '消費者物價基本分類暨項目群指數',
    org: '行政院主計總處',
    homepage: 'https://data.gov.tw/dataset/9158',
    url: 'https://ws.dgbas.gov.tw/001/Upload/461/relfile/11525/230543/pr0101a3m.xml',
  },
];

async function main() {
  const want = process.argv.slice(2);
  const today = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
  for (const s of sources) {
    if (want.length && !want.includes(s.id)) continue;
    if (s.id === 'taichung-retail') {
      const rows = await getJson(s.url);
      await mkdir(join(RAW, s.id), { recursive: true });
      await writeFile(join(RAW, s.id, `${today}.json.gz`), gzipSync(JSON.stringify(rows)));
      console.error(`${s.id}: ${rows.length} rows`);
    } else {
      const res = await fetch(s.url, { signal: AbortSignal.timeout(180_000) });
      if (!res.ok) throw new Error(`${s.id}: HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      await writeFile(join(RAW, `${s.id}.xml.gz`), gzipSync(buf));
      console.error(`${s.id}: ${buf.length} bytes`);
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
