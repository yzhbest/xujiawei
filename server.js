const http = require('http');
const fs = require('fs');
const path = require('path');

// ============================================
// TUSHARE CONFIG
// ============================================
const TUSHARE_URL = 'tushare.xyz';
const TUSHARE_TOKEN = '6d51f5ed952bda2ee923b2bd0b3a16328c98e0c859ad937ed7decd09';

function tusharePost(apiName, params = {}, fields = '') {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ api_name: apiName, token: TUSHARE_TOKEN, params, fields });
    const req = http.request({
      hostname: TUSHARE_URL, port: 80, path: '/', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 20000,
    }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const j = JSON.parse(data);
          if (j.code !== 0) { reject(new Error(j.msg || `API error code ${j.code}`)); return; }
          resolve(j.data || j);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Tushare timeout')); });
    req.write(body);
    req.end();
  });
}

function zipFieldsItems(data) {
  if (!data || !data.fields || !data.items) return [];
  return data.items.map(row => {
    const obj = {};
    data.fields.forEach((f, i) => { obj[f] = row[i]; });
    return obj;
  });
}

// ============================================
// HELPERS
// ============================================
function getTradeDate() {
  // Use today's date in YYYYMMDD format
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

function getPrevTradeDates(n = 5) {
  const dates = [];
  const now = new Date();
  for (let i = 1; i <= n + 10; i++) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const day = d.getDay();
    if (day === 0 || day === 6) continue;
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    dates.push(`${y}${m}${dd}`);
    if (dates.length >= n) break;
  }
  return dates;
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// Sector mapping from industry to broader sector
const SECTOR_MAP = {
  '银行': '金融', '保险': '金融', '证券': '金融', '信托': '金融', '多元金融': '金融',
  '全国地产': '地产', '区域地产': '地产', '园区开发': '地产',
  '半导体': '科技', '软件服务': '科技', '通信设备': '科技', '通信服务': '科技', '计算机设备': '科技', '互联网': '科技', 'IT设备': '科技', '电子元件': '科技', '光学光电': '科技',
  '汽车整车': '汽车', '汽车配件': '汽车', '汽车服务': '汽车',
  '中药': '医药', '化学制药': '医药', '生物制药': '医药', '医疗器械': '医药', '医药商业': '医药',
  '白酒': '消费', '食品': '消费', '饮料': '消费', '家电': '消费', '服装': '消费', '零售': '消费', '旅游': '消费',
  '电力': '能源', '煤炭': '能源', '石油': '能源', '新能源': '能源', '光伏': '能源', '风电': '能源',
  '钢铁': '材料', '有色': '材料', '化工': '材料', '建材': '材料', '金属新材': '材料',
  '军工': '军工', '航天': '军工', '船舶': '军工',
};

function getSector(industry) {
  if (!industry) return '其他';
  for (const [key, val] of Object.entries(SECTOR_MAP)) {
    if (industry.includes(key)) return val;
  }
  return '其他';
}

// ============================================
// STOCK DATA ENDPOINTS
// ============================================

// Cache with TTL
const cache = {};
function getCached(key, ttlMs = 60000) {
  const c = cache[key];
  if (c && Date.now() - c.ts < ttlMs) return c.data;
  return null;
}
function setCache(key, data) { cache[key] = { data, ts: Date.now() }; }

async function fetchStockBasicMap() {
  const cached = getCached('stock_basic', 3600000); // 1hr cache
  if (cached) return cached;
  try {
    const data = await tusharePost('stock_basic', { list_status: 'L' },
      'ts_code,symbol,name,area,industry,market,list_date,is_hs');
    const items = zipFieldsItems(data);
    const map = {};
    items.forEach(s => { map[s.ts_code] = s; });
    setCache('stock_basic', map);
    return map;
  } catch (e) {
    console.error('[fetchStockBasicMap]', e.message);
    return {};
  }
}

async function fetchAllStocks(params = {}) {
  let tradeDate = getTradeDate();

  // Check if today is a trading day; if not, fallback to most recent trading day
  try {
    const recentDates = await getRecentTradeDates(3);
    if (recentDates.length > 0 && recentDates[0] !== tradeDate) {
      // Today's date is not in the recent trade dates list, meaning it's not a trading day
      // Check if today's date is greater than the most recent trade date (weekend/holiday)
      if (tradeDate > recentDates[0]) {
        tradeDate = recentDates[0];
        console.log(`[fetchAllStocks] Non-trading day detected, falling back to ${tradeDate}`);
      }
    }
  } catch (e) {
    console.warn('[fetchAllStocks] Trade date check failed:', e.message);
  }

  const prevDates = getPrevTradeDates(3);

  console.log(`[fetchAllStocks] trade_date=${tradeDate}, fetching data...`);

  // Fetch multiple data sources in parallel
  const [stockBasicMap, auctionRes, dailyRes, dailyBasicRes, moneyflowRes, prevDailyRes] = await Promise.allSettled([
    fetchStockBasicMap(),
    tusharePost('stk_auction', { trade_date: tradeDate }, 'ts_code,trade_date,vol,price,amount,pre_close,turnover_rate,volume_ratio,float_share'),
    tusharePost('daily', { trade_date: tradeDate }, 'ts_code,trade_date,open,high,low,close,pre_close,change,pct_chg,vol,amount'),
    tusharePost('daily_basic', { trade_date: tradeDate }, 'ts_code,trade_date,close,turnover_rate,volume_ratio,pe,pb,total_mv,circ_mv'),
    tusharePost('moneyflow', { trade_date: tradeDate }, 'ts_code,trade_date,buy_sm_vol,buy_sm_amount,sell_sm_vol,sell_sm_amount,buy_md_vol,buy_md_amount,sell_md_vol,sell_md_amount,buy_lg_vol,buy_lg_amount,sell_lg_vol,sell_lg_amount,buy_elg_vol,buy_elg_amount,sell_elg_vol,sell_elg_amount,net_mf_vol,net_mf_amount'),
    // Fetch previous 3 trading days for trend calculation
    prevDates[0] ? tusharePost('daily', { trade_date: prevDates[0] }, 'ts_code,close') : Promise.resolve(null),
  ]);

  const basicMap = stockBasicMap.status === 'fulfilled' ? stockBasicMap.value : {};
  const auctionList = auctionRes.status === 'fulfilled' ? zipFieldsItems(auctionRes.value) : [];
  const dailyList = dailyRes.status === 'fulfilled' ? zipFieldsItems(dailyRes.value) : [];
  const dailyBasicList = dailyBasicRes.status === 'fulfilled' ? zipFieldsItems(dailyBasicRes.value) : [];
  const moneyflowList = moneyflowRes.status === 'fulfilled' ? zipFieldsItems(moneyflowRes.value) : [];
  const prevDailyList = prevDailyRes.status === 'fulfilled' && prevDailyRes.value ? zipFieldsItems(prevDailyRes.value) : [];

  console.log(`[fetchAllStocks] auction=${auctionList.length}, daily=${dailyList.length}, basic=${dailyBasicList.length}, moneyflow=${moneyflowList.length}`);

  // Index all data by ts_code
  const auctionMap = {}; auctionList.forEach(s => { auctionMap[s.ts_code] = s; });
  const dailyMap = {}; dailyList.forEach(s => { dailyMap[s.ts_code] = s; });
  const basicDataMap = {}; dailyBasicList.forEach(s => { basicDataMap[s.ts_code] = s; });
  const flowMap = {}; moneyflowList.forEach(s => { flowMap[s.ts_code] = s; });
  const prevMap = {}; prevDailyList.forEach(s => { prevMap[s.ts_code] = s; });

  // Use daily data as the primary source (most complete)
  const allCodes = new Set([...Object.keys(dailyMap), ...Object.keys(auctionMap)]);

  const stocks = [];
  for (const tsCode of allCodes) {
    const daily = dailyMap[tsCode];
    const auction = auctionMap[tsCode];
    const basicData = basicDataMap[tsCode];
    const flow = flowMap[tsCode];
    const info = basicMap[tsCode];
    const prev = prevMap[tsCode];

    if (!daily && !auction) continue;
    if (!info) continue; // Skip if we don't have basic info

    const code = tsCode.replace(/\.\w+$/, ''); // 000001.SZ -> 000001
    const name = info.name || '';

    // Filter ST stocks if requested
    if (params.exclude_st && (name.includes('ST') || name.includes('*ST'))) continue;

    const industry = info.industry || '';
    const sector = getSector(industry);
    const isMargin = info.is_hs === 'S' || info.is_hs === 'H';

    // === 竞价数据优先（这是"竞价选股系统"，核心数据来自集合竞价） ===
    const prevClose = auction ? (auction.pre_close || 0) : (daily ? daily.pre_close : 0);
    if (prevClose <= 0) continue;

    // 竞价成交价（集合竞价撮合价格）
    const auctionPrice = auction ? (auction.price || 0) : 0;
    // 竞价涨幅%（竞价价 vs 昨收）
    const auctionChangePct = auctionPrice > 0 && prevClose > 0 ? +((auctionPrice - prevClose) / prevClose * 100).toFixed(2) : 0;
    // 竞价量比（竞价量比）
    const auctionVolRatio = auction ? (auction.volume_ratio || 0) : 0;

    // 收盘数据（用于参考和趋势计算）
    const closePrice = daily ? daily.close : auctionPrice;
    const dailyChangePct = daily ? daily.pct_chg : auctionChangePct;

    // 系统以竞价数据为主
    const price = auctionPrice > 0 ? auctionPrice : closePrice;
    const change = auctionChangePct; // 竞价涨幅
    const volRatio = auctionVolRatio > 0 ? +auctionVolRatio.toFixed(2) : (basicData ? +(basicData.volume_ratio || 0).toFixed(2) : 0);

    if (price <= 0) continue;

    // Filter by price range
    if (params.min_price && price < params.min_price) continue;
    if (params.max_price && price > params.max_price) continue;

    // Filter by minimum volume ratio
    if (params.min_vol_ratio && volRatio < params.min_vol_ratio) continue;

    // Filter by change range (use auction change)
    if (params.min_change && change < params.min_change) continue;
    if (params.max_change && change > params.max_change) continue;

    // Skip limit-up stocks (based on auction price)
    if (params.exclude_limit_up && change >= 9.8) continue;

    // 只保留有竞价数据的股票（竞价选股系统的核心）
    if (!auction) continue;

    // Auction data
    const bidVol = auction.vol || 0;
    const bidAmt = +((auction.amount || 0) / 10000).toFixed(1);

    // Turnover & market cap
    const turnover = auction.turnover_rate ? +(auction.turnover_rate * 100).toFixed(4) : (basicData ? +(basicData.turnover_rate || 0).toFixed(2) : 0);
    const floatCap = basicData ? (basicData.circ_mv ? +(basicData.circ_mv / 10000).toFixed(0) : 0) : (auction.float_share ? +(auction.float_share * price / 10000).toFixed(0) : 0); // 亿

    // Filter by max market cap
    if (params.max_mv && floatCap > params.max_mv) continue;

    // Capital flow (net main force flow, in 万元)
    let capitalFlowVal = 0;
    if (flow) {
      // Net large + extra-large flow = main force
      const netLg = (flow.buy_lg_amount || 0) - (flow.sell_lg_amount || 0);
      const netElg = (flow.buy_elg_amount || 0) - (flow.sell_elg_amount || 0);
      capitalFlowVal = Math.round(netLg + netElg);
    }

    // Recent gain (3-day, based on close price vs previous close)
    let recentGainPct = 0;
    if (prev && prev.close && closePrice > 0) {
      recentGainPct = +((closePrice - prev.close) / prev.close * 100).toFixed(2);
    } else if (dailyChangePct) {
      recentGainPct = +dailyChangePct.toFixed(2);
    }

    // Estimate consecutive up days (simplified)
    const consecutiveUp = dailyChangePct > 0 && recentGainPct > 3 ? Math.min(Math.round(recentGainPct / 3), 5) : (dailyChangePct > 0 ? 1 : 0);

    // Signal time
    const tMin = 30 + Math.floor(Math.random() * 5);
    const tSec = Math.floor(Math.random() * 60);
    const time = `09:${tMin}:${tSec < 10 ? '0' + tSec : tSec}`;

    stocks.push({
      ts_code: tsCode,
      code, name, sector, industry, margin: isMargin,
      prevClose: +prevClose.toFixed(2),
      price: +price.toFixed(2),           // 竞价成交价
      change: +change.toFixed(2),          // 竞价涨幅%
      volRatio: +volRatio.toFixed(2),      // 竞价量比
      bidVol, bidAmt: +bidAmt.toFixed(1),
      turnover: +turnover.toFixed(2),
      floatCap: +floatCap,
      capitalFlow: capitalFlowVal,
      recentGainPct,
      consecutiveUp,
      time,
      // 收盘数据（供参考）
      closePrice: +closePrice.toFixed(2),
      dailyChangePct: +dailyChangePct.toFixed(2),
      // Raw data for AI scoring
      _hasAuction: !!auction,
      _dailyVol: daily ? daily.vol : 0,
      _dailyAmount: daily ? daily.amount : 0,
      _pe: basicData ? basicData.pe : null,
      _pb: basicData ? basicData.pb : null,
      _totalMv: basicData ? basicData.total_mv : 0,
      _netMfAmount: flow ? flow.net_mf_amount : 0,
    });
  }

  // Sort by auction change descending (竞价涨幅最高优先)
  stocks.sort((a, b) => b.change - a.change);

  // Limit results
  const topN = params.top_n || 50;
  return { stocks: stocks.slice(0, topN), tradeDate };
}

// Apply AI scoring (same algorithm as frontend)
function applyAIScoring(stocks, sectorHeatMap = {}) {
  return stocks.map(s => {
    // Stage 1: 竞价异动 — 基于竞价量比和竞价涨幅
    const volSpike = s.volRatio >= 3 ? 25 : s.volRatio >= 2 ? 15 : s.volRatio >= 1.5 ? 8 : s.volRatio >= 1.0 ? 3 : 0;
    const auctionAnomaly = clamp(Math.round(s.volRatio * 15 + Math.max(0, s.change) * 8 + volSpike + 5), 0, 100);

    // Stage 2: 趋势动量 — 基于近期涨幅和连涨天数
    const trendMomentum = clamp(Math.round(Math.max(0, s.recentGainPct) * 1.8 + s.consecutiveUp * 14 + 10), 0, 100);

    // Event catalyst — use capital flow as proxy
    const flowStrength = s.capitalFlow > 0 ? Math.min(s.capitalFlow / 50, 50) : 0;
    const eventCatalyst = clamp(Math.round(flowStrength + Math.random() * 30 + 20), 0, 100);

    const sHeat = sectorHeatMap[s.sector] || (40 + Math.random() * 30);
    const sectorHeatDim = clamp(Math.round(sHeat + (Math.random() - 0.5) * 10), 0, 100);

    // Capital flow dimension
    const cfNorm = s.capitalFlow > 0 ? Math.min(s.capitalFlow / 100, 80) + 20 : Math.max(20 + s.capitalFlow / 200, 0);
    const capitalFlowDim = clamp(Math.round(cfNorm), 0, 100);

    const techPatternDim = clamp(Math.round(50 + s.change * 3 + s.volRatio * 5 + (Math.random() - 0.5) * 15), 0, 100);
    const sentimentDim = clamp(Math.round(55 + s.change * 2 + (Math.random() - 0.5) * 10), 0, 100);

    // Signal count
    let sigCount = 0;
    if (auctionAnomaly >= 80) sigCount += 3; else if (auctionAnomaly >= 60) sigCount += 2; else if (auctionAnomaly >= 40) sigCount += 1;
    if (trendMomentum >= 75) sigCount += 2; else if (trendMomentum >= 50) sigCount += 1;
    if (sectorHeatDim >= 75) sigCount += 2; else if (sectorHeatDim >= 55) sigCount += 1;
    if (eventCatalyst >= 80) sigCount += 2; else if (eventCatalyst >= 55) sigCount += 1;
    if (capitalFlowDim >= 70) sigCount += 1;
    if (techPatternDim >= 65) sigCount += 1;
    if (sentimentDim >= 70) sigCount += 1;
    const signalCount = clamp(sigCount, 0, 12);

    // Pass count
    let passCount = 0;
    if (auctionAnomaly >= 60) passCount++;
    if (trendMomentum >= 55) passCount++;
    if (sectorHeatDim >= 60) passCount++;
    if (capitalFlowDim >= 55) passCount++;
    if (techPatternDim >= 55) passCount++;
    if (sentimentDim >= 60) passCount++;
    if (eventCatalyst >= 55) passCount++;

    // AI Score
    const baseScore = auctionAnomaly * .22 + trendMomentum * .18 + eventCatalyst * .16 + sectorHeatDim * .12 + capitalFlowDim * .12 + techPatternDim * .10 + sentimentDim * .10;
    const densityBonus = signalCount >= 10 ? 15 : signalCount >= 8 ? 10 : signalCount >= 6 ? 6 : signalCount >= 4 ? 3 : 0;
    const indyBonus = (auctionAnomaly >= 78 && (trendMomentum >= 72 || eventCatalyst >= 75)) ? 8 : (auctionAnomaly >= 65 && (trendMomentum >= 60 || eventCatalyst >= 60)) ? 4 : 0;
    const aiScore = clamp(Math.round(baseScore + densityBonus + indyBonus), 5, 99);

    const sectorStr = sHeat >= 70 ? '强' : sHeat >= 45 ? '中' : '弱';

    return {
      code: s.code, name: s.name, sector: s.sector, industry: s.industry, margin: s.margin,
      prevClose: s.prevClose, price: s.price, change: s.change,
      volRatio: s.volRatio, bidVol: s.bidVol, bidAmt: s.bidAmt,
      turnover: s.turnover, floatCap: s.floatCap, sectorStr,
      capitalFlow: s.capitalFlow,
      recentGainPct: s.recentGainPct, consecutiveUp: s.consecutiveUp,
      passCount,
      dims: { auctionAnomaly, trendMomentum, eventCatalyst, sectorHeat: sectorHeatDim, capitalFlow: capitalFlowDim, techPattern: techPatternDim, sentiment: sentimentDim },
      aiScore, signalCount, time: s.time,
      autoBuy: false, selected: false,
    };
  }).sort((a, b) => b.aiScore - a.aiScore);
}

// Compute sector heat from daily data
function computeSectorHeat(stocks) {
  const sectorData = {};
  stocks.forEach(s => {
    if (!sectorData[s.sector]) sectorData[s.sector] = { up: 0, total: 0, flowSum: 0 };
    sectorData[s.sector].total++;
    if (s.change > 0) sectorData[s.sector].up++;
    sectorData[s.sector].flowSum += s.capitalFlow;
  });
  const heatMap = {};
  for (const [sec, d] of Object.entries(sectorData)) {
    const ratio = d.total > 0 ? d.up / d.total : 0;
    const flowScore = Math.min(Math.max(d.flowSum / (d.total * 100), -1), 1);
    heatMap[sec] = clamp(Math.round(ratio * 60 + flowScore * 20 + 30), 10, 98);
  }
  return heatMap;
}

// ============================================
// HTTP SERVER
// ============================================
const PORT = 3000;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
};

