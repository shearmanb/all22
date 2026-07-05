// lib/players-master.js — the players_master service: the canonical player
// registry every dataset joins to (PRD's linchpin). Rankings, ADP and draft
// picks all resolve incoming names to a player_id through here.
//
// Data flow:
//   - Seeded and refreshed from Sleeper's free public player list (the same
//     source the old converter proved out). Refresh is at most daily; a failed
//     fetch just keeps the current rows — players_master IS the fallback.
//   - Rows the owner adds by hand (review queue "add new player") get
//     source 'manual'; a later Sleeper sync may update their team/position by
//     name_key but never deletes them.
//   - The 32 team defenses are upserted explicitly so DST rows always resolve
//     even when Sleeper's DEF entries are odd.
//
// Matching goes through lib/players.js (the one canonical matcher) with the
// shared alias map from lib/aliases.js, extended at runtime with:
//   - learned aliases from the legacy converter_aliases table (kept: real data)
//   - per-site aliases stored on players_master.aliases (the PRD shape; where
//     NEW learned aliases go — see learnAlias()).
const players = require('./players');
const aliases = require('./aliases');
const pool = require('../db/pool');

const SLEEPER_URL = 'https://api.sleeper.app/v1/players/nfl';
const FETCH_TIMEOUT_MS = 15000;
const SYNC_TTL_MS = 24 * 60 * 60 * 1000;   // refresh at most daily
const INDEX_TTL_MS = 10 * 60 * 1000;       // rebuild the in-memory index at most every 10m
const SKILL = new Set(['QB', 'RB', 'WR', 'TE', 'K']);

const hasDb = () => Boolean(process.env.DATABASE_URL);

// ---------------------------------------------------------------------------
// Sleeper list -> de-duped [{name, key, position, team, active}] (pure; tested).
// When two players share a name key, prefer the active, skill-position one.
// ---------------------------------------------------------------------------
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
      key: k,
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

// ---------------------------------------------------------------------------
// Sync: Sleeper -> players_master (one upsert statement), plus the 32 DSTs.
// ---------------------------------------------------------------------------
let syncInflight = null;

async function sync() {
  if (!hasDb()) throw new Error('players_master needs a database (DATABASE_URL is not set)');
  if (syncInflight) return syncInflight;
  syncInflight = (async () => {
    const res = await fetch(SLEEPER_URL, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`sleeper responded ${res.status}`);
    const list = buildList(await res.json());
    if (!list.length) throw new Error('sleeper returned an empty player list');
    await pool.query(
      `INSERT INTO players_master (name, name_key, position, team, active, source)
       SELECT p->>'name', p->>'key', COALESCE(p->>'position',''), COALESCE(p->>'team',''),
              (p->>'active')::boolean, 'sleeper'
       FROM jsonb_array_elements($1::jsonb) p
       ON CONFLICT (name_key) DO UPDATE
         SET name = EXCLUDED.name,
             position = EXCLUDED.position,
             team = EXCLUDED.team,
             active = EXCLUDED.active,
             updated_at = now()`,
      [JSON.stringify(list)]
    );
    await ensureDefenses();
    await pool.query(
      `INSERT INTO settings (key, value, updated_at) VALUES ('players_master.synced_at', to_jsonb(now()::text), now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`
    );
    invalidateIndex();
    return list.length;
  })().finally(() => { syncInflight = null; });
  return syncInflight;
}

// The 32 team defenses, from the canonical team table in lib/players.js.
async function ensureDefenses() {
  const rows = Object.keys(players.TEAM_NAMES).map((abbr) => {
    const name = players.teamDefenseName(abbr);
    return { name, key: players.key(name), position: 'DST', team: abbr, active: true };
  });
  await pool.query(
    `INSERT INTO players_master (name, name_key, position, team, active, source)
     SELECT p->>'name', p->>'key', 'DST', p->>'team', true, 'sleeper'
     FROM jsonb_array_elements($1::jsonb) p
     ON CONFLICT (name_key) DO UPDATE
       SET position = 'DST', team = EXCLUDED.team, active = true, updated_at = now()`,
    [JSON.stringify(rows)]
  );
}

// Last successful sync time (ISO string) or null.
async function syncedAt() {
  try {
    const { rows } = await pool.query(`SELECT value FROM settings WHERE key = 'players_master.synced_at'`);
    return rows.length ? String(rows[0].value).replace(/^"|"$/g, '') : null;
  } catch (e) { return null; }
}

