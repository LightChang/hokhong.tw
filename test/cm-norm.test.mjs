// 品項×市場頁「這個市場平常比全國貴還是便宜」的判準（transform/cm-norm.mjs）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normFor, rankMarkets, MIN_MONTH_VOLUME, MIN_MONTH_DAYS, MIN_MONTHS } from '../transform/cm-norm.mjs';

const yms = (n, last = '2026-10') => {
  let [y, m] = last.split('-').map(Number);
  const out = [];
  for (let i = 0; i < n; i++) { out.unshift(`${y}-${String(m).padStart(2, '0')}`); m -= 1; if (!m) { m = 12; y -= 1; } }
  return out;
};
const nat = (n = 24) => yms(n).map((ym) => ({ ym, price: 100 }));
const mkt = (prices, { volume = MIN_MONTH_VOLUME, days = MIN_MONTH_DAYS } = {}) => {
  const ys = yms(prices.length);
  return prices.map((price, i) => ({ ym: ys[i], price, volume, days }));
};

test('一年都比全國便宜：偏便宜，月份數正確', () => {
  const r = normFor(mkt(Array(12).fill(80)), nat());
  assert.equal(r.lean, 'cheaper');
  assert.equal(r.months, 12);
  assert.equal(r.cheaper, 12);
});

test('低交易量的月份不算，湊不滿有效月份就不給（三重芥藍那種）', () => {
  const r = normFor(mkt(Array(12).fill(19), { volume: 2_000 }), nat());
  assert.equal(r, null);
  const few = normFor(mkt(Array(MIN_MONTHS - 1).fill(80)), nat());
  assert.equal(few, null);
});

test('交易日太少的月份（例如剛開始的月份）不算', () => {
  const m = mkt(Array(12).fill(80));
  m.at(-1).days = 3; m.at(-1).price = 300;
  const r = normFor(m, nat());
  assert.equal(r.months, 11);
  assert.equal(r.lean, 'cheaper');
});

test('超過一年前的月份不算', () => {
  const m = mkt([...Array(12).fill(150), ...Array(6).fill(80)]);
  const r = normFor(m, nat());
  assert.equal(r.months, 12);
  assert.equal(r.cheaper, 6);
  assert.equal(r.dearer, 6);
  assert.equal(r.lean, 'mixed');
});

test('差距在 3% 內算差不多', () => {
  const r = normFor(mkt([101, 99, 102, 98, 100, 100, 120, 80]), nat());
  assert.equal(r.similar, 6);
  assert.equal(r.lean, 'similar');
});

test('排名：中位數低的在前；可排市場不到 3 個就不給', () => {
  const a = normFor(mkt(Array(8).fill(80)), nat());
  const b = normFor(mkt(Array(8).fill(120)), nat());
  const two = new Map([['b', b], ['a', a]]);
  rankMarkets(two);
  assert.equal(a.rank, undefined);
  const c = normFor(mkt(Array(8).fill(100)), nat());
  rankMarkets(new Map([['b', b], ['a', a], ['c', c]]));
  assert.deepEqual([a.rank, c.rank, b.rank, a.of], [1, 2, 3, 3]);
});
