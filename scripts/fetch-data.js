import fetch from 'node-fetch';
import { writeFileSync, readFileSync, mkdirSync } from 'fs';
const _grades = JSON.parse(readFileSync(new URL('../data/pollster-grades.json', import.meta.url)));
function getPollsterWeight(name) {
  if (!name) return 0.5;
  let grade = _grades[name];
  if (!grade) { const lower = name.toLowerCase(); const e = Object.entries(_grades).find(([k]) => { const kl = k.toLowerCase(); return lower.includes(kl) || kl.includes(lower); }); grade = e?.[1]; }
  const map = {'A+':2.0,'A':1.8,'A-':1.6,'A/B':1.5,'B+':1.3,'B':1.1,'B/C':0.9,'C+':0.7,'C':0.5,'C/D':0.4,'D+':0.3,'D':0.2,'F':0};
  return map[grade] ?? 0.5;
}

const TODAY = new Date().toISOString().split('T')[0];

const EXPECTED_CANDIDATES = {
  'North Carolina': ['Cooper', 'Whatley'],
  'Georgia':        ['Ossoff'],
  'Maine':          ['Collins'],
  'Ohio (Special)': ['Brown', 'Husted'],
  'New Hampshire':  ['Pappas'],
  'Alaska':         ['Peltola', 'Sullivan'],
  'Michigan':       null,
  'Texas':          null,
  'Nebraska':       ['Osborn', 'Ricketts'],
  'Iowa':           null,
};

// ─── POLYMARKET (unchanged from original) ────────────────────────────────────

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
      const res = await fetch(`https://gamma-api.polymarket.com/events?slug=${slug}&limit=1`, {
        headers: { 'Accept': 'application/json' }
      });
      if (!res.ok) continue;
      const data = await res.json();
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

// ─── KALSHI ───────────────────────────────────────────────────────────────────

async function fetchKalshi() {
  console.log('Fetching Kalshi...');
  try {
    const [houseRes, senateRes, bopRes] = await Promise.all([
      fetch('https://external-api.kalshi.com/trade-api/v2/markets?series_ticker=CONTROLH&limit=100'),
      fetch('https://external-api.kalshi.com/trade-api/v2/markets?series_ticker=CONTROLS&limit=100'),
      fetch('https://external-api.kalshi.com/trade-api/v2/markets?series_ticker=KXBALANCEPOWERCOMBO&limit=100'),
]);
    
    let houseD = null, senateR = null;
    
    if (houseRes.ok) {
      const d = await houseRes.json();
      const markets = d.markets || [];
      // Find Dem wins contract
      const m = markets.find(m => m.ticker === 'CONTROLH-2026-D') || markets.find(m => m.ticker?.includes('2026') && m.ticker?.includes('-D'));
      if (m) {
        const price = m.yes_bid_dollars ?? m.last_price_dollars ?? m.close_price_dollars ?? null;
        if (price != null) houseD = Math.round(parseFloat(price) * 100);
      }
    }
    
    if (senateRes.ok) {
      const d = await senateRes.json();
      const markets = d.markets || [];
      const m = markets.find(m => m.ticker === 'CONTROLS-2026-D') || markets.find(m => m.ticker?.includes('2026') && m.ticker?.includes('-D'));
      if (m) {
        const price = m.yes_bid_dollars ?? m.last_price_dollars ?? m.close_price_dollars ?? null;
        if (price != null) senateR = 100 - Math.round(parseFloat(price) * 100);
      }
    }

    let dSweepPct = null, splitPct = null, repSweepPct = null;
    if (bopRes.ok) {
      const d = await bopRes.json();
      const markets = d.markets || [];
      console.log('  Kalshi BOP markets:', markets.map(m => m.ticker + ' ' + (m.subtitle || m.title || '')));
      markets.forEach(function(m) {
        const ticker = m.ticker || '';
        const price = m.yes_bid_dollars ?? m.last_price_dollars ?? null;
        if (price == null) return;
        const pct = Math.round(parseFloat(price) * 100);
        if (ticker.endsWith('-DD')) dSweepPct = pct;       // Dem House + Dem Senate
        else if (ticker.endsWith('-RR')) repSweepPct = pct; // Rep House + Rep Senate
        else if (ticker.endsWith('-DR')) splitPct = pct;    // Dem House + Rep Senate
      });
      console.log('  Kalshi BOP:', { dSweepPct, splitPct, repSweepPct });
    }
    
    console.log('  Kalshi:', { houseD, senateR });
    return { houseD, senateR, dSweepPct, splitPct, repSweepPct, updatedDate: TODAY };
  } catch (e) {
    console.error('  Kalshi error:', e.message);
    return null;
  }
}

// ─── VOTEHUB API ──────────────────────────────────────────────────────────────

const STATE_SUBJECTS = {
  'North Carolina': '2026 North Carolina',
  'Maine':          '2026 Maine',
  'Ohio (Special)': '2026 Ohio',
  'Michigan':       '2026 Michigan',
  'Georgia':        '2026 Georgia',
  'New Hampshire':  '2026 New Hampshire',
  'Alaska':         '2026 Alaska',
  'Texas':          '2026 Texas',
  'Nebraska':       '2026 Nebraska',
  'Iowa':           '2026 Iowa',
};