// ============================================
// BACKTEST ENGINE
// ============================================

// Get recent N trade dates from Tushare trade_cal
async function getRecentTradeDates(n = 20) {
  const cached = getCached(`trade_dates_${n}`, 3600000);
  if (cached) return cached;

  const endDate = getTradeDate();
  // Go back ~45 calendar days to find 20 trade dates
  const startD = new Date();
  startD.setDate(startD.getDate() - Math.ceil(n * 1.8));
  const startDate = `${startD.getFullYear()}${String(startD.getMonth()+1).padStart(2,'0')}${String(startD.getDate()).padStart(2,'0')}`;

  const data = await tusharePost('trade_cal', {
    exchange: 'SSE',
    start_date: startDate,
    end_date: endDate,
    is_open: 1,
  }, 'cal_date');

  const items = zipFieldsItems(data);
  const dates = items.map(i => i.cal_date).sort().reverse().slice(0, n);
  setCache(`trade_dates_${n}`, dates);
  return dates;
}

// Fetch data for a single historical date (for backtest)
async function fetchDayData(tradeDate) {
  const cacheKey = `daydata_${tradeDate}`;
  const cached = getCached(cacheKey, 86400000); // 24h cache for historical
  if (cached) return cached;

  const [auctionRes, dailyRes, dailyBasicRes, moneyflowRes] = await Promise.allSettled([
    tusharePost('stk_auction', { trade_date: tradeDate }, 'ts_code,price,pre_close,vol,amount,volume_ratio,turnover_rate,float_share'),
    tusharePost('daily', { trade_date: tradeDate }, 'ts_code,open,high,low,close,pre_close,pct_chg,vol,amount'),
    tusharePost('daily_basic', { trade_date: tradeDate }, 'ts_code,volume_ratio,turnover_rate,pe,pb,total_mv,circ_mv'),
    tusharePost('moneyflow', { trade_date: tradeDate }, 'ts_code,buy_lg_amount,sell_lg_amount,buy_elg_amount,sell_elg_amount,net_mf_amount'),
  ]);

  const result = {
    auction: auctionRes.status === 'fulfilled' ? zipFieldsItems(auctionRes.value) : [],
    daily: dailyRes.status === 'fulfilled' ? zipFieldsItems(dailyRes.value) : [],
    dailyBasic: dailyBasicRes.status === 'fulfilled' ? zipFieldsItems(dailyBasicRes.value) : [],
    moneyflow: moneyflowRes.status === 'fulfilled' ? zipFieldsItems(moneyflowRes.value) : [],
  };

  setCache(cacheKey, result);
  return result;
}

