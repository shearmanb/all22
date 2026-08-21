// War Room — the live draft recorder (/api/warroom). The owner drafts in
// person on a physical board; this API records picks as they happen, from more
// than one phone at once, and keeps every device in sync by polling a
// versioned state endpoint. Finished drafts are ordinary Playbook rows
// (source='warroom'), so the existing draft-detail analysis reads them as-is.
//
// Concurrency model: every pick mutation runs in a transaction that locks the
// draft row (SELECT ... FOR UPDATE), assigns the pick's slot server-side, and
// bumps drafts.version. Two phones can never double-book a slot or a player —
// the loser gets a human-readable conflict error plus the current state.
const express = require('express');
const pool = require('../../db/pool');
const settings = require('../../lib/settings');
const players = require('../../lib/players');
const snake = require('./public/warroom-snake');
const myRankings = require('../myrankings/lib/store');
const adpLatest = require('../adp/lib/latest');
const boardvision = require('./lib/boardvision');
const boarddiff = require('./lib/boarddiff');

const router = express.Router();
const hasDb = () => Boolean(process.env.DATABASE_URL);

// The active league profile for a draft (teams/scoring shape). Falls back to a
// bare {teams} so an old draft whose profile was deleted still renders.
async function leagueProfile(profileId, teams) {
  try {
    const all = await settings.get('league.profiles');
    const list = Array.isArray(all) ? all : [];
    return list.find((l) => l && l.id === profileId) || { id: profileId, teams };
  } catch (err) {
    return { id: profileId, teams };
  }
}

function draftShape(row) {
  return {
    id: row.id,
    status: row.status,
    teams: row.league_size,
    rounds: row.rounds,
    my_slot: row.my_slot,
    league_profile_id: row.league_profile_id,
    my_ranking_run_id: row.my_ranking_run_id,
    drafted_at: row.drafted_at,
    notes: row.notes,
    version: row.version,
  };
}

function pickShape(row) {
  return {
    id: row.id,
    overall_pick: row.overall_pick,
    round: row.round,
    draft_slot: row.draft_slot,
    player_id: row.player_id,
    player_name: row.player_name,
    position: row.position || '',
    nfl_team: row.nfl_team || '',
    is_my_pick: row.is_my_pick,
    recorded_by: row.recorded_by || '',
  };
}

// The full authoritative state every client renders from. `client` optional so
// it can run inside a mutation's transaction (post-commit reads would race).
async function loadState(draftId, client) {
  const db = client || pool;
  const { rows: drafts } = await db.query('SELECT * FROM drafts WHERE id = $1', [draftId]);
  if (!drafts.length) return null;
  const { rows: picks } = await db.query(
    'SELECT * FROM picks WHERE draft_id = $1 ORDER BY overall_pick ASC, id ASC', [draftId]
  );
  return {
    version: drafts[0].version,
    draft: draftShape(drafts[0]),
    picks: picks.map(pickShape),
  };
}

// ---------------------------------------------------------------------------
// Drafts
// ---------------------------------------------------------------------------

// List War Room drafts, live first then newest.
router.get('/drafts', async (req, res) => {
  try {
    if (!hasDb()) return res.json({ ok: true, data: [] });
    const { rows } = await pool.query(
      `SELECT d.*, COUNT(p.id)::int AS pick_count
       FROM drafts d LEFT JOIN picks p ON p.draft_id = d.id
       WHERE d.source = 'warroom'
       GROUP BY d.id
       ORDER BY (d.status = 'live') DESC, d.created_at DESC
       LIMIT 50`
    );
    res.json({ ok: true, data: rows.map((r) => Object.assign(draftShape(r), { pick_count: r.pick_count, created_at: r.created_at })) });
  } catch (err) {
    console.error(`GET /api/warroom/drafts: ${err.message}`);
    res.status(500).json({ ok: false, error: 'Could not load War Room drafts.' });
  }
});