const DEM_CANDIDATES = ['cooper','ossoff','pappas','peltola','stevens','mcmorrow','el-sayed','brown','platner','mills','talarico','osborn','cortez masto','slotkin'];
const REP_CANDIDATES = ['whatley','collins','sununu','sullivan','rogers','husted','cornyn','paxton','ricketts','hinson'];

function getDemPct(answers) {
  return answers.find(a => ['Dem','Democrat','Democratic'].includes(a.choice) ||
    DEM_CANDIDATES.some(c => a.choice.toLowerCase().includes(c)))?.pct ?? null;
}
function getRepPct(answers) {
  return answers.find(a => ['Rep','Republican'].includes(a.choice) ||
    REP_CANDIDATES.some(c => a.choice.toLowerCase().includes(c)))?.pct ?? null;
}

function computeAverage(polls, stateName) {
  let nonPartisan = polls.filter(p => !p.partisan && getDemPct(p.answers) !== null && getRepPct(p.answers) !== null);
  const expected = EXPECTED_CANDIDATES[stateName];
  if (expected) {
    nonPartisan = nonPartisan.filter(p =>
      expected.some(name => p.answers.some(a => a.candidate && a.candidate.toLowerCase().includes(name.toLowerCase())))
    );
  }
  if (!nonPartisan.length) return null;

  // One poll per pollster (most recent)
  const byPollster = {};
  nonPartisan.forEach(p => {
    if (!byPollster[p.pollster] || p.end_date > byPollster[p.pollster].end_date)
      byPollster[p.pollster] = p;
  });
  const deduped = Object.values(byPollster);

  const now = new Date();
  const HALF_LIFE = 30;
  let wDem = 0, wRep = 0, wTotal = 0;
  deduped.forEach(p => {
    const age = (now - new Date(p.end_date)) / (1000 * 60 * 60 * 24);
    const recency = Math.pow(0.5, age / HALF_LIFE);
    const quality = getPollsterWeight(p.pollster);
    const sampleW = p.sample_size ? Math.sqrt(p.sample_size / 600) : 1;
    const w = recency * quality * sampleW;
    wDem += getDemPct(p.answers) * w;
    wRep += getRepPct(p.answers) * w;
    wTotal += w;
  });

  if (!wTotal) return null;
  const dem = +(wDem / wTotal).toFixed(1);
  const rep = +(wRep / wTotal).toFixed(1);
  const margin = +(dem - rep).toFixed(1);
  const sorted = [...deduped].sort((a, b) => new Date(b.end_date) - new Date(a.end_date));
  const fmt = d => d.slice(5).replace('-', '/');
  return {
    source: 'SB-style Avg',
    dem, rep,
    margin: margin.toString(),
    date: fmt(sorted[0].end_date),
    dateRange: fmt(sorted[sorted.length - 1].end_date) + ' - ' + fmt(sorted[0].end_date),
  };
}

