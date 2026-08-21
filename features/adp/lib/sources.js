// sources.js — Edge Rush's ADP feeds. Two free, no-auth JSON sources:
//
//   FFC     FantasyFootballCalculator's documented free API
//           (https://help.fantasyfootballcalculator.com/article/42-adp-rest-api).
//           Real mock-draft ADP per scoring format AND league size, with the
//           pick distribution (high/low/stdev/times drafted) War Room's
//           "% still available" math will need. Updates once daily — the
//           collector runs at most daily to match (their stated etiquette).
//           Free for personal use with attribution (shown on the page).
//
//   ESPN    the public read API behind ESPN's own draft tools. Carries the
//           ADP their drafts actually produce (ownership.averageDraftPosition)
//           plus ESPN's PPR/standard draft ranks and auction values. It is
//           UNDOCUMENTED, so the parser shape-checks hard and throws a plain
//           message rather than inventing a board — a silently wrong ADP on
//           draft day is worse than no ADP. Sitewide, not per league size, so
//           it stores as teams = 0 like Sleeper. Confirm the first real pull
//           on Railway (see docs/INTEGRATIONS.md).
//
//   Sleeper the projections endpoint of the same free API family that already
//           seeds players_master. Carries draft-room ADP for every format in
//           one call, keyed by the SAME sleeper_id players_master stores — so
//           joins are exact, no name matching. Undocumented (shape-checked
//           loudly), sitewide (not per league size → stored as teams = 0).
//
// Parsing is pure (JSON in → normalized rows out) and golden-tested; fetching
// wraps it with a timeout and a real User-Agent.

const FETCH_TIMEOUT_MS = 20000;
const USER_AGENT = 'Mozilla/5.0 (compatible; All22/1.0; personal fantasy tool)';

// The app's scoring vocabulary (CLAUDE.md) -> FFC's URL segment. Superflex
// drafts are what FFC calls 2QB — closest published proxy.
const FFC_FORMATS = {
  standard: 'standard',
  ppr: 'ppr',
  half: 'half-ppr',
  superflex: '2qb',
};

// FFC only runs mocks at these league sizes; clamp to the nearest.
const FFC_TEAMS = [8, 10, 12, 14];

function clampTeams(teams) {
  const t = Number(teams) || 12;
  let best = FFC_TEAMS[0];
  for (const size of FFC_TEAMS) {
    if (Math.abs(size - t) < Math.abs(best - t)) best = size;
  }
  return best;
}

// The human-facing FFC ADP page for a board (the "View source ↗" link). FFC's
// public pages live at /adp/<segment>/<n>-team; falls back to the ADP landing
// for a format FFC doesn't segment.
function ffcPageUrl(format, teams) {
  const segment = FFC_FORMATS[format];
  if (!segment) return 'https://fantasyfootballcalculator.com/adp';
  const t = clampTeams(teams);
  return `https://fantasyfootballcalculator.com/adp/${segment}/${t}-team/all`;
}

// Fantasy season year: Jan/Feb still belong to the previous season's drafts.
function seasonYear(now = new Date()) {
  return now.getUTCMonth() >= 2 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
}