// Start a live draft. Body: { league_profile_id, rounds, my_slot,
// my_ranking_run_id?, notes? }. Teams/scoring come from the league profile.
router.post('/drafts', async (req, res) => {
  try {
    if (!hasDb()) return res.status(400).json({ ok: false, error: 'War Room needs a database (DATABASE_URL is not set).' });
    const { league_profile_id, rounds, my_slot, my_ranking_run_id, notes } = req.body || {};
    const profiles = await settings.get('league.profiles');
    const profile = (Array.isArray(profiles) ? profiles : []).find((l) => l && l.id === league_profile_id);
    if (!profile) return res.status(400).json({ ok: false, error: 'Pick which league this draft is for first (add leagues on the hub).' });
    const teams = parseInt(profile.teams, 10) || 12;
    const r = parseInt(rounds, 10);
    const slot = parseInt(my_slot, 10);
    if (!(r >= 1 && r <= 30)) return res.status(400).json({ ok: false, error: 'Rounds must be between 1 and 30.' });
    if (!(slot >= 1 && slot <= teams)) return res.status(400).json({ ok: false, error: `Your draft slot must be between 1 and ${teams}.` });
    const runId = parseInt(my_ranking_run_id, 10);
    const { rows } = await pool.query(
      `INSERT INTO drafts (site, draft_type, drafted_at, league_size, my_slot, rounds,
                           league_profile_id, my_ranking_run_id, notes, source, status)
       VALUES ('live', 'snake', now(), $1, $2, $3, $4, $5, $6, 'warroom', 'live')
       RETURNING *`,
      [teams, slot, r, profile.id, Number.isFinite(runId) ? runId : null, notes ? String(notes) : null]
    );
    res.json({ ok: true, data: draftShape(rows[0]) });
  } catch (err) {
    console.error(`POST /api/warroom/drafts: ${err.message}`);
    res.status(500).json({ ok: false, error: 'Could not start the draft.' });
  }
});

// The sync poll. ?since=<version> returns a tiny "unchanged" when nothing
// happened — cheap enough to hit every 2.5s from every phone in the room.
router.get('/drafts/:id/state', async (req, res) => {
  try {
    if (!hasDb()) return res.status(400).json({ ok: false, error: 'War Room needs a database.' });
    const since = parseInt(req.query.since, 10);
    if (Number.isFinite(since)) {
      const { rows } = await pool.query("SELECT version FROM drafts WHERE id = $1 AND source = 'warroom'", [req.params.id]);
      if (!rows.length) return res.status(404).json({ ok: false, error: 'That draft no longer exists.' });
      if (rows[0].version === since) return res.json({ ok: true, data: { version: since, unchanged: true } });
    }
    const state = await loadState(req.params.id);
    if (!state) return res.status(404).json({ ok: false, error: 'That draft no longer exists.' });
    res.json({ ok: true, data: state });
  } catch (err) {
    console.error(`GET /api/warroom/drafts/:id/state: ${err.message}`);
    res.status(500).json({ ok: false, error: 'Could not load the draft.' });
  }
});

// End the draft: it becomes an ordinary completed Playbook draft.
router.post('/drafts/:id/finish', async (req, res) => {
  try {
    if (!hasDb()) return res.status(400).json({ ok: false, error: 'War Room needs a database.' });
    const { rowCount } = await pool.query(
      `UPDATE drafts SET status = 'complete', version = version + 1, updated_at = now()
       WHERE id = $1 AND source = 'warroom'`, [req.params.id]
    );
    if (!rowCount) return res.status(404).json({ ok: false, error: 'That draft no longer exists.' });
    res.json({ ok: true, data: await loadState(req.params.id) });
  } catch (err) {
    console.error(`POST /api/warroom/drafts/:id/finish: ${err.message}`);
    res.status(500).json({ ok: false, error: 'Could not finish the draft.' });
  }
});

// Reopen a finished draft (mis-tap insurance).
router.post('/drafts/:id/reopen', async (req, res) => {
  try {
    if (!hasDb()) return res.status(400).json({ ok: false, error: 'War Room needs a database.' });
    const { rowCount } = await pool.query(
      `UPDATE drafts SET status = 'live', version = version + 1, updated_at = now()
       WHERE id = $1 AND source = 'warroom'`, [req.params.id]
    );
    if (!rowCount) return res.status(404).json({ ok: false, error: 'That draft no longer exists.' });
    res.json({ ok: true, data: await loadState(req.params.id) });
  } catch (err) {
    console.error(`POST /api/warroom/drafts/:id/reopen: ${err.message}`);
    res.status(500).json({ ok: false, error: 'Could not reopen the draft.' });
  }
});

router.delete('/drafts/:id', async (req, res) => {
  try {
    if (!hasDb()) return res.status(400).json({ ok: false, error: 'War Room needs a database.' });
    await pool.query("DELETE FROM drafts WHERE id = $1 AND source = 'warroom'", [req.params.id]);
    res.json({ ok: true, data: { deleted: true } });
  } catch (err) {
    console.error(`DELETE /api/warroom/drafts/:id: ${err.message}`);
    res.status(500).json({ ok: false, error: 'Could not delete the draft.' });
  }
});

