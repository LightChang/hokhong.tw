// 全站 JSON-LD 的唯一產生處。頁面只把資料交給 Base.astro（crumbs／dataset／itemList），
// Base 交給 components/JsonLd.astro，由這裡組成物件、再由 serializeJsonLd 安全輸出。
//
// 規則依據：/mnt/yao-care/seo-ops/jsonld（2026-09-27 官方文件查證，repo 內副本在 vendor/seo-ops-jsonld）。
// 站台頁型要求在 jsonld-pages.json；部署前由 `node scripts/seo-audit.mjs jsonld` 驗證，有錯誤就不部署。
//
// 不輸出的類型與理由（rules.json → deprecatedTypes）：
// - FAQPage：Google 2026-05-07 起全面停止顯示。頁面上的問句標題與答案句照舊，只是不再標記。

const LICENSE = 'https://data.gov.tw/license';
const PUBLISHER = { '@type': 'GovernmentOrganization', name: '農業部農糧署', url: 'https://www.afa.gov.tw/' };
export const SITE_NAME = '好康 hó-khang';

/** 民國「115/09/26」→ 西元「2026-09-26」；格式不符回傳 null */
export function rocToIso(roc) {
  const m = /^(\d+)\/(\d{2})\/(\d{2})$/.exec(roc ?? '');
  return m ? `${Number(m[1]) + 1911}-${m[2]}-${m[3]}` : null;
}

/**
 * 字串化並跳脫 `<`。HTML 規範：script 內容遇到 `</script` 就結束，`<!--`、`<script` 也會改變解析狀態；
 * JSON 裡的 `<` 解析回來仍是 `<`，所以資料不變。來源見 rules.json → global.scriptContent。
 */
export function serializeJsonLd(obj) {
  return JSON.stringify(obj).replace(/</g, '\\u003c');
}

/**
 * 麵包屑的完整路徑（首頁那一層這裡補）。畫面上的麵包屑（components/Breadcrumbs.astro）與
 * BreadcrumbList 都從這裡取，兩邊不會各寫一份。
 * @param {{name:string,path:string}[]} crumbs
 */
export function crumbTrail(crumbs) {
  return crumbs?.length ? [{ name: '首頁', path: '/' }, ...crumbs] : [];
}

/**
 * @param {object} p
 * @param {string} p.site      站台根網址，不含結尾斜線
 * @param {string} p.url       本頁 canonical
 * @param {string} p.title
 * @param {string} [p.description]
 * @param {string} [p.lastDate]  民國日期（頁面顯示用的同一個值）
 * @param {{name:string,path:string}[]} [p.crumbs]  首頁那一層這裡自己補
 * @param {object} [p.dataset]
 * @param {{name:string,path:string}[]} [p.itemList]
 * @returns {object[]}
 */
export function buildJsonLd({ site, url, title, description, lastDate, crumbs, dataset, itemList }) {
  const lastDateIso = rocToIso(lastDate);
  return [
    {
      '@context': 'https://schema.org',
      '@type': 'WebSite',
      '@id': `${site}/#website`,
      name: SITE_NAME,
      alternateName: '好康農產品行情',
      url: `${site}/`,
      inLanguage: 'zh-Hant-TW',
      description: '台灣農產品批發行情。主數字是比近三年同一旬便宜或貴幾 %，不是價格。',
      publisher: { '@id': `${site}/#org` },
    },
    {
      '@context': 'https://schema.org',
      '@type': 'Organization',
      '@id': `${site}/#org`,
      name: SITE_NAME,
      url: `${site}/`,
      logo: { '@type': 'ImageObject', url: `${site}/icon-512.png`, width: 512, height: 512 },
    },
    // dateModified 是新鮮度訊號：用資料的最後交易日，不是 build 時間。
    lastDateIso && {
      '@context': 'https://schema.org',
      '@type': 'WebPage',
      '@id': `${url}#page`,
      url,
      name: title,
      ...(description ? { description } : {}),
      inLanguage: 'zh-Hant-TW',
      isPartOf: { '@id': `${site}/#website` },
      dateModified: lastDateIso,
    },
    crumbs?.length && {
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      itemListElement: crumbTrail(crumbs).map((c, i) => ({
        '@type': 'ListItem',
        position: i + 1,
        name: c.name,
        item: `${site}${c.path}`,
      })),
    },
    // Dataset：2025-11 起 Google 只用於 Dataset Search，不用於一般搜尋結果（rules.json → types.Dataset）。
    // 保留是因為它的欄位（授權、來源機關、時間範圍）正是生成引擎最容易講錯的前提。
    // description 須 50–5000 字，且要用頁面上看得到的說明組成。
    dataset && {
      '@context': 'https://schema.org',
      '@type': 'Dataset',
      name: dataset.name,
      description: dataset.description,
      url,
      inLanguage: 'zh-Hant-TW',
      license: LICENSE,
      isAccessibleForFree: true,
      creator: dataset.creator ? { '@type': 'GovernmentOrganization', ...dataset.creator } : PUBLISHER,
      publisher: { '@type': 'Organization', name: SITE_NAME, url: `${site}/` },
      // 一律指回頁面已經在用的官方機關與來源網址，不另外編造。
      citation: {
        '@type': 'CreativeWork',
        name: `${dataset.creator?.name ?? PUBLISHER.name}官方行情資料`,
        url: dataset.creator?.url ?? PUBLISHER.url,
        ...(lastDateIso ? { dateModified: lastDateIso } : {}),
      },
      ...(dataset.temporalStart && lastDateIso
        ? { temporalCoverage: `${dataset.temporalStart}/${lastDateIso}` } : {}),
      spatialCoverage: dataset.spatial ?? { '@type': 'Place', name: '臺灣' },
      ...(dataset.unit ? { variableMeasured: { '@type': 'PropertyValue', name: '價格', unitText: dataset.unit } } : {}),
      isBasedOn: dataset.isBasedOn ?? 'https://data.moa.gov.tw/open_detail.aspx?id=037',
    },
    // ItemList：中文站沒有對應的 Google 強化結果（carousel 只搭課程／電影／食譜／餐廳），
    // 保留給其他引擎理解清單頁；jsonld-pages.json 不對它 apply carousel 規則。
    itemList?.length && {
      '@context': 'https://schema.org',
      '@type': 'ItemList',
      name: title,
      numberOfItems: itemList.length,
      itemListOrder: 'https://schema.org/ItemListOrderAscending',
      itemListElement: itemList.map((it, i) => ({
        '@type': 'ListItem',
        position: i + 1,
        name: it.name,
        url: `${site}${it.path}`,
      })),
    },
  ].filter(Boolean);
}