async function fetchVoteHub(existingData) {
  console.log('Fetching VoteHub API...');
  try {
    const res = await fetch('https://api.votehub.com/polls', {
      headers: { 'Accept': 'application/json', 'User-Agent': 'midtrack-bot/1.0' }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const all = await res.json();
    console.log(`  VoteHub: ${all.length} total polls`);

    // ── Senate polls ──────────────────────────────────────────────────────────
    const senatePolls = {};
    for (const [stateName, subject] of Object.entries(STATE_SUBJECTS)) {
      const polls = all
        .filter(p => p.poll_type === 'us-senator' && p.subject === subject)
        .sort((a, b) => new Date(b.end_date) - new Date(a.end_date));

      if (!polls.length) {
        console.log(`  ${stateName}: no polls — preserving existing`);
        senatePolls[stateName] = existingData?.senatePolls?.[stateName] || { avg: null, polls: [] };
        continue;
      }

      console.log(`  ${stateName}: ${polls.length} polls (latest ${polls[0].end_date})`); 
      const avg = computeAverage(polls, stateName);
      const fmt = d => d.slice(5).replace('-', '/');

      const seen = new Set();
      const pollsArr = polls
        .filter(p => {
          if (p.partisan) return false;
          const k = p.pollster + '|' + p.end_date;
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        })
        .slice(0, 10)
        .map(p => {
        const dem = getDemPct(p.answers);
        const rep = getRepPct(p.answers);
        if (dem === null || rep === null) return null;
        return {
          source: p.pollster,
          date:   p.start_date ? fmt(p.start_date) + ' - ' + fmt(p.end_date) : fmt(p.end_date),
          dem, rep,
          margin: (+(dem - rep).toFixed(1)).toString(),
          partisan: p.partisan || null,
        };
      }).filter(Boolean);

      senatePolls[stateName] = {
        avg:   avg || existingData?.senatePolls?.[stateName]?.avg || null,
        polls: pollsArr.length ? pollsArr : (existingData?.senatePolls?.[stateName]?.polls || []),
        rtwh:  existingData?.senatePolls?.[stateName]?.rtwh || null,
      };
    }

    // ── Generic ballot ────────────────────────────────────────────────────────
    const gbPolls = all
      .filter(p => p.poll_type === 'generic-ballot' && p.subject === '2026')
      .sort((a, b) => new Date(b.end_date) - new Date(a.end_date));

    console.log(`  Generic ballot: ${gbPolls.length} polls`);
    const gbAvg = computeAverage(gbPolls);
    const gbArr = gbPolls.slice(0, 6).map(p => {
      const dem = getDemPct(p.answers);
      const rep = getRepPct(p.answers);
      if (dem === null || rep === null) return null;
      return {
        source: p.pollster,
        date:   p.end_date.slice(5).replace('-', '/'),
        dem, rep,
        margin: (+(dem - rep).toFixed(1)).toString(),
      };
    }).filter(Boolean);

    const genericBallot = {
      avg:   gbAvg || existingData?.genericBallot?.avg || null,
      polls: gbArr.length ? gbArr : (existingData?.genericBallot?.polls || []),
    };

    // ── Trump approval (2026, non-partisan only) ──────────────────────────────
    const trumpPolls = all
      .filter(p => p.poll_type === 'approval' && p.subject === 'Donald Trump' && p.end_date >= '2026-01-01' && !p.partisan)
      .sort((a, b) => new Date(b.end_date) - new Date(a.end_date));

    console.log(`  Trump approval (2026): ${trumpPolls.length} polls`);

    let trumpApproval = existingData?.trumpApproval || {};
    if (trumpPolls.length) {
      const recent = trumpPolls.slice(0, 5);
      let appSum = 0, disSum = 0, count = 0;
      recent.forEach(p => {
        const app = p.answers.find(a => a.choice === 'Approve')?.pct;
        const dis = p.answers.find(a => a.choice === 'Disapprove')?.pct;
        if (app != null && dis != null) { appSum += app; disSum += dis; count++; }
      });
      if (count) {
        const approve    = +(appSum / count).toFixed(1);
        const disapprove = +(disSum / count).toFixed(1);
        trumpApproval    = { approve, disapprove, net: +(approve - disapprove).toFixed(1) };
      }
    }

    return { senatePolls, genericBallot, trumpApproval };

  } catch (e) {
    console.error('  VoteHub error:', e.message);
    return null;
  }
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n=== Midtrack Fetch — ${TODAY} ===\n`);

  let existingData = {};
  try { existingData = JSON.parse(readFileSync('data/data.json', 'utf8')); }
  catch { console.log('  No existing data.json'); }

 const [polymarket, vhResult, kalshiResult] = await Promise.all([
  fetchPolymarket(),
  fetchVoteHub(existingData),
  fetchKalshi(),
  ]);

  const todayEntry = {
    date:       TODAY,
    fetchedAt:  new Date().toISOString(),
    markets: {
      polymarket,
      kalshi: kalshiResult || existingData?.markets?.kalshi || { houseD: null, senateR: null },
    },
    genericBallot:  vhResult?.genericBallot  || existingData?.genericBallot  || { polls: [], avg: null },
    senatePolls:    vhResult?.senatePolls     || existingData?.senatePolls    || {},
    senateRatings:  existingData?.senateRatings  || {},
    trumpApproval:  vhResult?.trumpApproval   || existingData?.trumpApproval  || {},
    nateApproval:   existingData?.nateApproval   || [],
  };

  mkdirSync('data', { recursive: true });
  writeFileSync('data/data.json', JSON.stringify({ lastUpdated: TODAY, ...todayEntry }, null, 2));
  console.log('\n✅ data.json written');

  let history = [];
  try { history = JSON.parse(readFileSync('data/history.json', 'utf8')); }
  catch { console.log('  Starting fresh history'); }

  const snapshot = {
    date:          TODAY,
    markets:       todayEntry.markets,
    genericBallot: todayEntry.genericBallot,
    senatePolls:   todayEntry.senatePolls,
    trumpApproval: todayEntry.trumpApproval,
  };
  const idx = history.findIndex(e => e.date === TODAY);
  if (idx >= 0) history[idx] = snapshot;
  else history.push(snapshot);

  writeFileSync('data/history.json', JSON.stringify(history, null, 2));
  console.log('✅ history.json updated');

  console.log(`\n=== Summary — ${history.length} days tracked ===`);
  console.log(`Polymarket — House D: ${polymarket.houseD}% / Senate R: ${polymarket.senateR}%`);
  if (vhResult) {
    Object.entries(vhResult.senatePolls).forEach(([s, d]) => {
      if (d.avg) console.log(`${s}: ${d.avg.margin} (${d.polls.length} polls)`);
    });
    console.log(`Generic ballot: ${vhResult.genericBallot.avg?.margin || 'n/a'}`);
    console.log(`Trump approval: ${vhResult.trumpApproval?.approve}% / ${vhResult.trumpApproval?.disapprove}%`);
  }
}

main().catch(err => { console.error('Fatal error:', err); process.exit(1); });
