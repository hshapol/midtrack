import fetch from 'node-fetch';
import * as cheerio from 'cheerio';
import { writeFileSync, readFileSync, mkdirSync } from 'fs';
import puppeteer from 'puppeteer-core';

const TODAY = new Date().toISOString().split('T')[0];

async function fetchJSON(url) {
  const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

async function fetchHTML(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MidtermTracker/1.0)', 'Accept': 'text/html,application/xhtml+xml' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

function safe(fn, fallback = null) {
  try { return fn(); } catch { return fallback; }
}

async function fetchRendered(browser, url, waitMs = 2000) {
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36');
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await new Promise(r => setTimeout(r, waitMs));
    return await page.content();
  } finally {
    await page.close();
  }
}

// RCP table format: Pollster | Date | Sample | MoE | Dem(col4) | Rep(col5) | Spread
function parseRCPTable(html) {
  const $ = cheerio.load(html);
  const polls = [];
  let avg = null;

  $('table tr').each((i, row) => {
    const cells = $(row).find('td');
    if (cells.length < 6) return;
    const source = $(cells[0]).text().trim();
    const date   = $(cells[1]).text().trim();
    const dem    = parseFloat($(cells[4]).text().trim());
    const rep    = parseFloat($(cells[5]).text().trim());
    if (!source || isNaN(dem) || isNaN(rep)) return;
    const entry = { source, date, dem, rep, margin: (dem - rep).toFixed(1) };
    if (source.toLowerCase().includes('rcp') || source.toLowerCase().includes('average')) avg = entry;
    else polls.push(entry);
  });

  return { polls, avg };
}

const RCP_RACES = {
  'North Carolina': 'https://www.realclearpolling.com/polls/senate/general/2026/north-carolina/cooper-vs-whatley',
  'Georgia':        'https://www.realclearpolling.com/polls/senate/general/2026/georgia/ossoff-vs-collins',
  'Michigan':       'https://www.realclearpolling.com/polls/senate/general/2026/michigan/rogers-vs-stevens',
  'Ohio (Special)': 'https://www.realclearpolling.com/polls/senate/special-election/2026/ohio/husted-vs-brown',
  'New Hampshire':  'https://www.realclearpolling.com/polls/senate/general/2026/new-hampshire/pappas-vs-sununu',
  'Maine':          'https://www.realclearpolling.com/polls/senate/general/2026/maine/collins-vs-mills',
  'Alaska':         'https://www.realclearpolling.com/polls/senate/general/2026/alaska/sullivan-vs-peltola',
  'Texas':          'https://www.realclearpolling.com/polls/senate/general/2026/texas/cornyn-vs-talarico',
};

async function fetchRCPSenatePolls(browser) {
  console.log('Fetching RCP senate polls...');
  const results = {};
  for (const [state, url] of Object.entries(RCP_RACES)) {
    try {
      console.log(`  ${state}...`);
      const html = await fetchRendered(browser, url, 2000);
      const { polls, avg } = parseRCPTable(html);

      // Fallback: compute avg from recent polls if RCP avg not found
      let finalAvg = avg;
      if (!finalAvg && polls.length > 0) {
        const recent = polls.slice(0, 5);
        const d = recent.reduce((s, p) => s + p.dem, 0) / recent.length;
        const r = recent.reduce((s, p) => s + p.rep, 0) / recent.length;
        finalAvg = { source: 'Computed Avg', date: TODAY, dem: parseFloat(d.toFixed(1)), rep: parseFloat(r.toFixed(1)), margin: (d - r).toFixed(1) };
      }

      results[state] = { polls: polls.slice(0, 6), avg: finalAvg };
      console.log(`    ${polls.length} polls, avg: ${finalAvg ? finalAvg.margin : 'none'}`);
    } catch (e) {
      console.error(`  Error ${state}:`, e.message);
      results[state] = { polls: [], avg: null };
    }
  }
  return results;
}

async function fetchGenericBallot(browser) {
  console.log('Fetching generic ballot...');
  try {
    const html = await fetchRendered(browser, 'https://www.realclearpolling.com/polls/congress/generic-congressional-ballot', 3000);
    const { polls, avg } = parseRCPTable(html);
    console.log(`  ${polls.length} polls, avg: ${avg ? `D+${avg.margin}` : 'not found'}`);
    return { polls: polls.slice(0, 8), avg };
  } catch (e) {
    console.error('  Generic ballot error:', e.message);
    return { polls: [], avg: null };
  }
}

