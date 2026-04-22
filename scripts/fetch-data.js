import fetch from 'node-fetch';
import * as cheerio from 'cheerio';
import { writeFileSync, readFileSync, mkdirSync } from 'fs';
import puppeteer from 'puppeteer-core';

const TODAY = new Date().toISOString().split('T')[0];
const NOW_TS = Math.floor(Date.now() / 1000);
const START_TS = 1700000000; // Nov 2023 — before markets opened

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

// ─── RTWH SENATE POLLS ───────────────────────────────────────────────────────

const STATE_KEYWORDS = {
  'North Carolina': ['north carolina', 'nc -', 'cooper', 'whatley'],
  'Georgia':        ['georgia', 'ga -', 'ossoff', 'collins'],
  'Michigan':       ['michigan', 'mi -', 'stevens', 'rogers', 'mcmorrow'],
  'Ohio (Special)': ['ohio', 'oh -', 'brown', 'husted'],
  'New Hampshire':  ['new hampshire', 'nh -', 'pappas', 'sununu'],
  'Maine':          ['maine', 'me -', 'collins', 'mills', 'platner'],
  'Alaska':         ['alaska', 'ak -', 'peltola', 'sullivan'],
  'Texas':          ['texas', 'tx -', 'talarico', 'cornyn', 'paxton'],
};

function matchState(title) {
  const t = title.toLowerCase();
  for (const [state, keywords] of Object.entries(STATE_KEYWORDS)) {
    if (keywords.some(k => t.includes(k))) return state;
  }
  return null;
}

function parseRTWHTable($) {
  const polls = [];
  $('table tr').each((i, row) => {
    if (i === 0) return;
    const cells = $(row).find('td');
    if (cells.length < 4) return;
    const date   = $(cells[0]).text().trim();
    const poll   = $(cells[1]).text().trim();
    const dem    = parseFloat($(cells[2]).text().replace('%', '').trim());
    const rep    = parseFloat($(cells[3]).text().replace('%', '').trim());
    if (!poll || isNaN(dem) || isNaN(rep)) return;
    polls.push({ source: poll, date, dem, rep, margin: (dem - rep).toFixed(1) });
  });
  return polls;
}

async function fetchAllSenatePolls(browser) {
  console.log('Fetching RTWH senate polls (all states)...');
  const results = {};
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36');

  try {
    await page.goto('https://www.racetothewh.com/senate/26polls', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await new Promise(r => setTimeout(r, 8000));
    await page.waitForSelector('select, [class*="igc"], [class*="tab"]', { timeout: 15000 }).catch(() => console.log('  Selector wait timed out'));

    const pageTitle = await page.title();
    const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 200));
    console.log('  Page title:', pageTitle);
    console.log('  Body preview:', bodyText);
    const allSelects = await page.evaluate(() => document.querySelectorAll('select').length);
    const allInputs = await page.evaluate(() => document.querySelectorAll('input, button').length);
    console.log(`  DOM: ${allSelects} selects, ${allInputs} inputs/buttons`);

    const options = await page.$$eval('select option', opts =>
      opts.map(o => ({ value: o.value, text: o.textContent.trim() }))
    );

    const selectCount = await page.$$eval('select', els => els.length);
    console.log(`  Found ${selectCount} select elements, ${options.length} options`);
    console.log(`  Option texts:`, options.slice(0, 5).map(o => o.text).join(', '));
    console.log(`  Found ${options.length} matchups:`, options.map(o => o.text).join(', '));

    for (const opt of options) {
      const state = matchState(opt.text);
      if (!state || results[state]) continue;

      console.log(`  Selecting: "${opt.text}" → ${state}`);
      await page.select('select.igc-tab-select', opt.value);
      await new Promise(r => setTimeout(r, 2000));

      const html = await page.content();
      const $ = cheerio.load(html);
      const polls = parseRTWHTable($);

      let avg = null;
      if (polls.length > 0) {
        const recent = polls.slice(0, 5);
        const d = recent.reduce((s, p) => s + p.dem, 0) / recent.length;
        const r = recent.reduce((s, p) => s + p.rep, 0) / recent.length;
        avg = { source: 'RTWH Avg', date: TODAY, dem: parseFloat(d.toFixed(1)), rep: parseFloat(r.toFixed(1)), margin: (d - r).toFixed(1) };
      }

      results[state] = { polls: polls.slice(0, 6), avg };
      console.log(`    ${polls.length} polls for ${state}, avg: ${avg ? avg.margin : 'none'}`);
    }

  } catch (e) {
    console.error('  RTWH senate error:', e.message);
  } finally {
    await page.close();
  }

  console.log(`  Got data for: ${Object.keys(results).join(', ')}`);
  return results;
}