// Boot hook: seed an empty players_master immediately, otherwise refresh in the
// background when stale. Never throws — the app must boot without Sleeper.
async function ensureSeeded() {
  if (!hasDb()) return;
  try {
    const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM players_master');
    const empty = !rows[0].n;
    const last = await syncedAt();
    const stale = !last || (Date.now() - new Date(last).getTime() > SYNC_TTL_MS);
    if (empty || stale) {
      await sync();
      console.log('players_master: synced from Sleeper');
    }
  } catch (err) {
    console.error(`players_master: seed/refresh failed: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// The in-memory match index (players.buildNameIndex over the master rows),
// wired to the shared alias map. Cached briefly; invalidated on writes.
// ---------------------------------------------------------------------------
let indexCache = null;
let indexAt = 0;
let indexInflight = null;

function invalidateIndex() { indexCache = null; indexAt = 0; }

async function loadAliasMap() {
  // Curated seed + legacy learned aliases + per-site aliases on master rows,
  // rebuilt IN PLACE so indexes holding the map by reference stay current.
  const learned = [];
  try {
    const { rows } = await pool.query('SELECT alias, canonical FROM converter_aliases');
    learned.push(...rows);
  } catch (e) { /* legacy table may be missing in a fresh DB — fine */ }
  try {
    const { rows } = await pool.query(
      `SELECT name, aliases FROM players_master WHERE aliases <> '{}'::jsonb`
    );
    for (const r of rows) {
      for (const list of Object.values(r.aliases || {})) {
        for (const variant of (Array.isArray(list) ? list : [])) {
          learned.push({ alias: variant, canonical: r.name });
        }
      }
    }
  } catch (e) { console.error(`players_master: alias load failed: ${e.message}`); }
  aliases.reload(learned);
}

async function getIndex() {
  if (indexCache && Date.now() - indexAt < INDEX_TTL_MS) return indexCache;
  if (!indexInflight) {
    indexInflight = (async () => {
      if (!hasDb()) return players.buildNameIndex([], { aliases: aliases.MAP });
      await loadAliasMap();
      const { rows } = await pool.query(
        'SELECT player_id, name, position, team, active FROM players_master'
      );
      const index = players.buildNameIndex(rows, { aliases: aliases.MAP });
      indexCache = index;
      indexAt = Date.now();
      return index;
    })().catch((err) => {
      console.error(`players_master: index build failed: ${err.message}`);
      return indexCache || players.buildNameIndex([], { aliases: aliases.MAP });
    }).finally(() => { indexInflight = null; });
  }
  return indexInflight;
}

// Match one raw name. Returns { player: row|null, confidence, via }.
async function match(rawName) {
  const index = await getIndex();
  const m = players.findNameDetailed(rawName, index);
  return { player: m.entry || null, confidence: m.confidence, via: m.via };
}

// ---------------------------------------------------------------------------
// Writes used by the review queue.
// ---------------------------------------------------------------------------

// Owner adds a player the roster doesn't know (rookie, name quirk, DST oddity).
// Upserts by name_key so a re-add just returns the existing row.
async function addManual({ name, position = '', team = '' }) {
  const display = players.display(name);
  const k = players.key(display);
  if (!k) throw new Error('That player name is empty after cleanup.');
  const { rows } = await pool.query(
    `INSERT INTO players_master (name, name_key, position, team, active, source)
     VALUES ($1, $2, $3, $4, true, 'manual')
     ON CONFLICT (name_key) DO UPDATE
       SET position = CASE WHEN players_master.position = '' THEN EXCLUDED.position ELSE players_master.position END,
           team     = CASE WHEN players_master.team = ''     THEN EXCLUDED.team     ELSE players_master.team END,
           updated_at = now()
     RETURNING player_id, name, position, team`,
    [display, k, (position || '').toUpperCase(), (team || '').toUpperCase()]
  );
  invalidateIndex();
  return rows[0];
}

// Remember that `variant` (as written by `site`) means this player. Stored in
// the PRD shape — players_master.aliases[site] — and merged into the live map.
async function learnAlias(playerId, variant, site) {
  const cleanVariant = players.display(variant);
  if (!cleanVariant) return null;
  const siteKey = (site || 'common').toLowerCase().replace(/[^a-z0-9_-]+/g, '-') || 'common';
  const { rows } = await pool.query(
    'SELECT name, aliases FROM players_master WHERE player_id = $1', [playerId]
  );
  if (!rows.length) throw new Error('Player not found.');
  const { name, aliases: current } = rows[0];
  // A self-referential alias teaches nothing.
  if (players.key(cleanVariant) === players.key(name)) return { name, aliases: current };
  const next = Object.assign({}, current);
  const list = Array.isArray(next[siteKey]) ? next[siteKey].slice() : [];
  if (!list.some((v) => players.key(v) === players.key(cleanVariant))) list.push(cleanVariant);
  next[siteKey] = list;
  await pool.query(
    'UPDATE players_master SET aliases = $2, updated_at = now() WHERE player_id = $1',
    [playerId, JSON.stringify(next)]
  );
  aliases.addLearned([{ alias: cleanVariant, canonical: name }]);
  return { name, aliases: next };
}

// Autocomplete for the review queue's "this is actually…" picker.
async function search(q, limit = 20) {
  const k = players.key(q || '');
  if (!k) return [];
  const { rows } = await pool.query(
    `SELECT player_id, name, position, team, active
     FROM players_master
     WHERE name_key LIKE $1 OR name_key LIKE $2 OR name ILIKE $3
     ORDER BY active DESC,
              (position IN ('QB','RB','WR','TE','K','DST')) DESC,
              length(name_key) ASC
     LIMIT $4`,
    [k + '%', '% ' + k + '%', '%' + q.trim() + '%', limit]
  );
  return rows;
}

async function status() {
  const out = { count: 0, active: 0, synced_at: null };
  try {
    const { rows } = await pool.query(
      'SELECT COUNT(*)::int AS n, COUNT(*) FILTER (WHERE active)::int AS a FROM players_master'
    );
    out.count = rows[0].n;
    out.active = rows[0].a;
    out.synced_at = await syncedAt();
  } catch (e) { /* no DB — zeros */ }
  return out;
}

module.exports = {
  buildList,
  sync,
  ensureSeeded,
  getIndex,
  invalidateIndex,
  match,
  addManual,
  learnAlias,
  search,
  status,
  syncedAt,
};
