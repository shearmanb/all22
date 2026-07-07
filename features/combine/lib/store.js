// store.js — Combine's database layer: ranking_sets + rankings_raw +
// rankings_normalized (PRD §5). rankings_raw keeps rows exactly as captured;
// rankings_normalized exists only for rows resolved to a players_master id.
// A raw row with no normalized row IS the review queue.
const pool = require('../../../db/pool');

const FORMATS = new Set(['ppr', 'half', 'standard', 'best_ball', 'superflex', 'unknown']);

function cleanFormat(f) {
  const v = String(f || '').toLowerCase().trim();
  return FORMATS.has(v) ? v : 'unknown';
}

// What kind of list the set is (migration 017): one overall list, or
// position-by-position blocks where only rank-within-position matters.
const SCOPES = new Set(['overall', 'positional']);

function cleanScope(s) {
  const v = String(s || '').toLowerCase().trim();
  return SCOPES.has(v) ? v : 'overall';
}

// Rank within position, derived from list order. Correct for both kinds of
// sets: on an overall list "WR4" means the 4th WR on the board; on a
// positional list (blocks kept in paste order) it's the player's spot on his
// position's list. Rows with no known position yet (unmatched, nothing
// printed) get null until review resolves them.
function withPositionRanks(rows) {
  const counters = {};
  for (const row of rows) {
    const pos = row.position || '';
    if (!pos) { row.position_rank = null; continue; }
    counters[pos] = (counters[pos] || 0) + 1;
    row.position_rank = counters[pos];
  }
  return rows;
}

// Insert one matched row's raw + (when resolved) normalized records.
async function insertRow(client, setId, row) {
  const { rows } = await client.query(
    `INSERT INTO rankings_raw (set_id, rank, raw_name, raw_position, raw_team, auction_value)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [setId, row.rank, row.raw_name, row.raw_position || '', row.raw_team || '',
     (row.auction_value === undefined ? null : row.auction_value)]
  );
  const rawId = rows[0].id;
  if (row.player_id) {
    await client.query(
      `INSERT INTO rankings_normalized (raw_id, set_id, player_id, rank, confidence, matched_via, confirmed)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [rawId, setId, row.player_id, row.rank, row.confidence || 'high', row.via || '', !!row.confirmed]
    );
  }
  return rawId;
}

// Create a set with its rows in one transaction. meta: { name, source,
// native_scoring_format, ranking_scope, captured_on, notes }. rows: matched
// pipeline output.
async function createSet(meta, rows) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: setRows } = await client.query(
      `INSERT INTO ranking_sets (name, source, native_scoring_format, ranking_scope, captured_on, notes, players)
       VALUES ($1, $2, $3, $4, $5, $6, NULL)
       RETURNING id, name, source, native_scoring_format, ranking_scope, captured_on, notes, created_at, updated_at`,
      [meta.name, meta.source || null, cleanFormat(meta.native_scoring_format),
       cleanScope(meta.ranking_scope), meta.captured_on || null, meta.notes || null]
    );
    const set = setRows[0];
    for (const row of rows) await insertRow(client, set.id, row);
    await client.query('COMMIT');
    return set;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Append more rows (screenshot #2..N of the same list). Ranks continue after
// the current max; returns the first rank used.
async function appendRows(setId, rows) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: maxRows } = await client.query(
      'SELECT COALESCE(MAX(rank), 0) AS max FROM rankings_raw WHERE set_id = $1', [setId]
    );
    const start = Number(maxRows[0].max) + 1;
    let rank = start;
    for (const row of rows) {
      await insertRow(client, setId, Object.assign({}, row, { rank }));
      rank++;
    }
    await client.query("UPDATE ranking_sets SET updated_at = now() WHERE id = $1", [setId]);
    await client.query('COMMIT');
    return start;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// List sets with row/review counts, newest activity first.
async function listSets() {
  const { rows } = await pool.query(
    `SELECT s.id, s.name, s.source, s.native_scoring_format, s.ranking_scope, s.captured_on, s.notes,
            s.created_at, s.updated_at,
            COUNT(r.id)::int AS row_count,
            COUNT(r.id) FILTER (WHERE n.id IS NULL)::int AS unmatched,
            COUNT(n.id) FILTER (WHERE n.confidence <> 'high' AND NOT n.confirmed)::int AS uncertain
     FROM ranking_sets s
     LEFT JOIN rankings_raw r ON r.set_id = s.id
     LEFT JOIN rankings_normalized n ON n.raw_id = r.id
     GROUP BY s.id
     ORDER BY s.updated_at DESC NULLS LAST, s.created_at DESC`
  );
  return rows;
}

async function getSet(id) {
  const { rows } = await pool.query(
    `SELECT id, name, source, native_scoring_format, ranking_scope, captured_on, notes, created_at, updated_at
     FROM ranking_sets WHERE id = $1`, [id]
  );
  return rows[0] || null;
}

