// observation 層：append-only + contentHash（見 transform/STORAGE.md §3）
//
//   data/observation/current.parquet          每個鍵的現值雜湊 + 三個時間欄
//   data/observation/history/YYYY-MM/<ts>.parquet   被改掉的舊值，只新增不覆蓋
//
// 鍵 = (交易日期, 種類代碼, 市場代號, 作物代號)；雜湊 = hash(四個價格 + 交易量)
//
// 用法：
//   node transform/observe.mjs              # 比對最近 7 天（每日排程用）
//   node transform/observe.mjs --recent 30  # 比對最近 30 天
//   node transform/observe.mjs --all        # 全量比對（懷疑資料錯亂時才用，實測 17 秒）
//   node transform/observe.mjs --init       # 首次建立 current.parquet
import { mkdir, access, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect, one, q, OBS, PARQUET, OBS_SELECT, OBS_KEY, readL1, today } from './_db.mjs';

const CURRENT = join(OBS, 'current.parquet');
const exists = async (p) => access(p).then(() => true, () => false);
const KEYJOIN = OBS_KEY.map((k) => `t.${k} = o.${k}`).join(' AND ');

async function main() {
  const argv = process.argv.slice(2);
  const all = argv.includes('--all');
  const init = argv.includes('--init');
  const recentIdx = argv.indexOf('--recent');
  const recent = recentIdx >= 0 ? Number(argv[recentIdx + 1]) : 7;
  if (!Number.isInteger(recent) || recent < 1) throw new Error('--recent 要接天數');

  const con = await connect();
  await mkdir(OBS, { recursive: true });
  const now = new Date().toISOString();
  const day = today();

  // 要比對的 L1 範圍
  let scope = readL1();
  if (!all && !init) {
    const from = new Date(`${day}T00:00:00Z`);
    from.setUTCDate(from.getUTCDate() - (recent - 1));
    const days = [];
    for (let d = new Date(from); d.toISOString().slice(0, 10) <= day; d.setUTCDate(d.getUTCDate() + 1)) {
      const iso = d.toISOString().slice(0, 10);
      days.push(`'${PARQUET}/year=${iso.slice(0, 4)}/d-${iso}.parquet'`);
    }
    // 檔案可能不存在（休市或還沒轉），用 glob 容錯的方式逐檔讀
    scope = `read_parquet([${days.join(', ')}], hive_partitioning=true, union_by_name=true)`;
  }

  if (init || !(await exists(CURRENT))) {
    await con.run(`COPY (
      SELECT *, '${day}' AS first_observed_at, '${day}' AS last_verified_at, '${day}' AS last_changed_at
      FROM (${OBS_SELECT} FROM ${readL1()})
    ) TO '${CURRENT}' (FORMAT parquet, COMPRESSION zstd)`);
    const s = await one(con, `SELECT count(*)::VARCHAR n FROM read_parquet('${CURRENT}')`);
    console.error(`初始化 current.parquet：${s.n} 列`);
    return;
  }

  // 今天這批（可能因為休市而讀不到某些檔）
  try {
    await con.run(`CREATE TEMP TABLE t AS ${OBS_SELECT} FROM ${scope}`);
  } catch (e) {
    console.error(`讀取比對範圍失敗（可能是該期間沒有任何 L1 檔）：${e.message.split('\n')[0]}`);
    return;
  }
  await con.run(`CREATE TEMP TABLE o AS SELECT * FROM read_parquet('${CURRENT}')`);

  const changed = await one(con, `SELECT count(*)::VARCHAR n FROM t JOIN o ON ${KEYJOIN} WHERE t.content_hash <> o.content_hash`);
  const added = await one(con, `SELECT count(*)::VARCHAR n FROM t LEFT JOIN o ON ${KEYJOIN} WHERE o.content_hash IS NULL`);
  const same = await one(con, `SELECT count(*)::VARCHAR n FROM t JOIN o ON ${KEYJOIN} WHERE t.content_hash = o.content_hash`);

  // 有修正就把舊值留檔（append-only：檔名帶時間戳，不覆蓋任何既有檔）
  if (Number(changed.n) > 0) {
    const month = day.slice(0, 7);
    const dir = join(OBS, 'history', month);
    await mkdir(dir, { recursive: true });
    const file = join(dir, `${now.replace(/[:.]/g, '-')}.parquet`);
    await con.run(`COPY (
      SELECT o.*, '${now}' AS superseded_at, t.content_hash AS new_content_hash
      FROM o JOIN t ON ${KEYJOIN} WHERE t.content_hash <> o.content_hash
    ) TO '${file}' (FORMAT parquet, COMPRESSION zstd)`);
    console.error(`事後修正 ${changed.n} 列 → ${file}`);
  }

  // 重寫 current：改過的換新雜湊、沒見到的保留、新的加進來
  await con.run(`CREATE TEMP TABLE merged AS
    SELECT o.${OBS_KEY.join(', o.')},
           coalesce(t.content_hash, o.content_hash) AS content_hash,
           o.first_observed_at,
           CASE WHEN t.content_hash IS NULL THEN o.last_verified_at ELSE '${day}' END AS last_verified_at,
           CASE WHEN t.content_hash IS NOT NULL AND t.content_hash <> o.content_hash THEN '${day}' ELSE o.last_changed_at END AS last_changed_at
      FROM o LEFT JOIN t ON ${KEYJOIN}
    UNION ALL
    SELECT t.${OBS_KEY.join(', t.')}, t.content_hash, '${day}', '${day}', '${day}'
      FROM t LEFT JOIN o ON ${KEYJOIN} WHERE o.content_hash IS NULL`);
  await con.run(`COPY merged TO '${CURRENT}' (FORMAT parquet, COMPRESSION zstd)`);

  const total = await one(con, `SELECT count(*)::VARCHAR n FROM read_parquet('${CURRENT}')`);
  console.error(`比對範圍 ${all ? '全量' : `最近 ${recent} 天`}：未變 ${same.n}、修正 ${changed.n}、新增 ${added.n} → current ${total.n} 列`);

  await writeFile(join(OBS, 'observe.meta.json'), JSON.stringify({
    ranAt: now, scope: all ? 'all' : `recent-${recent}`,
    unchanged: same.n, changed: changed.n, added: added.n, currentRows: total.n,
  }, null, 1) + '\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
