// 農業部資料的台灣轉發（GCP Cloud Run，asia-east1 彰化機房）。
//
// 2026-10-22 起 data.moa.gov.tw、amis.afa.gov.tw 從 GitHub runner（境外 IP）一律連不上，
// 每日排程改從這裡出去：GET /<RELAY_KEY>/<host>/<path>?<query> → https://<host>/<path>?<query>
// 只轉發 GET、只轉發下面兩個主機，金鑰不對一律 404（不是開放代理）。
// 部署：relay/moa/deploy.sh（直接用 node 官方映像、程式碼放環境變數，不需要 Cloud Build）。
// 刻意是 CommonJS、沒有相依：部署時是 node -e 執行這段原始碼。
const http = require('node:http');

const KEY = process.env.RELAY_KEY;
const HOSTS = new Set(['data.moa.gov.tw', 'amis.afa.gov.tw']);

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://relay');
  const [, key, host, ...rest] = u.pathname.split('/');
  if (!KEY || key !== KEY || !HOSTS.has(host) || req.method !== 'GET') {
    res.writeHead(404).end();
    return;
  }
  const target = `https://${host}/${rest.join('/')}${u.search}`;
  const t0 = Date.now();
  try {
    const r = await fetch(target, {
      headers: { 'User-Agent': req.headers['user-agent'] ?? 'hokhong.tw-relay' },
      signal: AbortSignal.timeout(240_000),
    });
    const body = Buffer.from(await r.arrayBuffer());
    res.writeHead(r.status, { 'content-type': r.headers.get('content-type') ?? 'application/octet-stream' });
    res.end(body);
    console.log(`${r.status} ${host}/${rest.join('/')} ${body.length}B ${Date.now() - t0}ms`);
  } catch (e) {
    // 轉發端也連不上時回 502 並帶上底層原因，ingest 那邊的錯誤訊息才看得出是哪一段斷的
    const why = `${e.message}${e.cause ? ` (${e.cause.code ?? e.cause.message})` : ''}`;
    res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' }).end(`relay: ${why}`);
    console.log(`502 ${host}/${rest.join('/')} ${why} ${Date.now() - t0}ms`);
  }
}).listen(Number(process.env.PORT ?? 8080));
