import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateHtml, filterIssues, extractJsonLd, globToRegExp, loadRules } from './validate.mjs';

const rules = await loadRules();
const page = (...objs) =>
  `<!doctype html><html><head>${objs
    .map((o) => `<script type="application/ld+json">${typeof o === 'string' ? o : JSON.stringify(o)}</script>`)
    .join('')}</head><body><p>x</p></body></html>`;

const goodEvent = () => ({
  '@context': 'https://schema.org',
  '@type': 'Event',
  name: '臺北爵士夜',
  startDate: '2026-10-03T19:30:00+08:00',
  endDate: '2026-10-03',
  url: 'https://seh.tw/event/jazz-night',
  image: ['https://seh.tw/img/jazz.jpg'],
  location: {
    '@type': 'Place',
    name: '大稻埕戲苑',
    address: { '@type': 'PostalAddress', streetAddress: '迪化街一段21號', addressLocality: '臺北市', addressCountry: 'TW' },
  },
  offers: { '@type': 'Offer', price: 0, priceCurrency: 'TWD', url: 'https://seh.tw/event/jazz-night' },
});
const codes = (issues) => filterIssues(issues, 'warning').map((i) => i.code);

test('合格：Event、BreadcrumbList、WebSite 無錯誤', () => {
  const html = page(goodEvent(), {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: '首頁', item: 'https://seh.tw/' },
      { '@type': 'ListItem', position: 2, name: '爵士夜' },
    ],
  }, { '@context': 'https://schema.org', '@type': 'WebSite', name: 'seh.tw', url: 'https://seh.tw/' });
  const site = { pages: [{ match: '/event/**', require: ['Event'] }] };
  assert.deepEqual(codes(validateHtml(html, { page: '/event/jazz-night.html', rules, site })), []);
});

test('缺必填：Event 沒有 location、startDate', () => {
  const ev = goodEvent();
  delete ev.location;
  delete ev.startDate;
  const issues = validateHtml(page(ev), { page: '/e', rules });
  const missing = issues.filter((i) => i.code === 'missing-required').map((i) => i.path).sort();
  assert.deepEqual(missing, ['location', 'startDate']); // location.address 不重複報
  assert.ok(issues.every((i) => i.source?.startsWith('https://')));
});

test('缺必填：BreadcrumbList 中間項缺 item（最後一項可省略）', () => {
  const html = page({
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'A' },
      { '@type': 'ListItem', position: 2, name: 'B' },
    ],
  });
  const paths = validateHtml(html, { page: '/b/', rules }).filter((i) => i.code === 'missing-required').map((i) => i.path);
  assert.deepEqual(paths, ['itemListElement[0].item']);
});

test('相對網址', () => {
  const ev = goodEvent();
  ev.url = '/event/jazz-night';
  ev.image = ['img/jazz.jpg'];
  const rel = validateHtml(page(ev), { page: '/e', rules }).filter((i) => i.code === 'relative-url');
  assert.equal(rel.length, 2);
  assert.equal(rel[0].severity, 'error');
});

test('日期有時間但缺時區；只有日期合法；午夜列警告', () => {
  const ev = goodEvent();
  ev.startDate = '2026-10-03T19:30';
  ev.endDate = '2026-10-04T00:00:00+08:00';
  const issues = validateHtml(page(ev), { page: '/e', rules });
  const tz = issues.filter((i) => i.code === 'date-no-timezone');
  assert.equal(tz.length, 1);
  assert.equal(tz[0].path, 'startDate');
  assert.equal(tz[0].severity, 'error');
  assert.equal(issues.filter((i) => i.code === 'date-midnight')[0].severity, 'warning');
  ev.startDate = '2026/10/03';
  assert.ok(codes(validateHtml(page(ev), { page: '/e', rules })).includes('date-format'));
});

test('JSON 壞掉', () => {
  const issues = validateHtml(page('{"@type":"Event",}'), { page: '/e', rules });
  assert.deepEqual(issues.map((i) => i.code), ['json-parse']);
});

test('</script> 截斷：偵測並仍驗其餘內容', () => {
  const ev = goodEvent();
  ev.description = '注意 </script> 會截斷';
  const html = `<head><script type="application/ld+json">${JSON.stringify(ev)}</script></head>`;
  assert.equal(extractJsonLd(html)[0].truncated, true);
  const c = codes(validateHtml(html, { page: '/e', rules }));
  assert.deepEqual(c, ['script-truncated']);
  // 正確跳脫就沒事
  const safe = `<script type="application/ld+json">${JSON.stringify(ev).replace(/</g, '\\u003c')}</script>`;
  assert.deepEqual(codes(validateHtml(safe, { page: '/e', rules })), []);
});

test('淘汰類型：FAQPage（巢在 @graph 也抓得到），站台可調嚴重度', () => {
  const html = page({
    '@context': 'https://schema.org',
    '@graph': [{ '@type': 'FAQPage', mainEntity: [{ '@type': 'Question', name: 'Q', acceptedAnswer: { '@type': 'Answer', text: 'A' } }] }],
  });
  const dep = validateHtml(html, { page: '/f/', rules }).filter((i) => i.code === 'deprecated-type');
  assert.equal(dep.length, 1);
  assert.equal(dep[0].type, 'FAQPage');
  assert.equal(dep[0].severity, 'warning');
  const strict = validateHtml(html, { page: '/f/', rules, site: { severity: { 'deprecated-type': 'error' } } });
  assert.equal(filterIssues(strict, 'error').length, 1);
});

test('站台設定：頁型缺必要類型', () => {
  const site = { pages: [{ match: '/course/*.html', require: ['Course'] }] };
  const issues = validateHtml(page({ '@context': 'https://schema.org', '@type': 'WebPage', url: 'https://kho.tw/course/a.html' }), {
    page: '/course/a.html', rules, site,
  });
  assert.deepEqual(issues.map((i) => [i.code, i.type]), [['missing-page-type', 'Course']]);
});

test('LocalBusiness 子類型（Hospital）套用 LocalBusiness 必填；Museum 不套用', () => {
  const hosp = { '@context': 'https://schema.org', '@type': 'Hospital', name: '某醫院' };
  assert.deepEqual(validateHtml(page(hosp), { page: '/p/', rules }).map((i) => i.path), ['address']);
  const museum = { '@context': 'https://schema.org', '@type': 'Museum', name: '某館' };
  assert.deepEqual(validateHtml(page(museum), { page: '/v', rules }), []);
});

test('globToRegExp', () => {
  assert.ok(globToRegExp('/event/*').test('/event/a.html'));
  assert.ok(!globToRegExp('/event/*').test('/event/a/b.html'));
  assert.ok(globToRegExp('/crop/**').test('/crop/a/b/'));
});

test('ItemList carousel 規則是 optIn：站台 apply 才檢查', () => {
  const list = { '@context': 'https://schema.org', '@type': 'ItemList', itemListElement: [{ '@type': 'ListItem', position: 1, name: 'A' }] };
  assert.deepEqual(validateHtml(page(list), { page: '/open.html', rules }), []);
  const site = { pages: [{ match: '/open.html', apply: ['ItemList'] }] };
  const c = validateHtml(page(list), { page: '/open.html', rules, site }).map((i) => i.code).sort();
  assert.deepEqual(c, ['min-items', 'missing-required']);
});