// ─── RTWH GENERIC BALLOT ─────────────────────────────────────────────────────

async function fetchGenericBallot(browser) {
  console.log('Fetching RTWH generic ballot...');
  try {
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36');
    await page.goto('https://www.racetothewh.com/polls/genericballot', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await new Promise(r => setTimeout(r, 3000));
    const html = await page.content();
    await page.close();

    const $ = cheerio.load(html);
    const polls = [];
    $('table tr').each((i, row) => {
      if (i === 0) return;
      const cells = $(row).find('td');
      if (cells.length < 4) return;
      const date = $(cells[0]).text().trim();
      const poll = $(cells[1]).text().trim();
      const dem  = parseFloat($(cells[2]).text().replace('%', '').trim());
      const rep  = parseFloat($(cells[3]).text().replace('%', '').trim());
      if (!poll || isNaN(dem) || isNaN(rep)) return;
      polls.push({ source: poll, date, dem, rep, margin: (dem - rep).toFixed(1) });
    });

    let avg = null;
    if (polls.length > 0) {
      const recent = polls.slice(0, 5);
      const d = recent.reduce((s, p) => s + p.dem, 0) / recent.length;
      const r = recent.reduce((s, p) => s + p.rep, 0) / recent.length;
      avg = { source: 'RTWH Avg', date: TODAY, dem: parseFloat(d.toFixed(1)), rep: parseFloat(r.toFixed(1)), margin: (d - r).toFixed(1) };
    }

    console.log(`  ${polls.length} polls, avg: ${avg ? `D+${avg.margin}` : 'not found'}`);
    return { polls: polls.slice(0, 8), avg };
  } catch (e) {
    console.error('  Generic ballot error:', e.message);
    return { polls: [], avg: null };
  }
}

// ─── RTWH TRUMP APPROVAL ─────────────────────────────────────────────────────

async function fetchTrumpApproval(browser) {
  console.log('Fetching RTWH Trump approval...');
  try {
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36');
    await page.goto('https://www.racetothewh.com/trump', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await new Promise(r => setTimeout(r, 3000));
    const html = await page.content();
    await page.close();

    const $ = cheerio.load(html);
    let approve = null, disapprove = null;

    $('table tr').each((i, row) => {
      if (i === 0) return;
      const cells = $(row).find('td');
      if (cells.length < 3) return;
      const a = parseFloat($(cells[1]).text().replace('%','').trim());
      const d = parseFloat($(cells[2]).text().replace('%','').trim());
      if (!isNaN(a) && !isNaN(d) && !approve) {
        approve = a;
        disapprove = d;
      }
    });

    const net = (approve && disapprove) ? (approve - disapprove).toFixed(1) : null;
    console.log(`  approve: ${approve}, net: ${net}`);
    return { approve, disapprove, net, source: 'RTWH' };
  } catch (e) {
    console.error('  Trump approval error:', e.message);
    return { approve: null, disapprove: null, net: null };
  }
}

// ─── BALLOTPEDIA RATINGS ──────────────────────────────────────────────────────

async function fetchBallotpediaRatings() {
  console.log('Fetching Ballotpedia ratings...');
  try {
    const html = await fetchHTML('https://ballotpedia.org/United_States_Senate_elections,_2026');
    const $ = cheerio.load(html);
    const ratings = {};

    $('table').each((_, table) => {
      const headerText = $(table).find('th').map((_, th) => $(th).text().trim().toLowerCase()).get().join(' ');
      const hasCook   = headerText.includes('cook');
      const hasSabato = headerText.includes('sabato') || headerText.includes('crystal');
      const hasIE     = headerText.includes('inside') || headerText.includes('elections');
      if (!hasCook && !hasSabato && !hasIE) return;

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

// ─── POLYMARKET ───────────────────────────────────────────────────────────────

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

// ─── KALSHI (via Puppeteer browser scrape) ────────────────────────────────────

async function fetchKalshi(browser) {
  console.log('Fetching Kalshi via browser...');
  const markets = { houseD: null, senateR: null };
  try {
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36');

    try {
      await page.goto('https://kalshi.com/markets/controlh/house-winner/controlh-2026', { waitUntil: 'domcontentloaded', timeout: 60000 });
      await new Promise(r => setTimeout(r, 5000));
      const houseD = await page.evaluate(() => {
        const bodyText = document.body.innerText;
        const lines = bodyText.split('\n').map(l => l.trim()).filter(Boolean);
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].toLowerCase().includes('democrat')) {
            for (let j = i; j < Math.min(i+3, lines.length); j++) {
              const m = lines[j].match(/^(\d+)%$/);
              if (m) return parseInt(m[1]);
            }
          }
        }
        return null;
      });
      if (houseD) markets.houseD = houseD;
      console.log('  Kalshi House D:', houseD);
    } catch (e) { console.error('  Kalshi house error:', e.message); }

    try {
      await page.goto('https://kalshi.com/markets/controls/senate-winner/controls-2026', { waitUntil: 'domcontentloaded', timeout: 60000 });
      await new Promise(r => setTimeout(r, 5000));
      const senateR = await page.evaluate(() => {
        const bodyText = document.body.innerText;
        const lines = bodyText.split('\n').map(l => l.trim()).filter(Boolean);
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].toLowerCase().includes('republican')) {
            for (let j = i; j < Math.min(i+3, lines.length); j++) {
              const m = lines[j].match(/^(\d+)%$/);
              if (m) return parseInt(m[1]);
            }
          }
        }
        return null;
      });
      if (senateR) markets.senateR = senateR;
      console.log('  Kalshi Senate R:', senateR);
    } catch (e) { console.error('  Kalshi senate error:', e.message); }

    await page.close();
  } catch (e) { console.error('  Kalshi browser error:', e.message); }
  console.log('  Kalshi:', markets);
  return markets;
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n=== Midtrack Fetch — ${TODAY} ===\n`);

  const browser = await puppeteer.launch({
    headless: 'new',
    executablePath: '/usr/bin/google-chrome-stable',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });

  try {
    const [polymarket, ratings] = await Promise.all([
      fetchPolymarket(),
      fetchBallotpediaRatings(),
    ]);
    const kalshi        = await fetchKalshi(browser);
    const senatePolls   = await fetchAllSenatePolls(browser);
    const genericBallot = await fetchGenericBallot(browser);
    const trumpApproval = await fetchTrumpApproval(browser);

    let existingData = {};
    try { existingData = JSON.parse(readFileSync('data/data.json', 'utf8')); }
    catch { console.log('  No existing data.json'); }

    const todayEntry = {
      date: TODAY,
      fetchedAt: new Date().toISOString(),
      markets: { polymarket, kalshi },
      genericBallot: genericBallot.polls?.length > 0 ? genericBallot : (existingData.genericBallot || { polls: [], avg: null }),
      senatePolls: Object.keys(senatePolls).length > 0 ? senatePolls : (existingData.senatePolls || {}),
      senateRatings: Object.keys(ratings).length > 0 ? ratings : (existingData.senateRatings || {}),
      trumpApproval: trumpApproval.approve ? trumpApproval : (existingData.trumpApproval || {}),
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
    console.log(`   States with polls: ${Object.keys(senatePolls).filter(s => senatePolls[s].polls.length > 0).join(', ')}`);
  } finally {
    await browser.close();
  }
}

main().catch(err => { console.error('Fatal error:', err); process.exit(1); });