// The draft-day board: the owner's own blended rankings, with each player's
// ADP alongside so the page can answer "will he make it back to me?". Loaded
// once per draft — rankings don't change mid-draft; who's gone does, and that
// is computed client-side from the picks the poll already delivers.
router.get('/drafts/:id/cheatsheet', async (req, res) => {
  try {
    if (!hasDb()) return res.json({ ok: true, data: { rows: [], note: '' } });
    const { rows: drafts } = await pool.query(
      "SELECT * FROM drafts WHERE id = $1 AND source = 'warroom'", [req.params.id]
    );
    if (!drafts.length) return res.status(404).json({ ok: false, error: 'That draft no longer exists.' });
    const draft = drafts[0];
    const profile = await leagueProfile(draft.league_profile_id, draft.league_size);
    const format = String(profile.scoring || 'half').toLowerCase();
    const notesPre = [];

    // Which ADP board orders the draft-day list. The owner's saved choice wins,
    // a ?site= overrides it for this load, and with neither we take the best
    // stored match for the league shape.
    const savedSite = await settings.get('warroom.adp_site', '');
    const wantSite = String(req.query.site || savedSite || '').trim();
    const sites = await adpLatest.listBoards(format);
    let board = await adpLatest.latestBoard({
      site: wantSite || undefined, format, teams: draft.league_size,
    });
    // A saved source that has since stopped collecting must not leave the owner
    // with an empty board on draft day — fall back and say so.
    if (!board && wantSite) {
      board = await adpLatest.latestBoard({ format, teams: draft.league_size });
      if (board) notesPre.push(`No "${wantSite}" ADP for this format — using ${board.key.site}.`);
    }
    const adpBy = new Map();
    if (board) for (const r of board.rows) if (r.player_id) adpBy.set(r.player_id, r);

    const notes = notesPre.slice();
    let rows = [];
    if (draft.my_ranking_run_id) {
      const run = await myRankings.getRun(draft.my_ranking_run_id);
      const runRows = run ? await myRankings.getRunRows(draft.my_ranking_run_id) : [];
      rows = runRows.map((r) => {
        const a = adpBy.get(r.player_id) || {};
        return {
          player_id: r.player_id,
          rank: r.rank,
          name: r.name,
          position: r.position,
          team: r.team,
          adp: a.adp === undefined ? null : a.adp,
          stdev: a.stdev === undefined ? null : a.stdev,
          high: a.high === undefined ? null : a.high,
          low: a.low === undefined ? null : a.low,
        };
      });
      if (run) notes.push(`Your rankings: ${run.name || 'run #' + run.id}`);
      else notes.push('That saved ranking run is gone — showing ADP order instead.');
    }
    if (!rows.length) {
      rows = (board ? board.rows : []).map((r, i) => ({
        player_id: r.player_id,
        rank: i + 1,
        name: r.name,
        position: r.position,
        team: r.team,
        adp: r.adp,
        stdev: r.stdev,
        high: r.high,
        low: r.low,
      }));
      if (rows.length) notes.push('Ordered by ADP — pin a My Rankings run to a draft to use your own board.');
    }

    if (board) {
      notes.push(`ADP: ${board.key.site} ${format}${board.key.teams ? ' ' + board.key.teams + '-team' : ' site-wide'}, ${board.key.latest}`);
      // The %-available math needs a spread; say plainly when the source
      // didn't publish one (PRD open decision 4 — never bury the estimate).
      const withStdev = board.rows.filter((r) => r.stdev !== null && r.stdev !== undefined && Number(r.stdev) > 0).length;
      if (!withStdev) notes.push('This ADP source publishes no spread, so “% available” is estimated.');
    } else {
      notes.push('No ADP collected for this format yet, so there is no “% available”.');
    }

    // The draft-order list the Record panel taps from: every player the source
    // published, in ADP order. Kept separate from `rows` because that list is
    // the owner's OWN ranking order — two different questions ("who do I want"
    // vs "who is realistically coming off the board next").
    const adpRows = (board ? board.rows : []).map((r, i) => ({
      player_id: r.player_id,
      adp_rank: i + 1,
      name: r.name,
      position: r.position,
      team: r.team,
      adp: r.adp,
      matched: r.matched,
    }));

    res.json({
      ok: true,
      data: {
        rows,
        note: notes.join(' · '),
        adp: board
          ? { site: board.key.site, teams: board.key.teams, date: board.key.latest, rows: adpRows }
          : null,
        sites,
        format,
      },
    });
  } catch (err) {
    console.error(`GET /api/warroom/drafts/:id/cheatsheet: ${err.message}`);
    res.status(500).json({ ok: false, error: 'Could not build the cheat sheet.' });
  }
});