// A set's rows: raw joined to normalized joined to master. This is the one
// query every view/export reads — canonical identity when known, raw otherwise.
async function getSetRows(id) {
  const { rows } = await pool.query(
    `SELECT r.id AS raw_id, r.rank, r.raw_name, r.raw_position, r.raw_team, r.auction_value,
            n.id AS norm_id, n.player_id, n.confidence, n.matched_via, n.confirmed,
            p.name AS master_name, p.position AS master_position, p.team AS master_team
     FROM rankings_raw r
     LEFT JOIN rankings_normalized n ON n.raw_id = r.id
     LEFT JOIN players_master p ON p.player_id = n.player_id
     WHERE r.set_id = $1
     ORDER BY r.rank ASC, r.id ASC`, [id]
  );
  return withPositionRanks(rows.map((r) => ({
    raw_id: r.raw_id,
    rank: r.rank,
    raw_name: r.raw_name,
    raw_position: r.raw_position,
    raw_team: r.raw_team,
    auction_value: r.auction_value === null ? null : Number(r.auction_value),
    player_id: r.player_id,
    name: r.master_name || r.raw_name,
    position: r.master_position || r.raw_position || '',
    team: r.master_team || r.raw_team || '',
    confidence: r.player_id ? r.confidence : 'none',
    matched_via: r.matched_via || '',
    confirmed: !!r.confirmed,
  })));
}

async function updateSetMeta(id, meta) {
  const sets = ['updated_at = now()'];
  const params = [id];
  const push = (sql, val) => { params.push(val); sets.push(`${sql} = $${params.length}`); };
  if (meta.name !== undefined) push('name', String(meta.name).trim());
  if (meta.source !== undefined) push('source', meta.source ? String(meta.source).trim() : null);
  if (meta.native_scoring_format !== undefined) push('native_scoring_format', cleanFormat(meta.native_scoring_format));
  if (meta.ranking_scope !== undefined) push('ranking_scope', cleanScope(meta.ranking_scope));
  if (meta.captured_on !== undefined) push('captured_on', meta.captured_on || null);
  if (meta.notes !== undefined) push('notes', meta.notes ? String(meta.notes) : null);
  const { rows } = await pool.query(
    `UPDATE ranking_sets SET ${sets.join(', ')} WHERE id = $1
     RETURNING id, name, source, native_scoring_format, ranking_scope, captured_on, notes, created_at, updated_at`,
    params
  );
  return rows[0] || null;
}

async function deleteSet(id) {
  await pool.query('DELETE FROM ranking_sets WHERE id = $1', [id]);
}

// Write/replace one raw row's resolution. via 'owner' marks a human decision.
async function resolveRow(rawId, playerId, { confidence = 'high', via = 'owner', confirmed = true } = {}) {
  const { rows } = await pool.query(
    'SELECT set_id, rank FROM rankings_raw WHERE id = $1', [rawId]
  );
  if (!rows.length) throw new Error('That row no longer exists.');
  const { set_id, rank } = rows[0];
  await pool.query(
    `INSERT INTO rankings_normalized (raw_id, set_id, player_id, rank, confidence, matched_via, confirmed)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (raw_id) DO UPDATE
       SET player_id = EXCLUDED.player_id,
           confidence = EXCLUDED.confidence,
           matched_via = EXCLUDED.matched_via,
           confirmed = EXCLUDED.confirmed`,
    [rawId, set_id, playerId, rank, confidence, via, confirmed]
  );
  await pool.query('UPDATE ranking_sets SET updated_at = now() WHERE id = $1', [set_id]);
  return { set_id, rank };
}

async function confirmRow(rawId) {
  const { rowCount } = await pool.query(
    'UPDATE rankings_normalized SET confirmed = true WHERE raw_id = $1', [rawId]
  );
  if (!rowCount) throw new Error('That row has no match to confirm yet.');
}

// "Not a player" — drop the raw row (and any resolution) entirely.
async function ignoreRow(rawId) {
  await pool.query('DELETE FROM rankings_raw WHERE id = $1', [rawId]);
}

// The global review queue: unmatched raw rows + unconfirmed low/medium matches.
async function reviewQueue() {
  const { rows } = await pool.query(
    `SELECT r.id AS raw_id, r.set_id, r.rank, r.raw_name, r.raw_position, r.raw_team,
            s.name AS set_name, s.source, s.ranking_scope,
            n.player_id, n.confidence, n.matched_via,
            p.name AS suggested_name, p.position AS suggested_position, p.team AS suggested_team
     FROM rankings_raw r
     JOIN ranking_sets s ON s.id = r.set_id
     LEFT JOIN rankings_normalized n ON n.raw_id = r.id
     LEFT JOIN players_master p ON p.player_id = n.player_id
     WHERE n.id IS NULL OR (n.confidence <> 'high' AND NOT n.confirmed)
     ORDER BY s.updated_at DESC, r.rank ASC`
  );
  return rows;
}

module.exports = {
  cleanFormat,
  cleanScope,
  withPositionRanks,
  createSet,
  appendRows,
  listSets,
  getSet,
  getSetRows,
  updateSetMeta,
  deleteSet,
  resolveRow,
  confirmRow,
  ignoreRow,
  reviewQueue,
  FORMATS,
};