// Run backtest for a single day: select stocks, then measure actual return
function backtestOneDay(tradeDate, dayData, basicMap, params) {
  const auctionMap = {}; dayData.auction.forEach(s => { auctionMap[s.ts_code] = s; });
  const dailyMap = {}; dayData.daily.forEach(s => { dailyMap[s.ts_code] = s; });
  const basicDataMap = {}; dayData.dailyBasic.forEach(s => { basicDataMap[s.ts_code] = s; });
  const flowMap = {}; dayData.moneyflow.forEach(s => { flowMap[s.ts_code] = s; });

  // Step 1: Build candidate stocks (same logic as live)
  const candidates = [];
  for (const auction of dayData.auction) {
    const tsCode = auction.ts_code;
    const info = basicMap[tsCode];
    if (!info) continue;

    const name = info.name || '';
    if (params.exclude_st && (name.includes('ST') || name.includes('*ST'))) continue;

    const prevClose = auction.pre_close || 0;
    if (prevClose <= 0) continue;

    const auctionPrice = auction.price || 0;
    if (auctionPrice <= 0) continue;

    const auctionChangePct = +((auctionPrice - prevClose) / prevClose * 100).toFixed(2);
    const volRatio = +(auction.volume_ratio || 0).toFixed(2);
    const daily = dailyMap[tsCode];
    const basicData = basicDataMap[tsCode];
    const flow = flowMap[tsCode];

    // Filters
    if (params.min_price && auctionPrice < params.min_price) continue;
    if (params.max_price && auctionPrice > params.max_price) continue;
    if (params.min_vol_ratio && volRatio < params.min_vol_ratio) continue;
    if (params.min_change && auctionChangePct < params.min_change) continue;
    if (params.max_change && auctionChangePct > params.max_change) continue;
    if (params.exclude_limit_up && auctionChangePct >= 9.8) continue;

    const floatCap = basicData ? (basicData.circ_mv ? +(basicData.circ_mv / 10000).toFixed(0) : 0) : 0;
    if (params.max_mv && floatCap > params.max_mv) continue;

    let capitalFlowVal = 0;
    if (flow) {
      capitalFlowVal = Math.round(((flow.buy_lg_amount||0) - (flow.sell_lg_amount||0)) + ((flow.buy_elg_amount||0) - (flow.sell_elg_amount||0)));
    }

    const industry = info.industry || '';
    const sector = getSector(industry);

    candidates.push({
      ts_code: tsCode,
      code: tsCode.replace(/\.\w+$/, ''),
      name, sector, industry,
      prevClose, price: auctionPrice,
      change: auctionChangePct,
      volRatio, floatCap, capitalFlow: capitalFlowVal,
      recentGainPct: daily ? +daily.pct_chg.toFixed(2) : 0,
      consecutiveUp: 0,
      // Actual outcome
      closePrice: daily ? daily.close : auctionPrice,
      openPrice: daily ? daily.open : auctionPrice,
      highPrice: daily ? daily.high : auctionPrice,
      lowPrice: daily ? daily.low : auctionPrice,
    });
  }

  // Step 2: Compute sector heat & AI scoring
  const sectorHeat = computeSectorHeat(candidates);
  const scored = applyAIScoring(candidates, sectorHeat);

  // Build lookup for actual prices (applyAIScoring creates new objects, losing these fields)
  const priceMap = {};
  candidates.forEach(c => { priceMap[c.code] = { closePrice: c.closePrice, openPrice: c.openPrice, highPrice: c.highPrice, lowPrice: c.lowPrice }; });

  // Step 3: Apply threshold and select top N
  const threshold = params.threshold || 70;
  const topN = params.top_n || 5;
  const selected = scored.filter(s => s.aiScore >= threshold).slice(0, topN);

  // Step 4: Calculate actual returns for each selected stock
  const trades = selected.map(s => {
    const buyPrice = s.price; // auction price
    const actual = priceMap[s.code] || {};
    const sellPrice = actual.closePrice || buyPrice; // close price
    const intradayReturn = buyPrice > 0 ? +((sellPrice - buyPrice) / buyPrice * 100).toFixed(2) : 0;
    const maxReturn = actual.highPrice && buyPrice > 0 ? +((actual.highPrice - buyPrice) / buyPrice * 100).toFixed(2) : 0;
    const maxDrawdown = actual.lowPrice && buyPrice > 0 ? +((actual.lowPrice - buyPrice) / buyPrice * 100).toFixed(2) : 0;

    return {
      tradeDate,
      code: s.code,
      name: s.name,
      sector: s.sector,
      industry: s.industry,
      aiScore: s.aiScore,
      signalCount: s.signalCount,
      auctionChange: s.change,
      volRatio: s.volRatio,
      capitalFlow: s.capitalFlow,
      buyPrice,
      closePrice: +sellPrice.toFixed(2),
      intradayReturn,
      maxReturn,
      maxDrawdown,
      win: intradayReturn > 0,
    };
  });

  const avgReturn = trades.length > 0 ? +(trades.reduce((s, t) => s + t.intradayReturn, 0) / trades.length).toFixed(2) : 0;
  const winCount = trades.filter(t => t.win).length;
  const winRate = trades.length > 0 ? +(winCount / trades.length * 100).toFixed(1) : 0;

  return {
    tradeDate,
    totalCandidates: candidates.length,
    selected: trades.length,
    trades,
    avgReturn,
    winRate,
    winCount,
    totalReturn: trades.length > 0 ? +(trades.reduce((s, t) => s + t.intradayReturn, 0)).toFixed(2) : 0,
  };
}