async function fetchTrumpApproval(browser) {
  console.log('Fetching Trump approval...');
  try {
    const html = await fetchRendered(browser, 'https://www.realclearpolling.com/polls/approval/donald-trump/job-approval', 3000);
    const $ = cheerio.load(html);
    let approve = null, disapprove = null;

    // Approval table: Pollster | Date | Sample | MoE | Approve(4) | Disapprove(5)
    $('table tr').each((_, row) => {
      const cells = $(row).find('td');
      if (cells.length < 6) return;
      const source = $(cells[0]).text().trim().toLowerCase();
      if (source.includes('rcp') || source.includes('average')) {
        approve    = parseFloat($(cells[4]).text().trim()) || null;
        disapprove = parseFloat($(cells[5]).text().trim()) || null;
      }
    });

    // Fallback — try cols 1 and 2 if above didn't work
    if (!approve) {
      $('table tr').each((_, row) => {
        const cells = $(row).find('td');
        if (cells.length < 3) return;
        const source = $(cells[0]).text().trim().toLowerCase();
        if (source.includes('rcp') || source.includes('average')) {
          approve    = parseFloat($(cells[1]).text().trim()) || null;
          disapprove = parseFloat($(cells[2]).text().trim()) || null;
        }
      });
    }

    const net = (approve && disapprove) ? (approve - disapprove).toFixed(1) : null;
    console.log(`  approve: ${approve}, disapprove: ${disapprove}, net: ${net}`);
    return { approve, disapprove, net, source: 'RCP Average' };
  } catch (e) {
    console.error('  Trump approval error:', e.message);
    return { approve: null, disapprove: null, net: null };
  }
}

async function fetchBallotpediaRatings() {
  console.log('Fetching Ballotpedia ratings...');
  try {
    const html = await fetchHTML('https://ballotpedia.org/United_States_Senate_elections,_2026');
    const $ = cheerio.load(html);
    const ratings = {};

    // Try multiple table parsing strategies
    $('table').each((_, table) => {
      const headerText = $(table).find('th').map((_, th) => $(th).text().trim().toLowerCase()).get().join(' ');
      const hasCook   = headerText.includes('cook');
      const hasSabato = headerText.includes('sabato') || headerText.includes('crystal');
      const hasIE     = headerText.includes('inside') || headerText.includes('elections');
      if (!hasCook && !hasSabato && !hasIE) return;

      // Find column indices from first header row
      const headerCells = $(table).find('tr').first().find('th, td');
      let stateCol = 0, cookCol = -1, sabatoCol = -1, ieCol = -1;
      headerCells.each((i, cell) => {
        const t = $(cell).text().trim().toLowerCase();
        if (t.includes('state') || t.includes('race') || t.includes('election')) stateCol = i;
        if (t.includes('cook'))   cookCol   = i;
        if (t.includes('sabato') || t.includes('crystal')) sabatoCol = i;
        if (t.includes('inside')) ieCol     = i;
      });

      $(table).find('tr').slice(1).each((_, row) => {
        const cells = $(row).find('td');
        if (cells.length < 2) return;
        const stateRaw = safe(() => $(cells[stateCol]).text().trim());
        if (!stateRaw || stateRaw.length < 2) return;
        const state = stateRaw.replace(/\s*\(.*\)/, '').replace(/\[.*\]/, '').trim();
        if (state.length < 2) return;
        ratings[state] = {
          cook:   cookCol >= 0   ? safe(() => $(cells[cookCol]).text().trim().replace(/\[.*\]/, '').trim())   : null,
          sabato: sabatoCol >= 0 ? safe(() => $(cells[sabatoCol]).text().trim().replace(/\[.*\]/, '').trim()) : null,
          ie:     ieCol >= 0     ? safe(() => $(cells[ieCol]).text().trim().replace(/\[.*\]/, '').trim())     : null,
        };
      });
    });

    console.log(`  ${Object.keys(ratings).length} states: ${Object.keys(ratings).join(', ')}`);
    return ratings;
  } catch (e) {
    console.error('  Ballotpedia error:', e.message);
    return {};
  }
}

