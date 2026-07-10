// store.js — My Rankings' database layer: my_ranking_runs + my_rankings
// (schema from 012, name/detail columns from 018). A run is a frozen snapshot:
// the dial settings live on the run, the per-player math lives in each row's
// detail JSONB, so deleting/re-ingesting source sets never rewrites history.
const pool = require('../../../db/pool');

// rows: buildEcr().overall — one my_rankings row per player, rank = ECR order,
// score = the weighted average, detail = the full per-player computation.
async function saveRun({ name, target_format, settings, rows }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: runRows } = await client.query(
      `INSERT INTO my_ranking_runs (name, target_format, settings)
       VALUES ($1, $2, $3)
       RETURNING id, name, target_format, settings, created_at`,
      [name, target_format, JSON.stringify(settings || {})]
    );
    const run = runRows[0];
    await client.query(
      `INSERT INTO my_rankings (run_id, player_id, rank, score, detail)
       SELECT $1, (r->>'player_id')::int, (r->>'rank')::int, (r->>'avg')::numeric, (r->'detail')::jsonb
       FROM jsonb_array_elements($2::jsonb) r`,
      [run.id, JSON.stringify(rows.map((r) => ({
        player_id: r.player_id,
        rank: r.rank,
        avg: r.avg,
        detail: {
          avg: r.avg, min: r.min, max: r.max, stdev: r.stdev, n: r.n,
          votes: r.votes, position: r.position, team: r.team, name: r.name,
        },
      })))]
    );
    await client.query('COMMIT');
    return run;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function listRuns() {
  const { rows } = await pool.query(
    `SELECT r.id, r.name, r.target_format, r.settings, r.created_at,
            COUNT(m.id)::int AS player_count
     FROM my_ranking_runs r
     LEFT JOIN my_rankings m ON m.run_id = r.id
     GROUP BY r.id
     ORDER BY r.created_at DESC`
  );
  return rows;
}

async function getRun(id) {
  const { rows } = await pool.query(
    `SELECT id, name, target_format, settings, created_at
     FROM my_ranking_runs WHERE id = $1`, [id]
  );
  return rows[0] || null;
}

// A run's rows with the players' CURRENT identity (name/team can change);
// the frozen detail keeps what the math actually saw at save time.
async function getRunRows(id) {
  const { rows } = await pool.query(
    `SELECT m.player_id, m.rank, m.score, m.detail,
            p.name, p.position, p.team
     FROM my_rankings m
     LEFT JOIN players_master p ON p.player_id = m.player_id
     WHERE m.run_id = $1
     ORDER BY m.rank ASC`, [id]
  );
  return rows.map((r) => ({
    player_id: r.player_id,
    rank: r.rank,
    avg: r.score === null ? null : Number(r.score),
    name: r.name || (r.detail && r.detail.name) || '',
    position: r.position || (r.detail && r.detail.position) || '',
    team: r.team || (r.detail && r.detail.team) || '',
    min: r.detail ? r.detail.min : null,
    max: r.detail ? r.detail.max : null,
    stdev: r.detail ? r.detail.stdev : null,
    n: r.detail ? r.detail.n : null,
    votes: (r.detail && r.detail.votes) || {},
  }));
}

async function deleteRun(id) {
  await pool.query('DELETE FROM my_ranking_runs WHERE id = $1', [id]);
}

module.exports = { saveRun, listRuns, getRun, getRunRows, deleteRun };