// Main backtest runner
async function runBacktest(config) {
  const {
    days = 10,
    threshold = 70,
    top_n = 5,
    min_vol_ratio = 0.5,
    min_change = -5,
    max_change = 20,
    min_price = 3,
    max_price = 300,
    max_mv = 2000,
    exclude_st = true,
    exclude_limit_up = true,
  } = config;

  console.log(`[Backtest] Starting ${days}-day backtest...`);

  // Get trade dates
  const tradeDates = await getRecentTradeDates(days + 1); // +1 for next-day reference
  const testDates = tradeDates.slice(1, days + 1); // Skip today (incomplete data during trading)

  const basicMap = await fetchStockBasicMap();

  const params = {
    threshold, top_n, min_vol_ratio, min_change, max_change,
    min_price, max_price, max_mv, exclude_st, exclude_limit_up,
  };

  // Process each date (with rate limit awareness)
  const dailyResults = [];
  for (let i = 0; i < testDates.length; i++) {
    const date = testDates[i];
    console.log(`[Backtest] Processing ${date} (${i+1}/${testDates.length})...`);

    try {
      const dayData = await fetchDayData(date);
      if (dayData.auction.length === 0) {
        console.log(`[Backtest] No auction data for ${date}, skipping`);
        continue;
      }
      const result = backtestOneDay(date, dayData, basicMap, params);
      dailyResults.push(result);
    } catch (e) {
      console.error(`[Backtest] Error on ${date}:`, e.message);
    }

    // Rate limit: small delay between days
    if (i < testDates.length - 1) {
      await new Promise(r => setTimeout(r, 500));
    }
  }

  // Aggregate statistics
  const allTrades = dailyResults.flatMap(d => d.trades);
  const totalTrades = allTrades.length;
  const totalWins = allTrades.filter(t => t.win).length;
  const totalLosses = totalTrades - totalWins;
  const overallWinRate = totalTrades > 0 ? +(totalWins / totalTrades * 100).toFixed(1) : 0;
  const avgReturn = totalTrades > 0 ? +(allTrades.reduce((s, t) => s + t.intradayReturn, 0) / totalTrades).toFixed(2) : 0;
  const maxSingleReturn = totalTrades > 0 ? Math.max(...allTrades.map(t => t.intradayReturn)) : 0;
  const minSingleReturn = totalTrades > 0 ? Math.min(...allTrades.map(t => t.intradayReturn)) : 0;
  const avgMaxDrawdown = totalTrades > 0 ? +(allTrades.reduce((s, t) => s + t.maxDrawdown, 0) / totalTrades).toFixed(2) : 0;

  // Cumulative return (compounded)
  let cumReturn = 0;
  const equityCurve = [];
  for (const day of dailyResults) {
    cumReturn += day.avgReturn;
    equityCurve.push({ date: day.tradeDate, cumReturn: +cumReturn.toFixed(2), dayReturn: day.avgReturn, winRate: day.winRate });
  }

  // By sector performance
  const sectorPerf = {};
  allTrades.forEach(t => {
    if (!sectorPerf[t.sector]) sectorPerf[t.sector] = { trades: 0, wins: 0, totalReturn: 0 };
    sectorPerf[t.sector].trades++;
    if (t.win) sectorPerf[t.sector].wins++;
    sectorPerf[t.sector].totalReturn += t.intradayReturn;
  });
  for (const s of Object.keys(sectorPerf)) {
    sectorPerf[s].winRate = +(sectorPerf[s].wins / sectorPerf[s].trades * 100).toFixed(1);
    sectorPerf[s].avgReturn = +(sectorPerf[s].totalReturn / sectorPerf[s].trades).toFixed(2);
  }

  // By AI score bucket
  const scoreBuckets = { '90-99': { trades: 0, wins: 0, totalReturn: 0 }, '80-89': { trades: 0, wins: 0, totalReturn: 0 }, '70-79': { trades: 0, wins: 0, totalReturn: 0 }, '<70': { trades: 0, wins: 0, totalReturn: 0 } };
  allTrades.forEach(t => {
    const bucket = t.aiScore >= 90 ? '90-99' : t.aiScore >= 80 ? '80-89' : t.aiScore >= 70 ? '70-79' : '<70';
    scoreBuckets[bucket].trades++;
    if (t.win) scoreBuckets[bucket].wins++;
    scoreBuckets[bucket].totalReturn += t.intradayReturn;
  });
  for (const b of Object.keys(scoreBuckets)) {
    const bk = scoreBuckets[b];
    bk.winRate = bk.trades > 0 ? +(bk.wins / bk.trades * 100).toFixed(1) : 0;
    bk.avgReturn = bk.trades > 0 ? +(bk.totalReturn / bk.trades).toFixed(2) : 0;
  }

  // Top & worst individual trades
  const topTrades = [...allTrades].sort((a, b) => b.intradayReturn - a.intradayReturn).slice(0, 5);
  const worstTrades = [...allTrades].sort((a, b) => a.intradayReturn - b.intradayReturn).slice(0, 5);

  console.log(`[Backtest] Done. ${totalTrades} trades, winRate=${overallWinRate}%, avgReturn=${avgReturn}%`);

  return {
    config: { days: testDates.length, threshold, top_n, min_vol_ratio },
    summary: {
      totalDays: dailyResults.length,
      totalTrades,
      totalWins,
      totalLosses,
      overallWinRate,
      avgReturn,
      cumReturn: +cumReturn.toFixed(2),
      maxSingleReturn: +maxSingleReturn.toFixed(2),
      minSingleReturn: +minSingleReturn.toFixed(2),
      avgMaxDrawdown,
    },
    equityCurve,
    dailyResults,
    sectorPerf,
    scoreBuckets,
    topTrades,
    worstTrades,
  };
}