// ---------------------------------------------------------------------------
// Photo verification: the board on the wall is the truth, this is the check.
// ---------------------------------------------------------------------------

// Read one photo of the board. The client sends photos one at a time (a whole
// board rarely fits in one legible frame) and accumulates the cells, exactly
// the way Combine accumulates screenshots. Nothing is saved: reading a photo
// never changes a pick, it only produces something to compare.
router.post('/drafts/:id/verify-photo', async (req, res) => {
  try {
    const { image } = req.body || {};
    if (!image) return res.status(400).json({ ok: false, error: 'Take or choose a photo of the board first.' });
    if (!boardvision.available()) {
      // No Tesseract fallback here on purpose: the offline reader returns flat
      // text, which cannot say which square a name was in — the one thing a
      // board check needs. Better to say so than to "verify" against nothing.
      return res.status(400).json({ ok: false, error: 'Reading board photos needs ANTHROPIC_API_KEY on the server. Check the board by eye for now — the picks you recorded are unaffected.' });
    }
    // War Room's own dials — not Combine's, on purpose (see boardvision.js).
    const model = await settings.get('warroom.board_model', boardvision.DEFAULT_MODEL);
    const effort = await settings.get('warroom.board_effort', boardvision.DEFAULT_EFFORT);
    const timeoutMs = await settings.get('warroom.board_timeout_ms', boardvision.DEFAULT_TIMEOUT_MS);
    const out = await boardvision.readBoard(String(image), {
      model: model || undefined,
      effort: effort || undefined,
      timeoutMs: Number(timeoutMs) || undefined,
    });
    res.json({ ok: true, data: out });
  } catch (err) {
    console.error(`POST /api/warroom/drafts/:id/verify-photo: ${err.message}`);
    res.status(500).json({ ok: false, error: `Could not read that photo. ${err.message}` });
  }
});

// Compare accumulated cells against the recorded picks. Body: { cells }.
// Returns findings the owner resolves by hand — nothing is changed for him.
router.post('/drafts/:id/verify-report', async (req, res) => {
  try {
    if (!hasDb()) return res.status(400).json({ ok: false, error: 'War Room needs a database.' });
    const state = await loadState(req.params.id);
    if (!state) return res.status(404).json({ ok: false, error: 'That draft no longer exists.' });
    const cells = Array.isArray(req.body && req.body.cells) ? req.body.cells : [];
    const { findings, summary } = boarddiff.diffBoard(cells, state.picks);
    res.json({ ok: true, data: { findings, summary, teams: state.draft.teams, rounds: state.draft.rounds } });
  } catch (err) {
    console.error(`POST /api/warroom/drafts/:id/verify-report: ${err.message}`);
    res.status(500).json({ ok: false, error: 'Could not compare the photo with the recorded picks.' });
  }
});

// Remember which ADP board orders the draft-day list. A dial, so it lives in
// settings rather than in one phone's local storage — every recorder in the
// room should be looking at the same order.
router.put('/adp-site', async (req, res) => {
  try {
    const site = String((req.body || {}).site || '').trim();
    await settings.set('warroom.adp_site', site);
    res.json({ ok: true, data: { site } });
  } catch (err) {
    console.error(`PUT /api/warroom/adp-site: ${err.message}`);
    res.status(500).json({ ok: false, error: 'Could not save that ADP source.' });
  }
});

// ---------------------------------------------------------------------------
// Picks — the concurrent-safe heart.
// ---------------------------------------------------------------------------

