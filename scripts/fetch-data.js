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

async function fetchRendered(browser, url, waitMs = 3000) {
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36');
  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise(r => setTimeout(r, waitMs));
    return await page.content();
  } finally {
    await page.close();
  }
}

const RCP_RACES = {
  'North Carolina': 'https://www.realclearpolling.com/polls/senate/general/2026/north-carolina/cooper-vs-whatley',
  'Georgia':        'https://www.realclearpolling.com/polls/senate/general/2026/georgia/ossoff-vs-collins',
  'Michigan':       'https://www.realclearpolling.com/polls/senate/general/2026/michigan/stevens-vs-rogers',
  'Ohio (Special)': 'https://www.realclearpolling.com/polls/senate/general/2026/ohio/brown-vs-husted',
  'New Hampshire':  'https://www.realclearpolling.com/polls/senate/general/2026/new-hampshire/pappas-vs-sununu',
  'Maine':          'https://www.realclearpolling.com/polls/senate/general/2026/maine/mills-vs-collins',
  'Alaska':         'https://www.realclearpolling.com/polls/senate/general/2026/alaska/peltola-vs-sullivan',
  'Texas':          'https://www.realclearpolling.com/polls/senate/general/2026/texas/talarico-vs-paxton',
};

async function fetchRCPSenatePolls(browser) {
  console.log('Fetching RCP senate polls...');
  const results = {};
  for (const [state, url] of Object.entries(RCP_RACES)) {
    try {
      console.log(`  ${state}...`);
      const html = await fetchRendered(browser, url, 2000);
      const $ = cheerio.load(html);
      const polls = [];
      let avg = null;
      $('table tr').each((i, row) => {
        const cells = $(row).find('td');
        if (cells.length < 4) return;
        const source = $(cells[0]).text().trim();
        const date   = $(cells[1]).text().trim();
        const dem    = parseFloat($(cells[2]).text().trim());
        const rep    = parseFloat($(cells[3]).text().trim());
        if (!source || isNaN(dem) || isNaN(rep)) return;
        const entry = { source, date, dem, rep, margin: (dem - rep).toFixed(1) };
        if (source.toLowerCase().includes('rcp') || source.toLowerCase().includes('average')) avg = entry;
        else polls.push(entry);
      });
      if (!avg && polls.length > 0) {
        const recent = polls.slice(0, 5);
        const d = recent.reduce((s, p) => s + p.dem, 0) / recent.length;
        const r = recent.reduce((s, p) => s + p.rep, 0) / recent.length;
        avg = { source: 'Computed Avg', date: TODAY, dem: parseFloat(d.toFixed(1)), rep: parseFloat(r.toFixed(1)), margin: (d - r).toFixed(1) };
      }
      results[state] = { polls: polls.slice(0, 6), avg };
      console.log(`    Done: ${polls.length} polls`);
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
    const $ = cheerio.load(html);
    const polls = [];
    let avg = null;
    $('table tr').each((i, row) => {
      const cells = $(row).find('td');
      if (cells.length < 4) return;
      const source = $(cells[0]).text().trim();
      const date   = $(cells[1]).text().trim();
      const dem    = parseFloat($(cells[2]).text().trim());
      const rep    = parseFloat($(cells[3]).text().trim());
      if (!source || isNaN(dem) || isNaN(rep)) return;
      const entry = { source, date, dem, rep, margin: (dem - rep).toFixed(1) };
      if (source.toLowerCase().includes('rcp') || source.toLowerCase().includes('average')) avg = entry;
      else polls.push(entry);
    });
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
    $('table tr').each((_, row) => {
      const text = $(row).text().toLowerCase();
      if (text.includes('rcp average') || text.includes('average')) {
        const cells = $(row).find('td');
        approve    = parseFloat($(cells[1]).text().trim()) || null;
        disapprove = parseFloat($(cells[2]).text().trim()) || null;
      }
    });
    const net = (approve && disapprove) ? (approve - disapprove).toFixed(1) : null;
    console.log(`  net: ${net}`);
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
    $('table').each((_, table) => {
      const headers = [];
      $(table).find('th').each((_, th) => headers.push($(th).text().trim().toLowerCase()));
      const hasCook   = headers.some(h => h.includes('cook'));
      const hasSabato = headers.some(h => h.includes('sabato') || h.includes('crystal'));
      const hasIE     = headers.some(h => h.includes('inside') || h.includes('elections'));
      if (!hasCook && !hasSabato && !hasIE) return;
      let stateCol = -1, cookCol = -1, sabatoCol = -1, ieCol = -1;
      $(table).find('tr').first().find('th, td').each((i, cell) => {
        const t = $(cell).text().trim().toLowerCase();
        if (t.includes('state') || t.includes('race')) stateCol = i;
        if (t.includes('cook'))   cookCol   = i;
        if (t.includes('sabato') || t.includes('crystal')) sabatoCol = i;
        if (t.includes('inside')) ieCol     = i;
      });
      $(table).find('tr').slice(1).each((_, row) => {
        const cells = $(row).find('td');
        if (cells.length < 2) return;
        const state = safe(() => $(cells[stateCol >= 0 ? stateCol : 0]).text().trim());
        if (!state) return;
        ratings[state.replace(/\s*\(.*\)/, '').trim()] = {
          cook:   cookCol >= 0   ? safe(() => $(cells[cookCol]).text().trim())   : null,
          sabato: sabatoCol >= 0 ? safe(() => $(cells[sabatoCol]).text().trim()) : null,
          ie:     ieCol >= 0     ? safe(() => $(cells[ieCol]).text().trim())     : null,
        };
      });
    });
    console.log(`  ${Object.keys(ratings).length} states`);
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
          const title = (m.question || m.groupItemTitle || '').toLowerCase();
          if (!m.outcomePrices) continue;
          const pct = Math.round(parseFloat(JSON.parse(m.outcomePrices)[0]) * 100);
          if (title.includes('republican') && title.includes('senate') && title.includes('democrat') && title.includes('house')) markets.splitPct = pct;
          else if (title.includes('democrat') && (title.includes('sweep') || title.includes('both'))) markets.dSweepPct = pct;
          else if (title.includes('republican') && (title.includes('sweep') || title.includes('both'))) markets.repSweepPct = pct;
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
    const [houseRes, senateRes] = await Promise.allSettled([
      fetchJSON('https://api.elections.kalshi.com/v1/events/CONTROLH-2026'),
      fetchJSON('https://api.elections.kalshi.com/v1/events/CONTROLS-2026'),
    ]);
    if (houseRes.status === 'fulfilled') {
      const m = houseRes.value.markets?.find(m => m.subtitle?.toLowerCase().includes('democrat') || m.yes_sub_title?.toLowerCase().includes('democrat'));
      if (m) markets.houseD = Math.round(m.last_price || m.yes_bid || 0);
    }
    if (senateRes.status === 'fulfilled') {
      const m = senateRes.value.markets?.find(m => m.subtitle?.toLowerCase().includes('republican') || m.yes_sub_title?.toLowerCase().includes('republican'));
      if (m) markets.senateR = Math.round(m.last_price || m.yes_bid || 0);
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