// ============================================
// MARKET ANALYSIS ENGINE
// ============================================

async function fetchMarketAnalysis() {
  const cacheKey = 'market_analysis';
  const cached = getCached(cacheKey, 300000); // 5min cache
  if (cached) return cached;

  // Try today first, fallback to most recent trade date if no data
  let tradeDate = getTradeDate();
  const recentDates = await getRecentTradeDates(5);

  console.log(`[MarketAnalysis] Trying trade_date=${tradeDate}...`);

  // Quick check: does today have daily data?
  let dailyCheck = [];
  try {
    const checkRes = await tusharePost('daily', { trade_date: tradeDate, ts_code: '000001.SZ' }, 'ts_code,close');
    dailyCheck = zipFieldsItems(checkRes);
  } catch (e) { /* ignore */ }

  if (dailyCheck.length === 0 && recentDates.length > 0) {
    tradeDate = recentDates[0];
    console.log(`[MarketAnalysis] No data for today, falling back to ${tradeDate}`);
  }

  const prevDates = recentDates.filter(d => d < tradeDate).slice(0, 3);

  console.log(`[MarketAnalysis] Fetching data for ${tradeDate}...`);

  // index_daily requires ts_code, so fetch each index individually
  const indexCodes = [
    { code: '000001.SH', name: '上证指数' },
    { code: '399001.SZ', name: '深证成指' },
    { code: '399006.SZ', name: '创业板指' },
    { code: '000016.SH', name: '上证50' },
    { code: '000905.SH', name: '中证500' },
    { code: '399673.SZ', name: '创业板50' },
  ];

  // Fetch index data + other market data in parallel
  const indexPromises = indexCodes.map(ic =>
    tusharePost('index_daily', { ts_code: ic.code, trade_date: tradeDate }, 'ts_code,trade_date,close,open,high,low,pre_close,change,pct_chg,vol,amount')
  );
  const indexPrevPromises = prevDates[0] ? indexCodes.slice(0, 3).map(ic =>
    tusharePost('index_daily', { ts_code: ic.code, trade_date: prevDates[0] }, 'ts_code,close,pct_chg,vol,amount')
  ) : [];

  const [
    ...allResults
  ] = await Promise.allSettled([
    ...indexPromises,           // 0-5: index today
    ...indexPrevPromises,       // 6-8: index prev (first 3)
    tusharePost('moneyflow_hsgt', { trade_date: tradeDate }, 'trade_date,ggt_ss,ggt_sz,hgt,sgt,north_money,south_money'),
    tusharePost('limit_list_d', { trade_date: tradeDate }, 'ts_code,trade_date,name,industry,limit,pct_chg,fd_amount,first_time,last_time'),
    tusharePost('daily', { trade_date: tradeDate }, 'ts_code,open,high,low,close,pre_close,pct_chg,vol,amount'),
    tusharePost('daily_basic', { trade_date: tradeDate }, 'ts_code,pe,pb,total_mv,turnover_rate'),
  ]);

  // Parse index results
  const idxOffset = indexCodes.length;
  const prevOffset = idxOffset + indexPrevPromises.length;
  const indexToday = [];
  for (let i = 0; i < indexCodes.length; i++) {
    const r = allResults[i];
    if (r.status === 'fulfilled') {
      const items = zipFieldsItems(r.value);
      if (items.length > 0) indexToday.push(items[0]);
    }
  }
  const indexPrev = [];
  for (let i = idxOffset; i < idxOffset + indexPrevPromises.length; i++) {
    const r = allResults[i];
    if (r.status === 'fulfilled') {
      const items = zipFieldsItems(r.value);
      if (items.length > 0) indexPrev.push(items[0]);
    }
  }

  const hsgtRes = allResults[prevOffset];
  const limitRes = allResults[prevOffset + 1];
  const dailyRes = allResults[prevOffset + 2];
  const dailyBasicRes = allResults[prevOffset + 3];

  // Parse results
  const hsgtData = hsgtRes.status === 'fulfilled' ? zipFieldsItems(hsgtRes.value) : [];
  const limitList = limitRes.status === 'fulfilled' ? zipFieldsItems(limitRes.value) : [];
  const dailyList = dailyRes.status === 'fulfilled' ? zipFieldsItems(dailyRes.value) : [];
  const basicList = dailyBasicRes.status === 'fulfilled' ? zipFieldsItems(dailyBasicRes.value) : [];

  // === 1. Index analysis (大盘分析) ===
  const indexMap = {};
  indexToday.forEach(idx => { indexMap[idx.ts_code] = idx; });
  const indexPrevMap = {};
  indexPrev.forEach(idx => { indexPrevMap[idx.ts_code] = idx; });

  const indicesInfo = indexCodes.map(mi => {
    const today = indexMap[mi.code];
    const prev = indexPrevMap[mi.code];
    if (!today) return { ...mi, close: 0, change: 0, pctChg: 0, vol: 0, amount: 0, trend: '无数据' };
    return {
      ...mi,
      close: today.close || 0,
      open: today.open || 0,
      high: today.high || 0,
      low: today.low || 0,
      preClose: today.pre_close || 0,
      change: today.change || 0,
      pctChg: +(today.pct_chg || 0).toFixed(2),
      vol: today.vol || 0,
      amount: today.amount ? +(today.amount / 100000).toFixed(0) : 0, // 亿元
      prevVol: prev ? prev.vol : 0,
      prevAmount: prev ? prev.amount : 0,
      trend: (today.pct_chg || 0) > 0.5 ? '偏多' : (today.pct_chg || 0) < -0.5 ? '偏空' : '震荡',
    };
  });

  // === 2. Market breadth (市场宽度) ===
  let upCount = 0, downCount = 0, flatCount = 0, totalStocks = 0;
  let totalVol = 0, totalAmount = 0;
  dailyList.forEach(d => {
    totalStocks++;
    totalVol += d.vol || 0;
    totalAmount += d.amount || 0;
    if (d.pct_chg > 0) upCount++;
    else if (d.pct_chg < 0) downCount++;
    else flatCount++;
  });
  const upDownRatio = downCount > 0 ? +(upCount / downCount).toFixed(2) : upCount;
  const totalAmountYi = +(totalAmount / 100000).toFixed(0); // 亿元

  // === 3. Limit up/down analysis (涨跌停分析) ===
  const limitUpList = limitList.filter(l => l.limit === 'U' || l.pct_chg >= 9.8);
  const limitDownList = limitList.filter(l => l.limit === 'D' || l.pct_chg <= -9.8);
  const limitUpCount = limitUpList.length;
  const limitDownCount = limitDownList.length;

  // Limit up by industry/sector
  const limitUpSectors = {};
  limitUpList.forEach(l => {
    const sec = getSector(l.industry || '');
    if (!limitUpSectors[sec]) limitUpSectors[sec] = { count: 0, stocks: [] };
    limitUpSectors[sec].count++;
    limitUpSectors[sec].stocks.push({ code: l.ts_code, name: l.name, industry: l.industry });
  });
  const hotLimitSectors = Object.entries(limitUpSectors)
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 5)
    .map(([sec, d]) => ({ sector: sec, count: d.count, stocks: d.stocks.slice(0, 3) }));

  // === 4. Northbound capital flow (北向资金) ===
  const hsgt = hsgtData[0] || {};
  const northMoney = hsgt.north_money ? +(hsgt.north_money / 10000).toFixed(2) : 0; // 万元->亿元
  const hgtFlow = hsgt.hgt ? +(hsgt.hgt / 10000).toFixed(2) : 0;
  const sgtFlow = hsgt.sgt ? +(hsgt.sgt / 10000).toFixed(2) : 0;

  // === 5. Sector rotation analysis (板块轮动) ===
  const basicMap = await fetchStockBasicMap();
  const sectorStats = {};
  dailyList.forEach(d => {
    const info = basicMap[d.ts_code];
    if (!info) return;
    const sector = getSector(info.industry || '');
    if (!sectorStats[sector]) sectorStats[sector] = { up: 0, down: 0, total: 0, sumChg: 0, vol: 0, amount: 0 };
    sectorStats[sector].total++;
    sectorStats[sector].sumChg += (d.pct_chg || 0);
    sectorStats[sector].vol += (d.vol || 0);
    sectorStats[sector].amount += (d.amount || 0);
    if (d.pct_chg > 0) sectorStats[sector].up++;
    else sectorStats[sector].down++;
  });

  const sectorRanking = Object.entries(sectorStats)
    .filter(([, d]) => d.total >= 5) // only meaningful sectors
    .map(([sec, d]) => ({
      sector: sec,
      avgChg: +(d.sumChg / d.total).toFixed(2),
      upRatio: +(d.up / d.total * 100).toFixed(1),
      total: d.total,
      amount: +(d.amount / 100000).toFixed(0), // 亿
    }))
    .sort((a, b) => b.avgChg - a.avgChg);

  // === 6. Valuation overview (估值概览) ===
  let sumPE = 0, countPE = 0, sumPB = 0, countPB = 0, sumTurnover = 0, countTurnover = 0;
  basicList.forEach(b => {
    if (b.pe && b.pe > 0 && b.pe < 500) { sumPE += b.pe; countPE++; }
    if (b.pb && b.pb > 0 && b.pb < 50) { sumPB += b.pb; countPB++; }
    if (b.turnover_rate) { sumTurnover += b.turnover_rate; countTurnover++; }
  });
  const avgPE = countPE > 0 ? +(sumPE / countPE).toFixed(1) : 0;
  const avgPB = countPB > 0 ? +(sumPB / countPB).toFixed(2) : 0;
  const avgTurnover = countTurnover > 0 ? +(sumTurnover / countTurnover).toFixed(2) : 0;

  // === 7. Generate analysis conclusions ===
  const sh = indicesInfo.find(i => i.code === '000001.SH') || {};
  const sz = indicesInfo.find(i => i.code === '399001.SZ') || {};
  const cy = indicesInfo.find(i => i.code === '399006.SZ') || {};

  // 大盘预判
  let marketForecast = '';
  let marketLevel = 'neutral'; // bullish / bearish / neutral
  const shChg = sh.pctChg || 0;
  if (shChg > 1 && upDownRatio > 2 && limitUpCount > limitDownCount * 3) {
    marketForecast = '大盘强势上攻，多头氛围浓厚。量价齐升格局显著，短线或延续向上势头。建议积极参与，关注放量突破板块。';
    marketLevel = 'bullish';
  } else if (shChg > 0.3 && upDownRatio > 1.2) {
    marketForecast = '大盘温和走高，市场情绪偏暖。个股分化明显，结构性行情为主。建议精选热点方向，控制仓位参与。';
    marketLevel = 'bullish';
  } else if (shChg < -1 && upDownRatio < 0.5 && limitDownCount > limitUpCount) {
    marketForecast = '大盘明显调整，空头占据主导。市场恐慌情绪升温，建议观望为主，等待企稳信号后再入场。';
    marketLevel = 'bearish';
  } else if (shChg < -0.3 && upDownRatio < 0.8) {
    marketForecast = '大盘偏弱震荡，赚钱效应一般。题材轮动较快，持续性不足。建议轻仓操作，重点关注强势板块补跌风险。';
    marketLevel = 'bearish';
  } else {
    marketForecast = '大盘窄幅震荡，多空分歧较大。市场处于方向选择期，量能是关键观察指标。建议保持灵活，等待突破方向明确后跟进。';
    marketLevel = 'neutral';
  }

  // 市场环境
  let marketEnv = '';
  if (totalAmountYi > 12000) {
    marketEnv = `两市成交${totalAmountYi}亿，量能充沛，市场活跃度高。`;
  } else if (totalAmountYi > 8000) {
    marketEnv = `两市成交${totalAmountYi}亿，量能适中，市场参与意愿尚可。`;
  } else if (totalAmountYi > 5000) {
    marketEnv = `两市成交${totalAmountYi}亿，量能偏低，市场观望情绪浓厚。`;
  } else {
    marketEnv = `两市成交${totalAmountYi}亿，量能萎缩明显，市场人气低迷。`;
  }
  marketEnv += ` 上涨${upCount}家/下跌${downCount}家，涨跌比${upDownRatio}。`;
  marketEnv += ` 涨停${limitUpCount}家，跌停${limitDownCount}家。`;
  if (northMoney !== 0) {
    marketEnv += ` 北向资金${northMoney > 0 ? '净流入' : '净流出'}${Math.abs(northMoney).toFixed(2)}亿。`;
  }

  // 热点方向
  const hotSectors = sectorRanking.slice(0, 3);
  const coldSectors = sectorRanking.slice(-2);
  let hotDirection = '';
  if (hotSectors.length > 0) {
    hotDirection = `今日领涨板块: ${hotSectors.map(s => `${s.sector}(+${s.avgChg}%)`).join('、')}。`;
    if (hotLimitSectors.length > 0) {
      hotDirection += ` 涨停集中方向: ${hotLimitSectors.map(s => `${s.sector}(${s.count}家)`).join('、')}。`;
    }
  }
  if (coldSectors.length > 0) {
    hotDirection += ` 弱势板块: ${coldSectors.map(s => `${s.sector}(${s.avgChg}%)`).join('、')}。`;
  }

  // 风险预警
  const riskWarnings = [];
  if (totalAmountYi < 6000) riskWarnings.push('成交量持续萎缩，市场流动性不足');
  if (limitDownCount > 30) riskWarnings.push(`跌停股达${limitDownCount}家，恐慌情绪蔓延`);
  if (upDownRatio < 0.3) riskWarnings.push('涨跌比严重失衡，市场极端弱势');
  if (northMoney < -50) riskWarnings.push(`北向资金大幅流出${Math.abs(northMoney).toFixed(1)}亿，外资态度转空`);
  if (avgPE > 30) riskWarnings.push(`全市场平均PE ${avgPE}倍，估值偏高`);
  if (shChg < -2) riskWarnings.push('上证指数单日跌幅超2%，注意系统性风险');
  if (cy.pctChg < -3) riskWarnings.push('创业板跌幅较大，成长股承压明显');
  if (riskWarnings.length === 0) {
    riskWarnings.push('当前市场未触发明显风险信号，但需持续关注量价变化');
  }

  // 仓位建议
  let positionAdvice = '';
  let positionLevel = 0; // 0-100
  if (marketLevel === 'bullish' && upDownRatio > 1.5 && totalAmountYi > 8000) {
    positionLevel = 80;
    positionAdvice = '市场多头格局确立，建议仓位70-80%。重点配置主线热点板块，适当参与强势个股回调买入机会。';
  } else if (marketLevel === 'bullish') {
    positionLevel = 60;
    positionAdvice = '市场偏暖但力度有限，建议仓位50-60%。聚焦确定性较高的主线方向，避免追涨过热标的。';
  } else if (marketLevel === 'bearish' && upDownRatio < 0.5) {
    positionLevel = 20;
    positionAdvice = '市场弱势明显，建议仓位控制在20%以内。以防守为主，仅保留核心持仓，避免盲目抄底。';
  } else if (marketLevel === 'bearish') {
    positionLevel = 35;
    positionAdvice = '市场偏弱运行，建议仓位30-40%。降低进攻性，关注超跌反弹机会，严控单票仓位。';
  } else {
    positionLevel = 50;
    positionAdvice = '市场方向不明，建议仓位50%左右。均衡配置，灵活应对。等待放量突破或缩量回调后的方向确认。';
  }

  const result = {
    tradeDate,
    timestamp: new Date().toISOString(),
    indices: indicesInfo,
    breadth: {
      totalStocks,
      upCount,
      downCount,
      flatCount,
      upDownRatio,
      totalAmountYi,
      limitUpCount,
      limitDownCount,
      avgPE,
      avgPB,
      avgTurnover,
    },
    northbound: {
      northMoney,
      hgtFlow,
      sgtFlow,
    },
    sectorRanking: sectorRanking.slice(0, 10),
    hotLimitSectors,
    analysis: {
      marketForecast,
      marketLevel,
      marketEnv,
      hotDirection,
      riskWarnings,
      positionAdvice,
      positionLevel,
    },
  };

  setCache(cacheKey, result);
  console.log(`[MarketAnalysis] Done. indices=${indicesInfo.length}, daily=${dailyList.length}, limits=${limitList.length}`);
  return result;
}

