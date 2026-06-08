// backfill-kalshi.js
// Run once: node backfill-kalshi.js
// Fetches historical daily Kalshi prices and merges into history.json

import fetch from 'node-fetch';
import { writeFileSync, readFileSync } from 'fs';

const HISTORY_PATH = 'data/history.json';

// Kalshi candlestick endpoint — public, no auth required
// period_interval: 1440 = daily candles (minutes in a day)
async function fetchKalshiHistory(ticker, startDate, endDate) {
  const startTs = Math.floor(new Date(startDate).getTime() / 1000);
  const endTs   = Math.floor(new Date(endDate).getTime() / 1000);
  const url = `https://external-api.kalshi.com/trade-api/v2/markets/${ticker}/candlesticks?start_ts=${startTs}&end_ts=${endTs}&period_interval=1440`;
  
  console.log(`  Fetching ${ticker}...`);
  const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
  if (!res.ok) {
    console.error(`  ${ticker} HTTP ${res.status}`);
    return [];
  }
  const data = await res.json();
  return data.candlesticks || [];
}

function candleToPrice(candle) {
  // yes_ask/yes_bid in cents, close price
  const close = candle.yes_ask?.close ?? candle.yes_bid?.close ?? candle.price?.close ?? null;
  if (close == null) return null;
  return Math.round(close); // already in cents (0-100)
}

async function main() {
  // Load existing history
  let history = [];
  try { history = JSON.parse(readFileSync(HISTORY_PATH, 'utf8')); }
  catch { console.log('No existing history.json'); }

  const startDate = '2025-09-01'; // when these markets opened
  const endDate   = new Date().toISOString().split('T')[0];

  // Fetch House D% and Senate D% candlesticks
  const [houseCandles, senateCandles] = await Promise.all([
    fetchKalshiHistory('CONTROLH-2026-D', startDate, endDate),
    fetchKalshiHistory('CONTROLS-2026-D', startDate, endDate),
  ]);

  console.log(`  House candles: ${houseCandles.length}`);
  console.log(`  Senate candles: ${senateCandles.length}`);

  // Build date → price maps
  const houseByDate = {};
  houseCandles.forEach(c => {
    const date = new Date(c.end_period_ts * 1000).toISOString().split('T')[0];
    const price = candleToPrice(c);
    if (price != null) houseByDate[date] = price;
  });

  const senateByDate = {};
  senateCandles.forEach(c => {
    const date = new Date(c.end_period_ts * 1000).toISOString().split('T')[0];
    const price = candleToPrice(c);
    if (price != null) senateByDate[date] = price;
  });

  console.log(`  House dates: ${Object.keys(houseByDate).length}`);
  console.log(`  Senate dates: ${Object.keys(senateByDate).length}`);

  // Merge into history
  let updated = 0;
  const historyByDate = {};
  history.forEach(h => historyByDate[h.date] = h);

  // Update existing entries
  history.forEach(h => {
    const houseD  = houseByDate[h.date] ?? null;
    const senateD = senateByDate[h.date] ?? null;
    if (houseD == null && senateD == null) return;

    if (!h.markets) h.markets = {};
    if (!h.markets.kalshi) h.markets.kalshi = {};
    
    if (houseD != null)  { h.markets.kalshi.houseD = houseD; updated++; }
    if (senateD != null) { h.markets.kalshi.senateR = 100 - senateD; }
  });

  // Add new entries for dates not in history
  const allDates = new Set([...Object.keys(houseByDate), ...Object.keys(senateByDate)]);
  allDates.forEach(date => {
    if (historyByDate[date]) return; // already exists
    const houseD  = houseByDate[date] ?? null;
    const senateD = senateByDate[date] ?? null;
    history.push({
      date,
      markets: {
        kalshi: {
          houseD:  houseD,
          senateR: senateD != null ? 100 - senateD : null,
        }
      }
    });
    updated++;
  });

  // Sort by date
  history.sort((a, b) => a.date.localeCompare(b.date));

  writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 2));
  console.log(`\n✅ Done! Updated/added ${updated} entries. Total: ${history.length} days.`);
  
  // Sample output
  const recent = history.filter(h => h.markets?.kalshi?.houseD != null).slice(-5);
  console.log('\nRecent Kalshi data:');
  recent.forEach(h => console.log(`  ${h.date}: House D ${h.markets.kalshi.houseD}% / Senate R ${h.markets.kalshi.senateR}%`));
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
