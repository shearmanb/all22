// Resolve draft picks to players_master ids through the one canonical
// matching stack (lib/players → players_master index → combine's matchRow,
// which carries the position-mismatch identity guard). Identity rule
// (CLAUDE.md): only 'high'-confidence matches get a player_id — anything
// fuzzier keeps NULL and shows as unmatched on the draft page.
const pool = require('../../../db/pool');
const master = require('../../../lib/players-master');
const ingest = require('../../combine/lib/ingest');

// Match one pick's raw fields. Accepts either API-shape (playerName/nflTeam)
// or DB-shape (player_name/nfl_team) picks.
function matchPick(p, index) {
  const m = ingest.matchRow({
    name: p.playerName != null ? p.playerName : p.player_name,
    position: p.position,
    team: p.nflTeam != null ? p.nflTeam : p.nfl_team,
  }, index);
  const ok = m.player_id && m.confidence === 'high';
  return {
    player_id: ok ? m.player_id : null,
    confidence: m.confidence,
    via: m.via || null,
  };
}

async function matchPicks(picks) {
  const index = await master.getIndex();
  return picks.map((p) => matchPick(p, index));
}

// Re-resolve a saved draft's picks in place. By default only touches picks
// never attempted (match_confidence IS NULL) — the lazy backfill for
// pre-rebuild drafts; force = true re-runs everything so learned aliases and
// manually-added players heal old drafts too.
async function resolveDraftPicks(draftId, { force = false } = {}) {
  const { rows: picks } = await pool.query(
    `SELECT id, player_name, position, nfl_team, match_confidence
     FROM picks WHERE draft_id = $1 ${force ? '' : 'AND match_confidence IS NULL'}`,
    [draftId]
  );
  if (!picks.length) return { attempted: 0, matched: 0 };
  const index = await master.getIndex();
  let matched = 0;
  for (const p of picks) {
    const m = matchPick(p, index);
    if (m.player_id) matched++;
    await pool.query(
      'UPDATE picks SET player_id = $1, match_confidence = $2, match_via = $3 WHERE id = $4',
      [m.player_id, m.confidence, m.via, p.id]
    );
  }
  return { attempted: picks.length, matched };
}

module.exports = { matchPick, matchPicks, resolveDraftPicks };