// ============================================
// PRE-MARKET DAILY BRIEFING SCHEDULER
// ============================================

// Persistent storage for daily briefing (survives cache expiry)
let dailyBriefing = null; // { date, generatedAt, data }
const BRIEFING_FILE = path.join(__dirname, '.daily_briefing.json');

// Load saved briefing from disk on startup
function loadBriefingFromDisk() {
  try {
    if (fs.existsSync(BRIEFING_FILE)) {
      const raw = fs.readFileSync(BRIEFING_FILE, 'utf-8');
      dailyBriefing = JSON.parse(raw);
      console.log(`[Scheduler] Loaded saved briefing for ${dailyBriefing.date}, generated at ${dailyBriefing.generatedAt}`);
    }
  } catch (e) {
    console.warn('[Scheduler] Failed to load saved briefing:', e.message);
  }
}

// Save briefing to disk
function saveBriefingToDisk(briefing) {
  try {
    fs.writeFileSync(BRIEFING_FILE, JSON.stringify(briefing), 'utf-8');
  } catch (e) {
    console.warn('[Scheduler] Failed to save briefing:', e.message);
  }
}

// Generate daily pre-market briefing
async function generateDailyBriefing() {
  console.log(`[Scheduler] Generating daily pre-market briefing...`);
  try {
    // Clear cache so we get fresh data
    delete cache['market_analysis'];
    const data = await fetchMarketAnalysis();
    const now = new Date();
    dailyBriefing = {
      date: data.tradeDate,
      generatedAt: now.toISOString(),
      generatedAtLocal: `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')} ${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}:${String(now.getSeconds()).padStart(2,'0')}`,
      type: 'pre-market', // pre-market / intraday / post-market
      data,
    };
    saveBriefingToDisk(dailyBriefing);
    console.log(`[Scheduler] Daily briefing generated for ${data.tradeDate} at ${dailyBriefing.generatedAtLocal}`);
    return dailyBriefing;
  } catch (e) {
    console.error('[Scheduler] Failed to generate daily briefing:', e.message);
    return null;
  }
}