function toNum(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// FFC JSON -> { meta, rows }. Throws a human-readable error on shape drift so
// the failure is visible (data health), never a silent empty snapshot.
function parseFfc(json) {
  if (!json || !Array.isArray(json.players)) {
    throw new Error('FFC response had no players list (their API may have changed).');
  }
  const rows = json.players
    .filter((p) => p && p.name && toNum(p.adp) !== null)
    .map((p) => ({
      name: String(p.name),
      position: String(p.position || '').toUpperCase().replace('DEF', 'DST'),
      team: String(p.team || '').toUpperCase(),
      bye: toNum(p.bye),
      adp: toNum(p.adp),
      high: toNum(p.high),
      low: toNum(p.low),
      stdev: toNum(p.stdev),
      times_drafted: toNum(p.times_drafted),
    }));
  const meta = json.meta || {};
  return {
    rows,
    meta: {
      total_drafts: toNum(meta.total_drafts),
      start_date: meta.start_date || null,
      end_date: meta.end_date || null,
    },
  };
}

async function fetchFfc({ format, teams, year }) {
  const segment = FFC_FORMATS[format];
  if (!segment) throw new Error(`FFC has no ${format} ADP feed.`);
  const t = clampTeams(teams);
  const y = year || seasonYear();
  const url = `https://fantasyfootballcalculator.com/api/v1/adp/${segment}?teams=${t}&year=${y}`;
  const res = await fetch(url, {
    headers: { accept: 'application/json', 'user-agent': USER_AGENT },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`FFC responded ${res.status} for ${segment}/${t}-team`);
  const parsed = parseFfc(await res.json());
  return Object.assign(parsed, { url, teams: t, year: y });
}

// Sleeper stat key -> the app's scoring vocabulary.
const SLEEPER_ADP_KEYS = {
  adp_std: 'standard',
  adp_ppr: 'ppr',
  adp_half_ppr: 'half',
  adp_2qb: 'superflex',
};

// Sleeper projections JSON (array, or object keyed by player id) ->
// [{ sleeper_id, name, position, team, adps: {standard, ppr, half, superflex} }]
// 999 is Sleeper's "undrafted" sentinel; those simply aren't votes.
function parseSleeper(json) {
  const items = Array.isArray(json) ? json : (json && typeof json === 'object' ? Object.values(json) : null);
  if (!items) throw new Error('Sleeper projections response had an unexpected shape.');
  const rows = [];
  for (const item of items) {
    if (!item || !item.stats) continue;
    const adps = {};
    let any = false;
    for (const [key, fmt] of Object.entries(SLEEPER_ADP_KEYS)) {
      const v = toNum(item.stats[key]);
      if (v !== null && v > 0 && v < 999) { adps[fmt] = v; any = true; }
    }
    if (!any) continue;
    const p = item.player || {};
    const name = [p.first_name, p.last_name].filter(Boolean).join(' ');
    if (!name) continue;
    let position = String(p.position || '').toUpperCase();
    if (position === 'DEF') position = 'DST';
    rows.push({
      sleeper_id: String(item.player_id || ''),
      name,
      position,
      team: String(item.team || p.team || '').toUpperCase(),
      adps,
    });
  }
  if (!rows.length) throw new Error('Sleeper projections carried no ADP values (their API may have changed).');
  return rows;
}

async function fetchSleeper({ year } = {}) {
  const y = year || seasonYear();
  const positions = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF']
    .map((p) => `position[]=${p}`).join('&');
  const url = `https://api.sleeper.app/projections/nfl/${y}?season_type=regular&${positions}&order_by=adp_half_ppr`;
  const res = await fetch(url, {
    headers: { accept: 'application/json', 'user-agent': USER_AGENT },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Sleeper responded ${res.status} for ${y} projections`);
  const rows = parseSleeper(await res.json());
  return { rows, url, year: y };
}

// ---------------------------------------------------------------------------
// ESPN
// ---------------------------------------------------------------------------

// ESPN identifies positions and teams by number. Both maps are stable and
// long-lived; an id outside them yields '' rather than a wrong guess.
const ESPN_POSITIONS = { 1: 'QB', 2: 'RB', 3: 'WR', 4: 'TE', 5: 'K', 16: 'DST' };
const ESPN_TEAMS = {
  1: 'ATL', 2: 'BUF', 3: 'CHI', 4: 'CIN', 5: 'CLE', 6: 'DAL', 7: 'DEN', 8: 'DET',
  9: 'GB', 10: 'TEN', 11: 'IND', 12: 'KC', 13: 'LV', 14: 'LAR', 15: 'MIA',
  16: 'MIN', 17: 'NE', 18: 'NO', 19: 'NYG', 20: 'NYJ', 21: 'PHI', 22: 'ARI',
  23: 'PIT', 24: 'LAC', 25: 'SF', 26: 'SEA', 27: 'TB', 28: 'WAS', 29: 'CAR',
  30: 'JAX', 33: 'BAL', 34: 'HOU',
};

// ESPN publishes draft ranks for PPR and STANDARD only — no half-PPR. Half and
// superflex borrow PPR, which is the closer of the two; the board is labelled
// with the site so the owner knows whose numbers these are.
const ESPN_RANK_TYPES = { ppr: 'PPR', standard: 'STANDARD', half: 'PPR', superflex: 'PPR' };

function espnRankType(format) {
  return ESPN_RANK_TYPES[String(format || '').toLowerCase()] || 'PPR';
}

// The human-facing ESPN ADP page (the "View source ↗" link).
function espnPageUrl() {
  return 'https://fantasy.espn.com/football/livedraftresults';
}

// ESPN player JSON -> normalized rows. Pure, so the shape is golden-tested
// without touching the network.
//
// Two numbers matter and they are NOT the same thing:
//   ownership.averageDraftPosition  where he actually goes in ESPN drafts (ADP)
//   draftRanksByRankType[T].rank    where ESPN's own board says he should go
// We use the former as the ADP and keep the latter only as a fallback, because
// a projected rank is not a draft result.
function parseEspn(json, { format } = {}) {
  const players = json && Array.isArray(json.players) ? json.players : null;
  if (!players) {
    throw new Error('ESPN response had no players array — their API shape may have changed.');
  }
  const rankType = espnRankType(format);
  const rows = [];
  for (const item of players) {
    const p = (item && item.player) || null;
    if (!p) continue;
    const name = String(p.fullName || '').trim();
    if (!name) continue;

    const ranks = p.draftRanksByRankType || {};
    const entry = ranks[rankType] || {};
    const own = p.ownership || {};
    // ESPN uses 0 (and sometimes negative) to mean "undrafted / no data".
    let adp = toNum(own.averageDraftPosition);
    if (adp === null || adp <= 0) adp = toNum(entry.rank);
    if (adp === null || adp <= 0) continue;

    rows.push({
      espn_id: String(p.id || (item && item.id) || ''),
      name,
      position: ESPN_POSITIONS[p.defaultPositionId] || '',
      team: ESPN_TEAMS[p.proTeamId] || '',
      adp,
      auction_value: toNum(entry.auctionValue),
    });
  }
  if (!rows.length) {
    throw new Error('ESPN returned players but no draft positions — their API shape may have changed.');
  }
  rows.sort((a, b) => a.adp - b.adp);
  return rows;
}

async function fetchEspn({ year, format, limit = 400 } = {}) {
  const y = year || seasonYear();
  const rankType = espnRankType(format);
  // leaguedefaults/3 is ESPN's PPR default league; the rank type inside the
  // filter is what actually selects the scoring, so this is stable for both.
  const url = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${y}` +
    '/segments/0/leaguedefaults/3?view=kona_player_info';
  const filter = {
    players: {
      limit,
      sortDraftRanks: { sortPriority: 100, sortAsc: true, value: rankType },
    },
  };
  let res;
  try {
    res = await fetch(url, {
      headers: {
        'x-fantasy-filter': JSON.stringify(filter),
        accept: 'application/json',
        'user-agent': USER_AGENT,
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    throw new Error(timedOut
      ? `ESPN did not answer within ${Math.round(FETCH_TIMEOUT_MS / 1000)}s`
      : `Could not reach ESPN (${err && err.message ? err.message : 'network error'})`);
  }
  if (!res.ok) {
    throw new Error(`ESPN ADP request failed (HTTP ${res.status}). They may be blocking this server.`);
  }
  let json;
  try {
    json = await res.json();
  } catch (err) {
    throw new Error('ESPN returned something that was not JSON (they may be serving a block page).');
  }
  return { rows: parseEspn(json, { format }), year: y, url, rankType };
}

module.exports = {
  FFC_FORMATS,
  FFC_TEAMS,
  SLEEPER_ADP_KEYS,
  clampTeams,
  ffcPageUrl,
  seasonYear,
  ESPN_POSITIONS,
  ESPN_TEAMS,
  ESPN_RANK_TYPES,
  espnRankType,
  espnPageUrl,
  parseFfc,
  parseSleeper,
  parseEspn,
  fetchFfc,
  fetchSleeper,
  fetchEspn,
};
