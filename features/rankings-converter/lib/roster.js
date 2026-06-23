// lib/roster.js — fill in each player's position and current NFL team by looking
// them up by name, so OCR only has to read the NAME correctly (the team/bye
// codes are tiny and unreliable, but the name is long and redundant).
//
// Source: Sleeper's free public player list (no API key). It's a big (~5MB) JSON
// object of every NFL player with full_name, team and position. We fetch it once
// and cache it in memory for a day. If it can't be fetched, every lookup simply
// returns nothing and the converter keeps working (manual editing + fix queue).
//
// All name matching goes through lib/players.js key() — the canonical module —
// so "Patrick Mahomes II", "A.J. Brown", etc. match regardless of punctuation.
const players = require('../../../lib/players');

const SLEEPER_URL = 'https://api.sleeper.app/v1/players/nfl';
const TTL_MS = 24 * 60 * 60 * 1000;       // refresh at most once a day
const SKILL = new Set(['QB', 'RB', 'WR', 'TE', 'K']);

let cache = null;     // Map(nameKey -> { position, team, name, active, skill })
let cacheAt = 0;
let inflight = null;

// Turn Sleeper's id-keyed object into a name-keyed Map. When two players share a
// name, prefer the active, skill-position one (the fantasy-relevant match).
function buildMap(data) {
  const map = new Map();
  for (const id in data) {
    const p = data[id];
    if (!p) continue;
    const name = p.full_name || [p.first_name, p.last_name].filter(Boolean).join(' ');
    if (!name) continue;
    const key = players.key(name);
    if (!key) continue;
    let position = (p.position || '').toUpperCase();
    if (position === 'DEF') position = 'DST';
    const candidate = {
      position,
      team: (p.team || '').toUpperCase(),
      name,
      active: !!p.active,
      skill: SKILL.has(position),
    };
    const existing = map.get(key);
    if (!existing) { map.set(key, candidate); continue; }
    const better =
      (candidate.active && !existing.active) ||
      (candidate.active === existing.active && candidate.skill && !existing.skill);
    if (better) map.set(key, candidate);
  }
  return map;
}

async function fetchRoster() {
  const res = await fetch(SLEEPER_URL, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`sleeper responded ${res.status}`);
  return buildMap(await res.json());
}

// Cached, de-duped accessor. Returns the current map (possibly empty/stale) and
// never throws — a fetch failure logs and falls back to whatever we have.
async function getMap() {
  if (cache && Date.now() - cacheAt < TTL_MS) return cache;
  if (!inflight) {
    inflight = fetchRoster()
      .then((map) => { cache = map; cacheAt = Date.now(); inflight = null; return map; })
      .catch((err) => { inflight = null; console.error(`roster: ${err.message}`); return cache || new Map(); });
  }
  return inflight;
}

// Fill position/team from the roster wherever the parser left them blank.
// Returns the number of players we matched (for a "filled N from NFL rosters"
// note). Existing OCR values are kept — the roster only fills gaps.
async function enrich(list) {
  let map;
  try { map = await getMap(); } catch (e) { return 0; }
  if (!map || !map.size) return 0;
  let matched = 0;
  for (const p of list) {
    const hit = map.get(players.key(p.name));
    if (!hit) continue;
    let touched = false;
    if (!p.position && hit.position) { p.position = hit.position; touched = true; }
    if (!p.team && hit.team) { p.team = hit.team; touched = true; }
    if (touched) matched += 1;
  }
  return matched;
}

module.exports = { enrich, getMap, buildMap };
