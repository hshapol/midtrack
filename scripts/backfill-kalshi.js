// backfill-kalshi.js — run once to populate historical Kalshi data
// node scripts/backfill-kalshi.js

import fetch from 'node-fetch';
import { writeFileSync, readFileSync } from 'fs';

const HISTORY_PATH = 'data/history.json';

async function getMarketTicker(seriesTicker) {
  const url = `https://external-api.kalshi.com/trade-api/v2/markets?series_ticker=${seriesTicker}&limit=100`;
  const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
  if (!res.ok) throw new Error(`${seriesTicker} series HTTP ${res.status}`);
  const data = await res.json();
  const markets = data.markets || [];
  console.log(`  ${seriesTicker} markets:`, markets.map(m => m.ticker));
  return markets;
}

async function fetchKalshiHistory(ticker, startDate, endDate) {
  const startTs = Math.floor(new Date(startDate).getTime() / 1000);
  const endTs   = Math.floor(new Date(endDate).getTime() / 1000);
  const url = `https://external-api.kalshi.com/trade-api/v2/markets/${ticker}/candlesticks?start_ts=${startTs}&end_ts=${endTs}&period_interval=1440`;
  
  console.log(`  Fetching history for ${ticker}...`);
  const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
  if (!res.ok) {
    console.error(`  ${ticker} candlesticks HTTP ${res.status}`);
    return [];
  }
  const data = await res.json();
  console.log(`  Raw candle keys:`, data.candlesticks?.[0] ? Object.keys(data.candlesticks[0]) : 'none');
  return data.candlesticks || [];
}

function candleToPrice(candle) {
  // Try various field names Kalshi might use
  const c = candle.yes_ask?.close ?? candle.yes_bid?.close ?? 
            candle.price?.close ?? candle.close_price ?? 
            candle.last_price ?? null;
  if (c == null) return null;
  // Could be 0-1 or 0-100
  return c > 1 ? Math.round(c) : Math.round(c * 100);
}

async function main() {
  let history = [];
  try { history = JSON.parse(readFileSync(HISTORY_PATH, 'utf8')); }
  catch { console.log('No existing history.json'); }

  // First discover the actual market tickers
  console.log('Discovering Kalshi market tickers...');
  const [houseMarkets, senateMarkets] = await Promise.all([
    getMarketTicker('CONTROLH'),
    getMarketTicker('CONTROLS'),
  ]);

  // Find the D (Democrat wins) contracts
  const houseTicker  = houseMarkets.find(m => m.ticker?.includes('D') || m.subtitle?.toLowerCase().includes('democrat'))?.ticker
                    || houseMarkets[0]?.ticker;
  const senateTicker = senateMarkets.find(m => m.ticker?.includes('D') || m.subtitle?.toLowerCase().includes('democrat'))?.ticker
                    || senateMarkets[0]?.ticker;

  console.log(`  Using House ticker: ${houseTicker}`);
  console.log(`  Using Senate ticker: ${senateTicker}`);

  if (!houseTicker || !senateTicker) {
    console.error('Could not find market tickers!');
    console.log('All house markets:', JSON.stringify(houseMarkets, null, 2));
    console.log('All senate markets:', JSON.stringify(senateMarkets, null, 2));
    return;
  }

  const startDate = '2025-09-01';
  const endDate   = new Date().toISOString().split('T')[0];

  const [houseCandles, senateCandles] = await Promise.all([
    fetchKalshiHistory(houseTicker, startDate, endDate),
    fetchKalshiHistory(senateTicker, startDate, endDate),
  ]);

  console.log(`\n  House candles: ${houseCandles.length}`);
  console.log(`  Senate candles: ${senateCandles.length}`);
  if (houseCandles[0]) console.log('  Sample candle:', JSON.stringify(houseCandles[0]));

  const houseByDate = {};
  houseCandles.forEach(c => {
    const date = new Date((c.end_period_ts || c.ts) * 1000).toISOString().split('T')[0];
    const price = candleToPrice(c);
    if (price != null) houseByDate[date] = price;
  });

  const senateByDate = {};
  senateCandles.forEach(c => {
    const date = new Date((c.end_period_ts || c.ts) * 1000).toISOString().split('T')[0];
    const price = candleToPrice(c);
    if (price != null) senateByDate[date] = price;
  });

  console.log(`  House dates with data: ${Object.keys(houseByDate).length}`);
  console.log(`  Senate dates with data: ${Object.keys(senateByDate).length}`);

  // Merge into history
  let updated = 0;
  const historyMap = {};
  history.forEach(h => historyMap[h.date] = h);

  history.forEach(h => {
    const houseD  = houseByDate[h.date] ?? null;
    const senateD = senateByDate[h.date] ?? null;
    if (houseD == null && senateD == null) return;
    if (!h.markets) h.markets = {};
    if (!h.markets.kalshi) h.markets.kalshi = {};
    if (houseD != null)  h.markets.kalshi.houseD  = houseD;
    if (senateD != null) h.markets.kalshi.senateR = 100 - senateD;
    updated++;
  });

  // Add new entries for dates not in history
  const allDates = new Set([...Object.keys(houseByDate), ...Object.keys(senateByDate)]);
  allDates.forEach(date => {
    if (historyMap[date]) return;
    history.push({
      date,
      markets: {
        kalshi: {
          houseD:  houseByDate[date] ?? null,
          senateR: senateByDate[date] != null ? 100 - senateByDate[date] : null,
        }
      }
    });
    updated++;
  });

  history.sort((a, b) => a.date.localeCompare(b.date));
  writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 2));
  
  console.log(`\n✅ Done! Updated/added ${updated} entries. Total: ${history.length} days.`);
  const recent = history.filter(h => h.markets?.kalshi?.houseD != null).slice(-5);
  console.log('\nRecent Kalshi data:');
  recent.forEach(h => console.log(`  ${h.date}: House D ${h.markets.kalshi.houseD}% / Senate R ${h.markets.kalshi.senateR}%`));
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
