// Reading the latest stored ADP board — the one place that decides WHICH
// snapshot answers a "give me ADP for this league" question, and what a board
// row looks like.
//
// Extracted from router.js so War Room's cheat sheet reads exactly the board
// Edge Rush would show. Two implementations of "which snapshot is the right
// one" would drift, and the owner would be drafting off a different board than
// the one he was looking at ten minutes earlier.
const pool = require('../../../db/pool');
const sources = require('./sources');

// Pick the best stored snapshot key for a format: exact league size beats
// Sleeper's sitewide (teams = 0) beats whatever is freshest.
async function resolveKey({ site, format, teams }) {
  const { rows } = await pool.query(
    `SELECT site, format, teams, MAX(snapshot_date)::text AS latest
     FROM adp_history
     WHERE format = $1
     GROUP BY site, format, teams`,
    [format]
  );
  let candidates = rows;
  if (site) candidates = candidates.filter((r) => r.site === site);
  if (!candidates.length) return null;
  const wanted = Number(teams) || null;
  const score = (r) => {
    if (wanted && Number(r.teams) === wanted) return 3;
    if (wanted && Number(r.teams) === sources.clampTeams(wanted) && r.site === 'ffc') return 2;
    if (Number(r.teams) === 0) return 1;
    return 0;
  };
  candidates.sort((a, b) =>
    (score(b) - score(a)) ||
    (a.latest < b.latest ? 1 : a.latest > b.latest ? -1 : 0) ||
    (a.site === 'ffc' ? -1 : 1)
  );
  const best = candidates[0];
  return { site: best.site, format, teams: Number(best.teams), latest: best.latest };
}

// One snapshot's rows, canonical identity preferred over the raw capture.
async function snapshotRows(key, date) {
  const { rows } = await pool.query(
    `SELECT a.player_id, a.raw_name, a.raw_position, a.raw_team, a.bye,
            a.adp::float AS adp, a.high::float AS high, a.low::float AS low,
            a.stdev::float AS stdev, a.times_drafted,
            p.name AS master_name, p.position AS master_position, p.team AS master_team
     FROM adp_history a
     LEFT JOIN players_master p ON p.player_id = a.player_id
     WHERE a.site = $1 AND a.format = $2 AND a.teams = $3 AND a.snapshot_date = $4
     ORDER BY a.adp ASC`,
    [key.site, key.format, key.teams, date]
  );
  return rows.map((r) => ({
    player_id: r.player_id,
    name: r.master_name || r.raw_name,
    position: r.master_position || r.raw_position || '',
    team: r.master_team || r.raw_team || '',
    raw_name: r.raw_name,
    matched: !!r.player_id,
    bye: r.bye,
    adp: r.adp,
    high: r.high,
    low: r.low,
    stdev: r.stdev,
    times_drafted: r.times_drafted,
  }));
}

// The whole job in one call: the freshest board for a league shape, or null
// when nothing has been collected for that format yet.
async function latestBoard({ site, format, teams }) {
  const key = await resolveKey({ site, format, teams });
  if (!key) return null;
  return { key, rows: await snapshotRows(key, key.latest) };
}

module.exports = { resolveKey, snapshotRows, latestBoard };
