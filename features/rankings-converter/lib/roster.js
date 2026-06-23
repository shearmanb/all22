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

let cache = null;     // { index, byKey } — fuzzy name index over the roster
let cacheAt = 0;
let inflight = null;

// Turn Sleeper's id-keyed object into a de-duped list of {name, position, team}.
// When two players share a name, prefer the active, skill-position one.
function buildList(data) {
  const byKey = new Map();
  for (const id in data) {
    const p = data[id];
    if (!p) continue;
    const name = p.full_name || [p.first_name, p.last_name].filter(Boolean).join(' ');
    if (!name) continue;
    const k = players.key(name);
    if (!k) continue;
    let position = (p.position || '').toUpperCase();
    if (position === 'DEF') position = 'DST';
    const candidate = {
      name,
      position,
      team: (p.team || '').toUpperCase(),
      active: !!p.active,
      skill: SKILL.has(position),
    };
    const existing = byKey.get(k);
    if (!existing) { byKey.set(k, candidate); continue; }
    const better =
      (candidate.active && !existing.active) ||
      (candidate.active === existing.active && candidate.skill && !existing.skill);
    if (better) byKey.set(k, candidate);
  }
  return Array.from(byKey.values());
}

// Build the fuzzy name index from the roster list (kept separate so it's testable
// without the network).
function buildMap(data) {
  return players.buildNameIndex(buildList(data));
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
      .catch((err) => { inflight = null; console.error(`roster: ${err.message}`); return cache || players.buildNameIndex([]); });
  }
  return inflight;
}

// Match each player to the roster by name (tolerant of OCR noise / variants) and
// fill in what's missing. On a confident match we also correct the NAME to the
// canonical roster spelling — that's what fixes "].K. Dobbins" -> "J.K. Dobbins",
// "TylerAllgeier" -> "Tyler Allgeier", etc. Team/position only fill blanks, so a
// value OCR did read is kept. Returns the number of players matched.
async function enrich(list) {
  let index;
  try { index = await getMap(); } catch (e) { return 0; }
  if (!index || !index.byKey || !index.byKey.size) return 0;
  let matched = 0;
  for (const p of list) {
    // Team defenses are already resolved by the parser; don't rename them.
    if (p.position === 'DST') continue;
    const hit = players.findName(p.name, index);
    if (!hit) continue;
    if (hit.name) p.name = hit.name; // canonical spelling — also fixes OCR-garbled names
    if (!p.position && hit.position) p.position = hit.position;
    if (!p.team && hit.team) p.team = hit.team;
    matched += 1;
  }
  return matched;
}

module.exports = { enrich, getMap, buildMap };
