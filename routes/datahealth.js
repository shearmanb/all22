// Data-health API (mounted at /api/datahealth, behind the password gate).
// The hub's freshness panel: per-dataset "how current is this?" so the owner
// never wonders whether something is stale (PRD §11). Answers come from cheap
// aggregate queries; a missing table or empty DB degrades to zeros, never 500s.
const express = require('express');
const pool = require('../db/pool');
const master = require('../lib/players-master');

const router = express.Router();
const hasDb = () => Boolean(process.env.DATABASE_URL);

async function tryQuery(sql, params = []) {
  try {
    const { rows } = await pool.query(sql, params);
    return rows;
  } catch (err) {
    return null;
  }
}

router.get('/', async (req, res) => {
  try {
    if (!hasDb()) {
      return res.json({ ok: true, data: { db: false } });
    }
    const [pm, sets, review, myRuns, adp, drafts, notes, boards] = await Promise.all([
      master.status(),
      tryQuery(`SELECT COUNT(*)::int AS n, MAX(updated_at) AS latest,
                       (SELECT name FROM ranking_sets ORDER BY updated_at DESC NULLS LAST, created_at DESC LIMIT 1) AS latest_name
                FROM ranking_sets`),
      tryQuery(`SELECT COUNT(*)::int AS n
                FROM rankings_raw r
                LEFT JOIN rankings_normalized rn ON rn.raw_id = r.id
                WHERE rn.id IS NULL OR (rn.confidence <> 'high' AND NOT rn.confirmed)`),
      tryQuery('SELECT COUNT(*)::int AS n, MAX(created_at) AS latest FROM my_ranking_runs'),
      tryQuery('SELECT MAX(snapshot_date) AS latest, COUNT(DISTINCT site)::int AS sites FROM adp_history'),
      tryQuery('SELECT COUNT(*)::int AS n, MAX(created_at) AS latest FROM drafts'),
      tryQuery('SELECT COUNT(*)::int AS n, MAX(updated_at) AS latest FROM notes WHERE NOT done'),
      tryQuery('SELECT COUNT(*)::int AS n, MAX(updated_at) AS latest FROM boards'),
    ]);
    res.json({
      ok: true,
      data: {
        db: true,
        players_master: pm,
        rankings: {
          sets: sets ? sets[0].n : 0,
          latest: sets ? sets[0].latest : null,
          latest_name: sets ? sets[0].latest_name : null,
          review_open: review ? review[0].n : 0,
        },
        my_rankings: { runs: myRuns ? myRuns[0].n : 0, latest: myRuns ? myRuns[0].latest : null },
        adp: { latest: adp ? adp[0].latest : null, sites: adp ? adp[0].sites : 0 },
        drafts: { count: drafts ? drafts[0].n : 0, latest: drafts ? drafts[0].latest : null },
        notes: { open: notes ? notes[0].n : 0, latest: notes ? notes[0].latest : null },
        boards: { count: boards ? boards[0].n : 0, latest: boards ? boards[0].latest : null },
      },
    });
  } catch (err) {
    console.error(`GET /api/datahealth: ${err.message}`);
    res.status(500).json({ ok: false, error: 'Could not load data health.' });
  }
});

module.exports = router;