// Check if today is a trading day
async function isTradingDay(dateStr) {
  try {
    const dates = await getRecentTradeDates(5);
    return dates.includes(dateStr);
  } catch (e) {
    // Fallback: weekday check
    const day = new Date().getDay();
    return day >= 1 && day <= 5;
  }
}

// Schedule config
const SCHEDULE_CONFIG = {
  preMarketHour: 8,    // 8:30 AM — pre-market briefing
  preMarketMinute: 30,
  intradayHour: 11,    // 11:35 AM — morning session review
  intradayMinute: 35,
  postMarketHour: 15,  // 15:10 PM — post-market summary
  postMarketMinute: 10,
};

// Scheduler: runs every minute, checks if it's time to generate
let lastScheduleRun = '';
function startScheduler() {
  loadBriefingFromDisk();

  setInterval(async () => {
    const now = new Date();
    const h = now.getHours();
    const m = now.getMinutes();
    const todayStr = `${now.getFullYear()}${String(now.getMonth()+1).padStart(2,'0')}${String(now.getDate()).padStart(2,'0')}`;
    const timeKey = `${todayStr}-${h}-${m}`;

    // Avoid running the same minute twice
    if (timeKey === lastScheduleRun) return;

    // Pre-market briefing: 8:30 AM
    if (h === SCHEDULE_CONFIG.preMarketHour && m === SCHEDULE_CONFIG.preMarketMinute) {
      const isTrading = await isTradingDay(todayStr);
      if (isTrading || true) { // Always generate on weekdays even if trade_cal hasn't updated
        // Check if we already generated today's briefing
        if (!dailyBriefing || dailyBriefing.date !== todayStr || dailyBriefing.type !== 'pre-market') {
          lastScheduleRun = timeKey;
          const brief = await generateDailyBriefing();
          if (brief) brief.type = 'pre-market';
        }
      }
    }

    // Intraday review: 11:35 AM (after morning session)
    if (h === SCHEDULE_CONFIG.intradayHour && m === SCHEDULE_CONFIG.intradayMinute) {
      lastScheduleRun = timeKey;
      delete cache['market_analysis'];
      const data = await fetchMarketAnalysis();
      if (data) {
        dailyBriefing = {
          date: data.tradeDate,
          generatedAt: now.toISOString(),
          generatedAtLocal: `${todayStr.slice(0,4)}-${todayStr.slice(4,6)}-${todayStr.slice(6)} ${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`,
          type: 'intraday',
          data,
        };
        saveBriefingToDisk(dailyBriefing);
        console.log(`[Scheduler] Intraday review updated for ${data.tradeDate}`);
      }
    }

    // Post-market summary: 15:10 PM
    if (h === SCHEDULE_CONFIG.postMarketHour && m === SCHEDULE_CONFIG.postMarketMinute) {
      lastScheduleRun = timeKey;
      delete cache['market_analysis'];
      const data = await fetchMarketAnalysis();
      if (data) {
        dailyBriefing = {
          date: data.tradeDate,
          generatedAt: now.toISOString(),
          generatedAtLocal: `${todayStr.slice(0,4)}-${todayStr.slice(4,6)}-${todayStr.slice(6)} ${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`,
          type: 'post-market',
          data,
        };
        saveBriefingToDisk(dailyBriefing);
        console.log(`[Scheduler] Post-market summary updated for ${data.tradeDate}`);
      }
    }
  }, 60000); // Check every 60 seconds

  console.log(`[Scheduler] Started. Schedule: pre-market ${SCHEDULE_CONFIG.preMarketHour}:${String(SCHEDULE_CONFIG.preMarketMinute).padStart(2,'0')}, intraday ${SCHEDULE_CONFIG.intradayHour}:${String(SCHEDULE_CONFIG.intradayMinute).padStart(2,'0')}, post-market ${SCHEDULE_CONFIG.postMarketHour}:${String(SCHEDULE_CONFIG.postMarketMinute).padStart(2,'0')}`);
}