async function fetchPolymarket() {
  console.log('Fetching Polymarket...');
  const markets = { houseD: null, senateR: null, splitPct: null, dSweepPct: null, repSweepPct: null };
  const slugs = [
    { key: 'house',   slug: 'which-party-will-win-the-house-in-2026' },
    { key: 'senate',  slug: 'which-party-will-win-the-senate-in-2026' },
    { key: 'balance', slug: 'balance-of-power-2026-midterms' },
  ];
  for (const { key, slug } of slugs) {
    try {
      const data = await fetchJSON(`https://gamma-api.polymarket.com/events?slug=${slug}&limit=1`);
      if (!data?.length) continue;
      const event = data[0];

      if (key === 'house') {
        const m = event.markets?.find(m => m.outcomePrices && (m.question?.toLowerCase().includes('democrat') || m.groupItemTitle?.toLowerCase().includes('democrat')));
        if (m?.outcomePrices) markets.houseD = Math.round(parseFloat(JSON.parse(m.outcomePrices)[0]) * 100);
      }
      if (key === 'senate') {
        const m = event.markets?.find(m => m.question?.toLowerCase().includes('republican') || m.groupItemTitle?.toLowerCase().includes('republican'));
        if (m?.outcomePrices) markets.senateR = Math.round(parseFloat(JSON.parse(m.outcomePrices)[0]) * 100);
      }
      if (key === 'balance') {
        for (const m of (event.markets || [])) {
          const title = (m.question || m.groupItemTitle || '');
          if (!m.outcomePrices) continue;
          const pct = Math.round(parseFloat(JSON.parse(m.outcomePrices)[0]) * 100);
          if (title.includes('R Senate, D House')) markets.splitPct = pct;
          else if (title.includes('D Senate, D House')) markets.dSweepPct = pct;
          else if (title.includes('R Senate, R House')) markets.repSweepPct = pct;
        }
      }
    } catch (e) { console.error(`  Polymarket ${key} error:`, e.message); }
  }
  console.log('  Polymarket:', markets);
  return markets;
}

async function fetchKalshi() {
  console.log('Fetching Kalshi...');
  const markets = { houseD: null, senateR: null };
  try {
    // Try v2 API endpoints
    const [houseRes, senateRes] = await Promise.allSettled([
      fetchJSON('https://api.kalshi.com/trade-api/v2/events/CONTROLH-2026'),
      fetchJSON('https://api.kalshi.com/trade-api/v2/events/CONTROLS-2026'),
    ]);

    if (houseRes.status === 'fulfilled') {
      const data = houseRes.value;
      const m = data.event?.markets?.find(m =>
        (m.subtitle || m.yes_sub_title || '').toLowerCase().includes('democrat')
      );
      if (m) markets.houseD = Math.round((m.last_price || m.yes_bid || 0) * 100);
    }

    if (senateRes.status === 'fulfilled') {
      const data = senateRes.value;
      const m = data.event?.markets?.find(m =>
        (m.subtitle || m.yes_sub_title || '').toLowerCase().includes('republican')
      );
      if (m) markets.senateR = Math.round((m.last_price || m.yes_bid || 0) * 100);
    }
  } catch (e) { console.error('  Kalshi error:', e.message); }
  console.log('  Kalshi:', markets);
  return markets;
}

async function main() {
  console.log(`\n=== Midtrack Fetch — ${TODAY} ===\n`);

  const browser = await puppeteer.launch({
    headless: 'new',
    executablePath: '/usr/bin/google-chrome-stable',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });

  try {
    const [ratings, polymarket, kalshi, genericBallot, senatePolls, trumpApproval] = await Promise.allSettled([
      fetchBallotpediaRatings(),
      fetchPolymarket(),
      fetchKalshi(),
      fetchGenericBallot(browser),
      fetchRCPSenatePolls(browser),
      fetchTrumpApproval(browser),
    ]);

    const todayEntry = {
      date: TODAY,
      fetchedAt: new Date().toISOString(),
      markets: {
        polymarket: polymarket.status === 'fulfilled' ? polymarket.value : {},
        kalshi:     kalshi.status     === 'fulfilled' ? kalshi.value     : {},
      },
      genericBallot: genericBallot.status === 'fulfilled' ? genericBallot.value : { polls: [], avg: null },
      senatePolls:   senatePolls.status   === 'fulfilled' ? senatePolls.value   : {},
      senateRatings: ratings.status       === 'fulfilled' ? ratings.value       : {},
      trumpApproval: trumpApproval.status === 'fulfilled' ? trumpApproval.value : {},
    };

    mkdirSync('data', { recursive: true });

    let history = [];
    try { history = JSON.parse(readFileSync('data/history.json', 'utf8')); }
    catch { console.log('  Starting fresh history'); }

    const idx = history.findIndex(e => e.date === TODAY);
    if (idx >= 0) history[idx] = todayEntry;
    else history.push(todayEntry);

    writeFileSync('data/history.json', JSON.stringify(history, null, 2));
    writeFileSync('data/data.json', JSON.stringify({ lastUpdated: TODAY, ...todayEntry }, null, 2));

    console.log(`\n✅ Done. ${history.length} days tracked`);
  } finally {
    await browser.close();
  }
}

main().catch(err => { console.error('Fatal error:', err); process.exit(1); });
