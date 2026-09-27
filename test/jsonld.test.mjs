// node --test test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildJsonLd, serializeJsonLd, rocToIso } from '../src/lib/jsonld.mjs';
import { extractJsonLd, validateHtml, filterIssues } from '../vendor/seo-ops-jsonld/validate.mjs';

const rules = JSON.parse(readFileSync(new URL('../vendor/seo-ops-jsonld/rules.json', import.meta.url), 'utf-8'));
const page = (objs) =>
  `<!doctype html><html><head>${objs
    .map((o) => `<script type="application/ld+json">${serializeJsonLd(o)}</script>`)
    .join('')}</head><body><p>x</p></body></html>`;

test('值含 </script> 時輸出仍完整、可解析、資料不變', () => {
  const evil = '高麗菜</script><script>alert(1)</script><!-- x';
  const obj = { '@context': 'https://schema.org', '@type': 'WebSite', name: evil, url: 'https://hokhong.tw/' };
  const out = serializeJsonLd(obj);
  assert.ok(!out.includes('<'), '輸出不得含 <');
  const html = page([obj]);
  const blocks = extractJsonLd(html);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].truncated, false);
  assert.equal(blocks[0].parseError, null);
  assert.deepEqual(blocks[0].data, obj);
  const errs = filterIssues(validateHtml(html, { page: '/', rules }), 'error');
  assert.deepEqual(errs, []);
});

test('未跳脫的寫法會被驗證器抓到（對照組）', () => {
  const obj = { '@context': 'https://schema.org', '@type': 'WebSite', name: 'a</script>b', url: 'https://hokhong.tw/' };
  const html = `<script type="application/ld+json">${JSON.stringify(obj)}</script>`;
  const codes = validateHtml(html, { page: '/', rules }).map((i) => i.code);
  assert.ok(codes.includes('script-truncated'));
});

test('rocToIso', () => {
  assert.equal(rocToIso('115/09/26'), '2026-09-26');
  assert.equal(rocToIso(undefined), null);
});

test('完整一頁的輸出通過官方規則、不含 FAQPage', () => {
  const blocks = buildJsonLd({
    site: 'https://hokhong.tw',
    url: 'https://hokhong.tw/meat/hog/',
    title: '毛豬 — 好康',
    description: '毛豬目前 80 元/公斤',
    lastDate: '115/09/26',
    crumbs: [{ name: '肉蛋', path: '/meat/' }, { name: '毛豬', path: '/meat/hog/' }],
    dataset: {
      name: '毛豬批發市場成交價',
      description: '毛豬的批發市場成交價：毛豬 月均價（元/公斤）與近 90 天每日報價。資料來源：農業部毛豬交易行情，更新至民國 115/09/26。',
      temporalStart: '2009-11-01',
      unit: '元/公斤',
    },
    itemList: [{ name: '雞蛋', path: '/meat/egg-farm/' }, { name: '鵝', path: '/meat/goose/' }],
  });
  const types = blocks.map((b) => b['@type']);
  assert.deepEqual(types, ['WebSite', 'Organization', 'WebPage', 'BreadcrumbList', 'Dataset', 'ItemList']);
  const errs = filterIssues(validateHtml(page(blocks), { page: '/meat/hog/', rules }), 'warning');
  assert.deepEqual(errs, []);
});
