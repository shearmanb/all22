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

module.exports = {
  FFC_FORMATS,
  FFC_TEAMS,
  SLEEPER_ADP_KEYS,
  clampTeams,
  ffcPageUrl,
  seasonYear,
  parseFfc,
  parseSleeper,
  fetchFfc,
  fetchSleeper,
};
