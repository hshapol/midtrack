// scripts/backfill-history.js
// Run ONCE: node scripts/backfill-history.js
// Backfills history.json with Polymarket + Kalshi price history since market open

import fetch from 'node-fetch';
import { writeFileSync, readFileSync } from 'fs';

const GAMMA_BASE = 'https://gamma-api.polymarket.com';
const CLOB_BASE  = 'https://clob.polymarket.com';
const KALSHI_BASE = 'https://trading-api.kalshi.com/trade-api/v2';

// Nov 1 2024 — before markets opened
const START_TS = 1730419200;
const NOW_TS   = Math.floor(Date.now() / 1000);

async function fetchJSON(url) {
  const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

// ─── POLYMARKET TOKEN IDs ─────────────────────────────────────────────────────

async function getPolymarketTokens() {
  console.log('Getting Polymarket token IDs...');
  const tokens = {};
  const slugs = {
    house:   'which-party-will-win-the-house-in-2026',
    senate:  'which-party-will-win-the-senate-in-2026',
    balance: 'balance-of-power-2026-midterms',
  };

  for (const [key, slug] of Object.entries(slugs)) {
    try {
      const data = await fetchJSON(`${GAMMA_BASE}/events?slug=${slug}&limit=1`);
      if (!data?.length) continue;
      const event = data[0];

      if (key === 'house') {
        const m = event.markets?.find(m =>
          m.question?.toLowerCase().includes('democrat') ||
          m.groupItemTitle?.toLowerCase().includes('democrat')
        );
        if (m?.clobTokenIds) { tokens.houseD = JSON.parse(m.clobTokenIds)[0]; console.log(`  House D token: ${tokens.houseD?.slice(0,12)}...`); }
      }
      if (key === 'senate') {
        const m = event.markets?.find(m =>
          m.question?.toLowerCase().includes('republican') ||
          m.groupItemTitle?.toLowerCase().includes('republican')
        );
        if (m?.clobTokenIds) { tokens.senateR = JSON.parse(m.clobTokenIds)[0]; console.log(`  Senate R token: ${tokens.senateR?.slice(0,12)}...`); }
      }
      if (key === 'balance') {
        for (const m of (event.markets || [])) {
          const title = (m.question || m.groupItemTitle || '');
          if (!m.clobTokenIds) continue;
          const tid = JSON.parse(m.clobTokenIds)[0];
          if (title.includes('R Senate, D House')) { tokens.split = tid; }
          else if (title.includes('D Senate, D House')) { tokens.dSweep = tid; }
          else if (title.includes('R Senate, R House')) { tokens.repSweep = tid; }
        }
        console.log(`  Balance tokens found: split=${!!tokens.split}, dSweep=${!!tokens.dSweep}, repSweep=${!!tokens.repSweep}`);
      }
    } catch (e) { console.error(`  Error ${key}:`, e.message); }
  }
  return tokens;
}

// ─── POLYMARKET PRICE HISTORY ─────────────────────────────────────────────────

async function getPolymarketHistory(tokenId, label) {
  if (!tokenId) { console.log(`  Skipping ${label} — no token`); return []; }
  try {
    const url = `${CLOB_BASE}/prices-history?market=${tokenId}&startTs=${START_TS}&endTs=${NOW_TS}&fidelity=1440`;
    const data = await fetchJSON(url);
    const history = (data.history || []).map(p => ({
      date: new Date(p.t * 1000).toISOString().split('T')[0],
      price: Math.round(p.p * 100),
    }));
    console.log(`  ${label}: ${history.length} days (${history[0]?.date} → ${history[history.length-1]?.date})`);
    return history;
  } catch (e) {
    console.error(`  Error ${label}:`, e.message);
    return [];
  }
}

// ─── KALSHI PRICE HISTORY ─────────────────────────────────────────────────────

async function getKalshiHistory(series, market, label) {
  try {
    const url = `${KALSHI_BASE}/series/${series}/markets/${market}/candlesticks?start_ts=${START_TS}&end_ts=${NOW_TS}&period_interval=1440`;
    console.log(`  Fetching Kalshi ${label}...`);
    const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
    if (!res.ok) { console.log(`  Kalshi ${label} HTTP ${res.status}`); return []; }
    const data = await res.json();
    const candles = data.candlesticks || [];
    const history = candles
      .filter(c => c.price?.close_dollars)
      .map(c => ({
        date: new Date(c.end_period_ts * 1000).toISOString().split('T')[0],
        price: Math.round(parseFloat(c.price.close_dollars) * 100),
      }));
    console.log(`  Kalshi ${label}: ${history.length} days (${history[0]?.date} → ${history[history.length-1]?.date})`);
    return history;
  } catch (e) {
    console.error(`  Kalshi ${label} error:`, e.message);
    return [];
  }
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n=== Midtrack Historical Backfill (Polymarket + Kalshi) ===\n');

  // Get Polymarket token IDs
  const tokens = await getPolymarketTokens();

  // Fetch Polymarket histories
  console.log('\nFetching Polymarket histories...');
  const [houseDHist, senateRHist, splitHist, dSweepHist, repSweepHist] = await Promise.all([
    getPolymarketHistory(tokens.houseD,    'House D'),
    getPolymarketHistory(tokens.senateR,   'Senate R'),
    getPolymarketHistory(tokens.split,     'Split'),
    getPolymarketHistory(tokens.dSweep,    'D Sweep'),
    getPolymarketHistory(tokens.repSweep,  'Rep Sweep'),
  ]);

  // Fetch Kalshi histories
  console.log('\nFetching Kalshi histories...');
  const kalshiHouseDHist  = await getKalshiHistory('CONTROLH', 'CONTROLH-2026-D', 'House D');
  const kalshiSenateDHist = await getKalshiHistory('CONTROLS', 'CONTROLS-2026-D', 'Senate D');

  // Build date map
  const dateMap = {};
  const set = (date, path, value) => {
    if (!dateMap[date]) dateMap[date] = { markets: { polymarket: {}, kalshi: {} } };
    const parts = path.split('.');
    let obj = dateMap[date];
    for (let i = 0; i < parts.length - 1; i++) obj = obj[parts[i]];
    obj[parts[parts.length - 1]] = value;
  };

  houseDHist.forEach(({ date, price })    => set(date, 'markets.polymarket.houseD', price));
  senateRHist.forEach(({ date, price })   => set(date, 'markets.polymarket.senateR', price));
  splitHist.forEach(({ date, price })     => set(date, 'markets.polymarket.splitPct', price));
  dSweepHist.forEach(({ date, price })    => set(date, 'markets.polymarket.dSweepPct', price));
  repSweepHist.forEach(({ date, price })  => set(date, 'markets.polymarket.repSweepPct', price));

  kalshiHouseDHist.forEach(({ date, price })  => set(date, 'markets.kalshi.houseD', price));
  // Senate Kalshi: stored as D price, convert to R for consistency
  kalshiSenateDHist.forEach(({ date, price }) => set(date, 'markets.kalshi.senateR', 100 - price));

  console.log(`\nBuilt date map: ${Object.keys(dateMap).length} unique dates`);

  // Load and merge existing history.json
  let existing = [];
  try {
    existing = JSON.parse(readFileSync('data/history.json', 'utf8'));
    console.log(`Loaded existing history.json: ${existing.length} entries`);
  } catch { console.log('No existing history.json — starting fresh'); }

  const byDate = {};
  existing.forEach(e => byDate[e.date] = e);

  let added = 0, updated = 0;
  for (const [date, data] of Object.entries(dateMap)) {
    if (byDate[date]) {
      // Merge market data into existing entry
      byDate[date].markets = byDate[date].markets || {};
      byDate[date].markets.polymarket = { ...byDate[date].markets?.polymarket, ...data.markets.polymarket };
      byDate[date].markets.kalshi     = { ...byDate[date].markets?.kalshi,     ...data.markets.kalshi };
      updated++;
    } else {
      byDate[date] = {
        date,
        markets: data.markets,
        genericBallot: { polls: [], avg: null },
        senatePolls: {},
        senateRatings: {},
        trumpApproval: {},
      };
      added++;
    }
  }

  const final = Object.values(byDate).sort((a, b) => a.date.localeCompare(b.date));
  writeFileSync('data/history.json', JSON.stringify(final, null, 2));

  console.log(`\n✅ Done!`);
  console.log(`   ${added} new entries added`);
  console.log(`   ${updated} existing entries updated with market data`);
  console.log(`   Total: ${final.length} days`);
  console.log(`   Range: ${final[0]?.date} → ${final[final.length-1]?.date}`);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