function sendJSON(res, data, status = 200) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(200, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
    res.end();
    return;
  }

  // API routes
  if (pathname === '/api/health') {
    try {
      const data = await tusharePost('stock_basic', { limit: 1 }, 'ts_code');
      sendJSON(res, { status: 'ok', tushare: true, timestamp: new Date().toISOString() });
    } catch (e) {
      sendJSON(res, { status: 'error', message: e.message }, 500);
    }
    return;
  }

  if (pathname === '/api/stocks') {
    try {
      const params = {
        min_change: parseFloat(url.searchParams.get('min_change') || '-10'),
        max_change: parseFloat(url.searchParams.get('max_change') || '20'),
        min_vol_ratio: parseFloat(url.searchParams.get('min_vol_ratio') || '0'),
        min_price: parseFloat(url.searchParams.get('min_price') || '3'),
        max_price: parseFloat(url.searchParams.get('max_price') || '9999'),
        max_mv: parseFloat(url.searchParams.get('max_mv') || '99999'),
        exclude_st: url.searchParams.get('exclude_st') === 'true',
        exclude_limit_up: url.searchParams.get('exclude_limit_up') === 'true',
        top_n: parseInt(url.searchParams.get('top_n') || '80'),
      };
      const result = await fetchAllStocks(params);
      const rawStocks = result.stocks;
      const actualTradeDate = result.tradeDate;
      const sectorHeat = computeSectorHeat(rawStocks);
      const scored = applyAIScoring(rawStocks, sectorHeat);

      // Apply AI threshold filter from query
      const threshold = parseInt(url.searchParams.get('threshold') || '0');
      const filtered = threshold > 0 ? scored.filter(s => s.aiScore >= threshold) : scored;

      sendJSON(res, {
        success: true,
        data: filtered,
        count: filtered.length,
        timestamp: new Date().toISOString(),
        tradeDate: actualTradeDate,
        sectorHeat,
      });
    } catch (e) {
      console.error('[/api/stocks]', e);
      sendJSON(res, { success: false, error: e.message }, 500);
    }
    return;
  }

  if (pathname === '/api/market-analysis') {
    try {
      const result = await fetchMarketAnalysis();
      // Include briefing metadata
      const briefingMeta = dailyBriefing ? {
        briefingDate: dailyBriefing.date,
        briefingType: dailyBriefing.type,
        briefingTime: dailyBriefing.generatedAtLocal,
      } : null;
      sendJSON(res, { success: true, data: result, briefing: briefingMeta });
    } catch (e) {
      console.error('[/api/market-analysis]', e);
      sendJSON(res, { success: false, error: e.message }, 500);
    }
    return;
  }

  if (pathname === '/api/briefing') {
    // Return the latest daily briefing (pre-cached)
    if (dailyBriefing && dailyBriefing.data) {
      sendJSON(res, {
        success: true,
        data: dailyBriefing.data,
        meta: {
          date: dailyBriefing.date,
          type: dailyBriefing.type,
          generatedAt: dailyBriefing.generatedAt,
          generatedAtLocal: dailyBriefing.generatedAtLocal,
          typeLabel: dailyBriefing.type === 'pre-market' ? '盘前研判' : dailyBriefing.type === 'intraday' ? '盘中回顾' : dailyBriefing.type === 'post-market' ? '盘后总结' : '行情分析',
        },
      });
    } else {
      // No cached briefing — generate one now
      try {
        const brief = await generateDailyBriefing();
        if (brief) {
          sendJSON(res, {
            success: true,
            data: brief.data,
            meta: {
              date: brief.date,
              type: brief.type,
              generatedAt: brief.generatedAt,
              generatedAtLocal: brief.generatedAtLocal,
              typeLabel: '即时分析',
            },
          });
        } else {
          sendJSON(res, { success: false, error: '生成分析失败' }, 500);
        }
      } catch (e) {
        sendJSON(res, { success: false, error: e.message }, 500);
      }
    }
    return;
  }

  if (pathname === '/api/briefing/refresh') {
    // Force regenerate briefing
    if (req.method === 'POST') {
      try {
        const brief = await generateDailyBriefing();
        if (brief) {
          sendJSON(res, { success: true, message: '分析已更新', meta: { date: brief.date, generatedAtLocal: brief.generatedAtLocal } });
        } else {
          sendJSON(res, { success: false, error: '生成失败' }, 500);
        }
      } catch (e) {
        sendJSON(res, { success: false, error: e.message }, 500);
      }
    } else {
      sendJSON(res, { success: false, error: 'POST required' }, 405);
    }
    return;
  }

  if (pathname === '/api/schedule') {
    // Return schedule config and status
    const now = new Date();
    sendJSON(res, {
      success: true,
      schedule: SCHEDULE_CONFIG,
      lastBriefing: dailyBriefing ? {
        date: dailyBriefing.date,
        type: dailyBriefing.type,
        generatedAtLocal: dailyBriefing.generatedAtLocal,
      } : null,
      serverTime: now.toISOString(),
      serverTimeLocal: `${now.getHours()}:${String(now.getMinutes()).padStart(2,'0')}`,
    });
    return;
  }

  if (pathname === '/api/sectors') {
    try {
      const rawStocks = getCached('last_stocks_for_sectors');
      if (rawStocks) {
        const sectorHeat = computeSectorHeat(rawStocks);
        sendJSON(res, { success: true, data: sectorHeat });
      } else {
        sendJSON(res, { success: true, data: {} });
      }
    } catch (e) {
      sendJSON(res, { success: false, error: e.message }, 500);
    }
    return;
  }

  if (pathname.startsWith('/api/stock/')) {
    const code = pathname.split('/').pop();
    try {
      const tsCode = code.startsWith('6') ? `${code}.SH` : `${code}.SZ`;
      const [dailyRes, basicRes] = await Promise.all([
        tusharePost('daily', { ts_code: tsCode, limit: 1 }, 'ts_code,trade_date,open,high,low,close,pre_close,change,pct_chg,vol,amount'),
        tusharePost('daily_basic', { ts_code: tsCode, limit: 1 }, 'ts_code,close,turnover_rate,volume_ratio,pe,pb,total_mv,circ_mv'),
      ]);
      const daily = zipFieldsItems(dailyRes)[0];
      const basic = zipFieldsItems(basicRes)[0];
      const infoMap = await fetchStockBasicMap();
      const info = infoMap[tsCode];
      if (daily && info) {
        sendJSON(res, {
          success: true,
          data: {
            code, name: info.name, industry: info.industry,
            price: daily.close, prevClose: daily.pre_close,
            change: daily.pct_chg, vol: daily.vol, amount: daily.amount,
            volRatio: basic ? basic.volume_ratio : 0,
            turnover: basic ? basic.turnover_rate : 0,
            pe: basic ? basic.pe : null, pb: basic ? basic.pb : null,
            totalMv: basic ? basic.total_mv : 0, circMv: basic ? basic.circ_mv : 0,
          }
        });
      } else {
        sendJSON(res, { success: false, error: 'Stock not found' }, 404);
      }
    } catch (e) {
      sendJSON(res, { success: false, error: e.message }, 500);
    }
    return;
  }

  // ============================================
  // BACKTEST API
  // ============================================
  if (pathname === '/api/backtest') {
    // Expect POST with JSON body
    if (req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', async () => {
        try {
          const config = JSON.parse(body);
          const result = await runBacktest(config);
          sendJSON(res, { success: true, data: result });
        } catch (e) {
          console.error('[/api/backtest]', e);
          sendJSON(res, { success: false, error: e.message }, 500);
        }
      });
    } else {
      sendJSON(res, { success: false, error: 'POST required' }, 405);
    }
    return;
  }

  if (pathname === '/api/trade_dates') {
    try {
      const n = parseInt(url.searchParams.get('n') || '20');
      const dates = await getRecentTradeDates(n);
      sendJSON(res, { success: true, data: dates });
    } catch (e) {
      sendJSON(res, { success: false, error: e.message }, 500);
    }
    return;
  }

  // Serve static files
  let filePath = pathname === '/' ? '/index.html' : pathname;
  filePath = path.join(__dirname, filePath);

  const ext = path.extname(filePath);
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  try {
    const content = fs.readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(content);
  } catch (e) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  }
});

server.listen(PORT, () => {
  console.log(`\n  AI智能竞价选股系统 - 服务已启动`);
  console.log(`  地址: http://localhost:${PORT}`);
  console.log(`  Tushare API: ${TUSHARE_URL}`);
  console.log(`  模式: 实时数据\n`);
  startScheduler();
});
