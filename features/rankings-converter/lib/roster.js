// lib/roster.js — fill in each player's position and current NFL team by looking
// them up by name, so OCR only has to read the NAME correctly (the team/bye
// codes are tiny and unreliable, but the name is long and redundant).
//
// Source: Sleeper's free public player list (no API key). It's a big (~5MB) JSON
// object of every NFL player with full_name, team and position. We fetch it once
// and cache it in memory for a day, and ALSO persist the de-duped list to Postgres
// (roster_cache) so a cold start or a Sleeper outage falls back to the last good
// roster instead of going blank. If we have nothing at all, every lookup simply
// returns nothing and the converter keeps working (manual editing + fix queue).
//
// All name matching goes through lib/players.js — the canonical module — plus the
// alias map in lib/aliases.js, so "Patrick Mahomes II", "A.J. Brown",
// "Hollywood Brown", etc. resolve regardless of punctuation, suffix or nickname.
const players = require('../../../lib/players');
const aliases = require('../../../lib/aliases');
const pool = require('../../../db/pool');

const SLEEPER_URL = 'https://api.sleeper.app/v1/players/nfl';
const TTL_MS = 24 * 60 * 60 * 1000;       // refresh at most once a day
const FETCH_TIMEOUT_MS = 15000;           // don't hang forever on a slow Sleeper
const SKILL = new Set(['QB', 'RB', 'WR', 'TE', 'K']);

const hasDb = () => Boolean(process.env.DATABASE_URL);

let cache = null;     // built name index over the roster
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

// Build the fuzzy name index from a roster list, wired to the shared alias map.
function buildIndex(list) {
  return players.buildNameIndex(list, { aliases: aliases.MAP });
}

// Back-compat: build the index straight from Sleeper's raw object (used by tests).
function buildMap(data) {
  return buildIndex(buildList(data));
}

// Persist the latest good roster list so a cold start / outage can fall back to it.
async function persist(list) {
  if (!hasDb() || !list || !list.length) return;
  try {
    await pool.query(
      `INSERT INTO roster_cache (id, players, fetched_at) VALUES (1, $1, now())
       ON CONFLICT (id) DO UPDATE SET players = EXCLUDED.players, fetched_at = now()`,
      [JSON.stringify(list)]
    );
  } catch (err) {
    console.error(`roster: persist failed: ${err.message}`);
  }
}

// Load the last persisted roster list (or null) — the offline/outage fallback.
async function loadPersisted() {
  if (!hasDb()) return null;
  try {
    const { rows } = await pool.query('SELECT players FROM roster_cache WHERE id = 1');
    if (rows.length && Array.isArray(rows[0].players) && rows[0].players.length) {
      return rows[0].players;
    }
  } catch (err) {
    console.error(`roster: load cache failed: ${err.message}`);
  }
  return null;
}

async function fetchRoster() {
  const res = await fetch(SLEEPER_URL, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`sleeper responded ${res.status}`);
  const list = buildList(await res.json());
  await persist(list);              // keep the DB fallback fresh
  return buildIndex(list);
}

// Cached, de-duped accessor. Returns the current index (possibly empty) and never
// throws: a fetch failure logs and falls back to the in-memory cache, then the
// persisted roster, then an empty index.
async function getMap() {
  if (cache && Date.now() - cacheAt < TTL_MS) return cache;
  if (!inflight) {
    inflight = fetchRoster()
      .then((map) => { cache = map; cacheAt = Date.now(); inflight = null; return map; })
      .catch(async (err) => {
        inflight = null;
        console.error(`roster: ${err.message}`);
        if (cache) return cache;                       // stale in-memory is fine
        const persisted = await loadPersisted();       // last good DB snapshot
        if (persisted) { cache = buildIndex(persisted); cacheAt = Date.now(); return cache; }
        return buildIndex([]);                          // empty, but never throws
      });
  }
  return inflight;
}

// Match each player to the roster by name (tolerant of OCR noise / variants) and
// fill in what's missing. On a confident match we also correct the NAME to the
// canonical roster spelling — that's what fixes "].K. Dobbins" -> "J.K. Dobbins",
// "TylerAllgeier" -> "Tyler Allgeier", etc. Team/position only fill blanks, so a
// value OCR did read is kept. Records match confidence on each player as
// p.match = { via, confidence } so the UI can flag uncertain ones. Returns the
// number of players matched.
async function enrich(list) {
  let index;
  try { index = await getMap(); } catch (e) { return 0; }
  if (!index || !index.byKey || !index.byKey.size) return 0;
  let matched = 0;
  for (const p of list) {
    // Team defenses are already resolved by the parser; don't rename them.
    if (p.position === 'DST') { p.match = { via: 'dst', confidence: 'high' }; continue; }
    const m = players.findNameDetailed(p.name, index);
    if (!m.entry) { p.match = { via: 'none', confidence: 'none' }; continue; }
    const hit = m.entry;
    if (hit.name) p.name = hit.name; // canonical spelling — also fixes OCR-garbled names
    if (!p.position && hit.position) p.position = hit.position;
    if (!p.team && hit.team) p.team = hit.team;
    p.match = { via: m.via, confidence: m.confidence };
    matched += 1;
  }
  return matched;
}

module.exports = { enrich, getMap, buildMap, buildList };
