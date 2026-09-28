// 「資料怎麼算」的單一來源：/about/ 的錨點、以及頁面與 /about/ 都要用到的門檻常數。
// 規則（CLAUDE.md § 紅線）：警語與方法說明只放 /about/#method，頁面只留結論與一個「怎麼算？」小連結。
// 頁面用 <MethodLink to="gap" />，/about/ 用同一個 METHOD 表產生錨點——改名不會斷連結，
// seo-audit.mjs method 也會逐頁檢查連結的錨點在 /about/ 存在。

export const METHOD = {
  retail: 'm-retail',          // 臺中零售實測、攤位價判斷
  season: 'm-season',          // 產季、最便宜月份、十天波動
  gap: 'm-gap',                // 各地價差（月均、當日）、「種」
  ship: 'm-ship',              // 出貨：哪天到貨多
  variety: 'm-variety',        // 品種與進口
  why: 'm-why',                // 颱風、量價、年節往例
  chain: 'm-chain',            // 產地→批發→零售
  cropMarket: 'm-crop-market', // 品項×市場頁
  market: 'm-market',          // 市場頁：星期節奏、休市、集中度
  meat: 'm-meat',              // 肉蛋
  typhoon: 'm-typhoon',        // 颱風頁
  festival: 'm-festival',      // 節日頁
  lists: 'm-lists',            // 清單頁、榜單
  charts: 'm-charts',          // 圖怎麼讀
};

// 各地價差只比「最新月份交易量佔跨市場合計 1% 以上」的市場（實測剔掉約四分之一零星列）
export const MIN_MARKET_SHARE = 0.01;
// 換品種省錢：只推薦佔近一年交易量 5% 以上的非進口品種，且至少便宜 15%
export const VARIETY_MIN_SHARE = 5;
export const VARIETY_MIN_SAVING = 15;
// 颱風頁的兩份清單：常態日均量 10 公噸以上、至少 10 次颱風有紀錄
export const TYPHOON_MIN_VOLUME = 10_000;   // 公斤
export const TYPHOON_MIN_SAMPLES = 10;
// 零售訪價密度低於這個比例時標「僅產季訪得到價」、價格鏈不換算農民拿幾成
export const RETAIL_LOW_COVER = 0.35;
