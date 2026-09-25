// 資料完整性檢查：L1 的上千萬列，有多少進到聚合層？被擋掉的是什麼？（現況數字看輸出，不寫在註解裡）
//
// 聚合層（aggregate.mjs）會排除三種列：rest 休市記錄、交易量 <= 0、作物身分 confidence < 0.8。
// 這支把每一層的量拆出來，確認「少掉的列」都是預期的，不是 join 寫錯或身分表漏了。
// 每日 pipeline 應該跑它，數字突然變化就是有問題。
//
// 用法：node transform/check-coverage.mjs
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect, one, q, DATA, readL1, J } from './_db.mjs';

const rd = (v) => (v == null ? null : +Number(v).toFixed(2));

const MAP = join(DATA, 'identity', 'crop-map.parquet');

async function main() {
  const con = await connect();

  await con.run(`CREATE TEMP TABLE j AS
    SELECT t."交易日期" AS d, coalesce(t."種類代碼", '') AS tc, t."作物代號" AS code,
           t."交易量" AS volume, t."平均價" AS price,
           m.rule, m.confidence, m.plv3_key
      FROM ${readL1()} t
      LEFT JOIN read_parquet('${MAP}') m
        ON m.crop_code = t."作物代號" AND m.tc_type = coalesce(t."種類代碼", '')`);

  const total = await one(con, `SELECT count(*)::VARCHAR n, sum(volume)::VARCHAR v FROM j`);
  const steps = await q(con, `
    SELECT '1 全部 L1' AS step, count(*)::VARCHAR n, coalesce(sum(volume), 0)::VARCHAR v FROM j
    UNION ALL SELECT '2 rest 休市列', count(*)::VARCHAR, coalesce(sum(volume), 0)::VARCHAR FROM j WHERE code = 'rest'
    UNION ALL SELECT '3 交易量 <= 0（非 rest）', count(*)::VARCHAR, coalesce(sum(volume), 0)::VARCHAR FROM j WHERE code <> 'rest' AND (volume IS NULL OR volume <= 0)
    UNION ALL SELECT '4 身分表查不到（join 失敗）', count(*)::VARCHAR, coalesce(sum(volume), 0)::VARCHAR FROM j WHERE code <> 'rest' AND volume > 0 AND rule IS NULL
    UNION ALL SELECT '5 confidence < 0.8', count(*)::VARCHAR, coalesce(sum(volume), 0)::VARCHAR FROM j WHERE code <> 'rest' AND volume > 0 AND confidence < 0.8
    UNION ALL SELECT '6 進入聚合層', count(*)::VARCHAR, coalesce(sum(volume), 0)::VARCHAR FROM j WHERE code <> 'rest' AND volume > 0 AND confidence >= 0.8
    ORDER BY 1`);
  console.error(`L1 總計 ${Number(total.n).toLocaleString()} 列 / ${Math.round(Number(total.v)).toLocaleString()} 公斤`);
  for (const s of steps) {
    console.error(`  ${s.step.padEnd(28)} ${String(Number(s.n).toLocaleString()).padStart(12)} 列  ${(Number(s.n) / Number(total.n) * 100).toFixed(2).padStart(6)}%  交易量 ${(Number(s.v) / Number(total.v) * 100).toFixed(2).padStart(6)}%`);
  }

  // 2 + 3 + 5 + 6 應該等於總數（4 應為 0：身分表是從 L1 長出來的，不該有查不到的）
  const sum = steps.filter((s) => /^[2356]/.test(s.step)).reduce((a, s) => a + Number(s.n), 0);
  console.error(sum === Number(total.n)
    ? '對帳：2+3+5+6 = 全部 L1 ✓'
    : `⚠ 對帳失敗：2+3+5+6 = ${sum.toLocaleString()}，但 L1 是 ${Number(total.n).toLocaleString()}（差 ${(Number(total.n) - sum).toLocaleString()}）`);
  const orphan = steps.find((s) => s.step.startsWith('4'));
  if (Number(orphan.n) > 0) console.error(`⚠ 有 ${orphan.n} 列在身分表查不到 → identify.mjs 沒跑或 L1 更新了但身分表沒重算`);

  // 負的交易量：對帳時「交易量 <= 0」那列顯示 -0.00%，表示有負值。這是來源的資料品質問題，要看清楚。
  const neg = await one(con, `SELECT count(*)::VARCHAR n, coalesce(sum(volume), 0)::VARCHAR v, min(volume)::VARCHAR worst FROM j WHERE volume < 0`);
  if (Number(neg.n) > 0) {
    const negTop = await q(con, `SELECT d, tc, code, volume::VARCHAR volume, price::VARCHAR price FROM j WHERE volume < 0 ORDER BY volume LIMIT 5`);
    console.error(`⚠ 負交易量 ${neg.n} 列（合計 ${neg.v} 公斤，最負 ${neg.worst}）：${J(negTop)}`);
    console.error('   → 聚合層已用 "交易量 > 0" 擋掉，但這是來源本身的錯誤資料，值得回報給農糧署');
  } else {
    console.error('負交易量：0 列');
  }

  // 被擋掉的交易量集中在哪些代碼（人工補對應時的優先序）
  // "rule" 是 DuckDB 保留字，別名要避開（同 "rows"、"days"）
  const top = await q(con, `SELECT code, any_value(tc) tc, any_value(rule) rule_id, count(*)::VARCHAR n, round(sum(volume))::VARCHAR vol
    FROM j WHERE code <> 'rest' AND volume > 0 AND confidence < 0.8 GROUP BY 1 ORDER BY sum(volume) DESC LIMIT 8`);
  console.error(`未納入聚合、交易量最大的代碼：`);
  for (const r of top) console.error(`  ${r.tc.padEnd(4)} ${r.code.padEnd(8)} ${(r.rule_id ?? '—').padEnd(16)} ${Number(r.vol).toLocaleString()} 公斤`);

  // 逐年覆蓋率：某一年突然掉下來，代表那年有新代碼還沒對應
  const byYear = await q(con, `SELECT CAST(substr(d, 1, 3) AS INT) + 1911 AS year,
      round(100.0 * sum(CASE WHEN code <> 'rest' AND volume > 0 AND confidence >= 0.8 THEN volume ELSE 0 END) / nullif(sum(CASE WHEN code <> 'rest' THEN volume ELSE 0 END), 0), 2) AS pct
    FROM j GROUP BY 1 ORDER BY 1`);
  console.error(`逐年交易量覆蓋率：${byYear.map((r) => `${r.year}:${r.pct}%`).join(' ')}`);

  // 依種類的交易量覆蓋率：花卉的官方統一代碼本來就不全，蔬果幾乎全覆蓋。
  // 站上 /about/ 會直接引用這三個數字，所以要算進 meta，不能讓頁面寫死。
  const byType = await q(con, `SELECT tc, round(100.0 * sum(CASE WHEN confidence >= 0.8 THEN volume ELSE 0 END)
      / nullif(sum(volume), 0), 2) AS pct
    FROM j WHERE code <> 'rest' AND volume > 0 GROUP BY 1 ORDER BY 1`);
  console.error(`依種類交易量覆蓋率：${byType.map((r) => `${r.tc || '（空）'}:${r.pct}%`).join(' ')}`);

  await writeFile(join(DATA, 'coverage.meta.json'), JSON.stringify({
    checkedAt: new Date().toISOString(),
    l1Rows: total.n, steps: steps.map((s) => ({ step: s.step, rows: s.n, volume: s.v })),
    reconciled: sum === Number(total.n), orphanRows: orphan.n,
    negVolume: { rows: neg.n, total: rd(neg.v), worst: rd(neg.worst) },
    byType: Object.fromEntries(byType.map((r) => [r.tc || '', r.pct])),
    byYear: Object.fromEntries(byYear.map((r) => [Number(r.year), r.pct])),
  }, null, 1) + '\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