// Resolve what identity a pick request carries. A player_id means the recorder
// tapped a specific player from search — canonical identity. A bare name is
// stored raw (player_id NULL) and shows as needs-review; we NEVER fuzzy-match
// silently here (the CLAUDE.md invariant).
async function resolveIdentity(db, body) {
  const playerId = parseInt(body.player_id, 10);
  if (Number.isFinite(playerId)) {
    const { rows } = await db.query(
      'SELECT player_id, name, position, team FROM players_master WHERE player_id = $1', [playerId]
    );
    if (!rows.length) throw new Error('That player is not in the master list any more — search again.');
    return { player_id: rows[0].player_id, name: rows[0].name, position: rows[0].position || '', team: rows[0].team || '' };
  }
  const name = players.display(String(body.name || ''));
  if (!name || players.key(name).length < 2) throw new Error('Type or pick a player name first.');
  return {
    player_id: null,
    name,
    position: String(body.position || '').toUpperCase().replace(/\./g, ''),
    team: String(body.team || '').toUpperCase().replace(/\./g, ''),
  };
}

// The double-entry guard: same player_id, or same normalized name when ids are
// missing on either side. `force` (an explicit second tap in the UI) lets the
// rare legit same-name pair through.
function findDuplicate(existing, identity) {
  const k = players.key(identity.name);
  return existing.find((p) =>
    (identity.player_id && p.player_id === identity.player_id) ||
    (!(identity.player_id && p.player_id) && players.key(p.player_name) === k)
  );
}

function conflictPayload(res, message, state) {
  return res.status(409).json({ ok: false, error: message, data: state });
}

// Record a pick. Body: { player_id? | name, position?, team?,
// expected_overall?, recorded_by?, force? }.
router.post('/drafts/:id/picks', async (req, res) => {
  const client = hasDb() ? await pool.connect() : null;
  if (!client) return res.status(400).json({ ok: false, error: 'War Room needs a database.' });
  try {
    await client.query('BEGIN');
    const { rows: drafts } = await client.query('SELECT * FROM drafts WHERE id = $1 FOR UPDATE', [req.params.id]);
    if (!drafts.length || drafts[0].source !== 'warroom') {
      await client.query('ROLLBACK');
      return res.status(404).json({ ok: false, error: 'That draft no longer exists.' });
    }
    const draft = drafts[0];
    if (draft.status !== 'live') {
      await client.query('ROLLBACK');
      return res.status(400).json({ ok: false, error: 'This draft is finished — reopen it to record more picks.' });
    }
    const { rows: existing } = await client.query(
      'SELECT id, overall_pick, player_id, player_name, recorded_by FROM picks WHERE draft_id = $1', [req.params.id]
    );

    const teams = draft.league_size;
    const rounds = draft.rounds || 30;
    const taken = new Set(existing.map((p) => p.overall_pick));
    const overall = snake.nextOpenOverall(taken, teams, rounds);
    if (!overall) {
      await client.query('ROLLBACK');
      return res.status(400).json({ ok: false, error: 'The board is full — every pick is recorded.' });
    }

    const body = req.body || {};
    const expected = parseInt(body.expected_overall, 10);
    if (Number.isFinite(expected) && expected !== overall) {
      await client.query('ROLLBACK');
      const state = await loadState(req.params.id);
      return conflictPayload(res, `Someone else just recorded pick ${snake.pickLabel(expected, teams)} — you are now on ${snake.pickLabel(overall, teams)}. Check the board and try again.`, state);
    }

    let identity;
    try { identity = await resolveIdentity(client, body); }
    catch (e) {
      await client.query('ROLLBACK');
      return res.status(400).json({ ok: false, error: e.message });
    }

    if (!body.force) {
      const dup = findDuplicate(existing, identity);
      if (dup) {
        await client.query('ROLLBACK');
        const state = await loadState(req.params.id);
        return conflictPayload(res, `${identity.name} was already taken at pick ${snake.pickLabel(dup.overall_pick, teams)}${dup.recorded_by ? ' (recorded by ' + dup.recorded_by + ')' : ''}. If this really is a different player with the same name, tap again to confirm.`, state);
      }
    }

    const spot = snake.overallToSlot(overall, teams);
    const { rows: inserted } = await client.query(
      `INSERT INTO picks (draft_id, overall_pick, round, player_name, position, nfl_team,
                          draft_slot, is_my_pick, player_id, recorded_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [req.params.id, overall, spot.round, identity.name, identity.position || null,
       identity.team || null, spot.slot, spot.slot === draft.my_slot,
       identity.player_id, String(body.recorded_by || '').trim() || null]
    );
    await client.query('UPDATE drafts SET version = version + 1, updated_at = now() WHERE id = $1', [req.params.id]);
    const state = await loadState(req.params.id, client);
    await client.query('COMMIT');
    res.json({ ok: true, data: Object.assign(state, { recorded: pickShape(inserted[0]) }) });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    // The unique indexes are the last line of defense if two writes squeeze past
    // the row lock (shouldn't happen) — turn them into the same friendly errors.
    if (/picks_draft_player_uq/.test(err.message)) {
      const state = await loadState(req.params.id).catch(() => null);
      return conflictPayload(res, 'That player was already recorded by someone else a moment ago.', state);
    }
    if (/picks_draft_overall_uq/.test(err.message)) {
      const state = await loadState(req.params.id).catch(() => null);
      return conflictPayload(res, 'Someone else just recorded that pick — check the board and try again.', state);
    }
    console.error(`POST /api/warroom/drafts/:id/picks: ${err.message}`);
    res.status(500).json({ ok: false, error: 'Could not record that pick.' });
  } finally {
    client.release();
  }
});

// Edit a pick's identity (fix a wrong tap / attach a player to a typed name).
// Body: { player_id? | name, position?, team?, force? }.
router.put('/drafts/:id/picks/:pickId', async (req, res) => {
  const client = hasDb() ? await pool.connect() : null;
  if (!client) return res.status(400).json({ ok: false, error: 'War Room needs a database.' });
  try {
    await client.query('BEGIN');
    const { rows: drafts } = await client.query('SELECT * FROM drafts WHERE id = $1 FOR UPDATE', [req.params.id]);
    if (!drafts.length || drafts[0].source !== 'warroom') {
      await client.query('ROLLBACK');
      return res.status(404).json({ ok: false, error: 'That draft no longer exists.' });
    }
    const { rows: existing } = await client.query(
      'SELECT id, overall_pick, player_id, player_name, recorded_by FROM picks WHERE draft_id = $1', [req.params.id]
    );
    const target = existing.find((p) => p.id === parseInt(req.params.pickId, 10));
    if (!target) {
      await client.query('ROLLBACK');
      return res.status(404).json({ ok: false, error: 'That pick no longer exists.' });
    }
    let identity;
    try { identity = await resolveIdentity(client, req.body || {}); }
    catch (e) {
      await client.query('ROLLBACK');
      return res.status(400).json({ ok: false, error: e.message });
    }
    if (!(req.body || {}).force) {
      const dup = findDuplicate(existing.filter((p) => p.id !== target.id), identity);
      if (dup) {
        await client.query('ROLLBACK');
        const state = await loadState(req.params.id);
        return conflictPayload(res, `${identity.name} is already on the board at pick ${snake.pickLabel(dup.overall_pick, drafts[0].league_size)}.`, state);
      }
    }
    await client.query(
      `UPDATE picks SET player_id = $2, player_name = $3, position = $4, nfl_team = $5 WHERE id = $1`,
      [target.id, identity.player_id, identity.name, identity.position || null, identity.team || null]
    );
    await client.query('UPDATE drafts SET version = version + 1, updated_at = now() WHERE id = $1', [req.params.id]);
    const state = await loadState(req.params.id, client);
    await client.query('COMMIT');
    res.json({ ok: true, data: state });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(`PUT /api/warroom/drafts/:id/picks/:pickId: ${err.message}`);
    res.status(500).json({ ok: false, error: 'Could not update that pick.' });
  } finally {
    client.release();
  }
});

// Delete a pick (undo = delete the latest). The freed slot is simply the next
// one filled — exactly what happens on the physical board when a sticker moves.
router.delete('/drafts/:id/picks/:pickId', async (req, res) => {
  const client = hasDb() ? await pool.connect() : null;
  if (!client) return res.status(400).json({ ok: false, error: 'War Room needs a database.' });
  try {
    await client.query('BEGIN');
    await client.query('SELECT id FROM drafts WHERE id = $1 FOR UPDATE', [req.params.id]);
    const { rowCount } = await client.query(
      'DELETE FROM picks WHERE id = $1 AND draft_id = $2', [req.params.pickId, req.params.id]
    );
    if (!rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({ ok: false, error: 'That pick no longer exists (someone may have already removed it).' });
    }
    await client.query('UPDATE drafts SET version = version + 1, updated_at = now() WHERE id = $1', [req.params.id]);
    const state = await loadState(req.params.id, client);
    await client.query('COMMIT');
    res.json({ ok: true, data: state });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(`DELETE /api/warroom/drafts/:id/picks/:pickId: ${err.message}`);
    res.status(500).json({ ok: false, error: 'Could not remove that pick.' });
  } finally {
    client.release();
  }
});

module.exports = router;
