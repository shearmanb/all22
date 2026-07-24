const express = require('express');
const pool = require('../../db/pool');
const settings = require('../../lib/settings');
const { parse: parserParse } = require('./lib/parsers');
const { suggest } = require('./lib/strategy');
const fpwizard = require('./lib/fpwizard');
const resolve = require('./lib/resolve');
const analysis = require('./lib/analysis');
const boards = require('../adp/lib/boards');

const router = express.Router();

function analyze(picks) {
  const myPicks = picks.filter((p) => p.isMyPick);
  const suggestedStrategy = suggest(myPicks);
  const positionCounts = {};
  for (const p of myPicks) {
    const pos = p.position || 'Other';
    positionCounts[pos] = (positionCounts[pos] || 0) + 1;
  }
  return { suggestedStrategy, positionCounts };
}

// POST /api/drafts/parse — parse pasted text; does NOT save anything.
// Must be declared before /:id routes.
router.post('/parse', async (req, res) => {
  try {
    const { text, site = 'underdog', leagueSize, mySlot } = req.body;
    if (!text || !text.trim()) {
      return res.json({ ok: false, error: 'Paste some draft text first.' });
    }
    const result = parserParse(site, text, {
      leagueSize: parseInt(leagueSize, 10) || 12,
      mySlot: parseInt(mySlot, 10) || 1,
    });

    res.json({ ok: true, data: { ...result, ...analyze(result.picks) } });
  } catch (err) {
    console.error(`POST /api/drafts/parse: ${err.message}`);
    res.json({ ok: false, error: err.message });
  }
});

// POST /api/drafts/fetch-url — fetch a FantasyPros Draft Wizard link server-side
// and mine the picks out of it (no copy-paste). Body: { url, leagueSize?, mySlot? }.
// Does NOT save anything; returns the same shape as /parse for the preview.
router.post('/fetch-url', async (req, res) => {
  try {
    const { url, leagueSize, mySlot } = req.body || {};
    const target = fpwizard.parseTarget(url);
    if (!target) {
      return res.json({
        ok: false,
        error: 'That doesn’t look like a FantasyPros Draft Wizard link — paste the Second Screen URL (it contains mockDraftKey=…).',
      });
    }
    const result = await fpwizard.fetchDraft(target, {
      leagueSize: parseInt(leagueSize, 10) || 12,
      mySlot: parseInt(mySlot, 10) || null,
    });
    // Keep what FantasyPros actually sent so it can be downloaded and debugged
    // instead of guessed at — on EVERY attempt, because a "success" that parsed
    // the wrong array needs the diagnostic just as much as a failure.
    lastFetchDiagnostic = {
      at: new Date().toISOString(),
      url: String(url),
      result: `${result.picks.length} picks`,
      tried: result.tried,
      captures: result.captures || [],
    };
    if (!result.picks.length) {
      const notes = result.tried.map((t) => `${t.url} -> ${t.status || 'error'} (${t.note})`).join('; ');
      console.error(`POST /api/drafts/fetch-url: no picks. ${notes}`);
      const reached = result.tried.some((t) => t.status >= 200 && t.status < 400);
      return res.json({
        ok: false,
        diagnostic: true,
        error: reached
          ? 'FantasyPros answered, but no draft picks were found on that page. If the mock is still running, try again once picks are in — otherwise copy the draft board and paste it below instead.'
          : 'Could not reach FantasyPros from the server (blocked or down). Copy the draft board and paste it below instead.',
      });
    }
    res.json({
      ok: true,
      data: {
        picks: result.picks,
        unparseable: [],
        inferredMySlot: result.inferredMySlot,
        inferredLeagueSize: result.inferredLeagueSize,
        ...analyze(result.picks),
      },
    });
  } catch (err) {
    console.error(`POST /api/drafts/fetch-url: ${err.message}`);
    res.json({ ok: false, error: 'Fetching that link failed: ' + err.message + '. Copy the draft board and paste it below instead.' });
  }
});

// GET /api/drafts/fetch-url/diagnostic — download what FantasyPros sent on the
// last failed URL import, so the extractor can be fixed against the real
// payload instead of a guess. Declared before /:id so the path isn't read as
// an id. In-memory, last failure only (single-user app).
let lastFetchDiagnostic = null;
router.get('/fetch-url/diagnostic', (req, res) => {
  if (!lastFetchDiagnostic) {
    return res.status(404).json({ ok: false, error: 'No failed fetch to report — try a Draft Wizard link first.' });
  }
  const d = lastFetchDiagnostic;
  const parts = [
    `All22 Draft Wizard fetch diagnostic — ${d.at} (importer v${fpwizard.VERSION})`,
    `Pasted URL: ${d.url}`,
    `Outcome: ${d.result || 'no picks'}`,
    '',
    'Attempts:',
    ...d.tried.map((t) => `  ${t.status || 'error'}  ${t.url}  (${t.note})`),
    '',
  ];
  for (const c of d.captures) {
    parts.push(`===== ${c.status} ${c.url} =====`, c.body, '');
  }
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="fpwizard-diagnostic.txt"');
  res.send(parts.join('\n'));
});

// GET /api/drafts — list drafts with optional filters.
router.get('/', async (req, res) => {
  try {
    const { site, draftType, strategy, sort } = req.query;
    const params = [];
    const where = [];

    if (site)      { params.push(site);      where.push(`d.site = $${params.length}`); }
    if (draftType) { params.push(draftType); where.push(`d.draft_type = $${params.length}`); }
    if (strategy)  { params.push(strategy);  where.push(`d.strategy = $${params.length}`); }

    const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const orderClause = sort === 'rating'
      ? 'd.rating DESC NULLS LAST, d.drafted_at DESC'
      : 'd.drafted_at DESC, d.created_at DESC';

    const sql = `
      SELECT d.*,
             COUNT(p.id) FILTER (WHERE p.is_my_pick) AS my_pick_count,
             COUNT(p.id) AS total_picks
      FROM drafts d
      LEFT JOIN picks p ON p.draft_id = d.id
      ${whereClause}
      GROUP BY d.id
      ORDER BY ${orderClause}
    `;
    const { rows } = await pool.query(sql, params);
    res.json({ ok: true, data: rows });
  } catch (err) {
    console.error(`GET /api/drafts: ${err.message}`);
    res.json({ ok: false, error: 'Failed to load drafts.' });
  }
});

// POST /api/drafts — save a new draft with picks.
router.post('/', async (req, res) => {
  try {
    const { site, draftType, draftedAt, leagueSize, mySlot, strategy, rating, notes, picks, source = 'manual', isTest = false, checkedOutAt = null } = req.body;

    if (!site || !draftType || !draftedAt || !leagueSize || !mySlot) {
      return res.json({ ok: false, error: 'Site, draft type, date, league size, and my slot are required.' });
    }
    if (!Array.isArray(picks) || picks.length === 0) {
      return res.json({ ok: false, error: 'No picks to save. Parse the draft text first.' });
    }

    const myPicks = picks.filter((p) => p.isMyPick);
    const suggestedStrategy = suggest(myPicks);

    // Resolve every pick to players_master BEFORE saving (Phase 3). Only
    // high-confidence matches get a player_id; the rest stay NULL and show
    // as unmatched — never a silent guess.
    const matches = await resolve.matchPicks(picks);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: [draft] } = await client.query(
        `INSERT INTO drafts
           (site, draft_type, drafted_at, league_size, my_slot, strategy, suggested_strategy, rating, notes, source, is_test, checked_out_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         RETURNING id`,
        [
          site, draftType, draftedAt,
          parseInt(leagueSize, 10), parseInt(mySlot, 10),
          strategy || null, suggestedStrategy,
          rating ? parseInt(rating, 10) : null,
          notes || null, source,
          !!isTest,
          checkedOutAt ? parseInt(checkedOutAt, 10) : null,
        ]
      );
      for (let i = 0; i < picks.length; i++) {
        const p = picks[i];
        const m = matches[i];
        await client.query(
          `INSERT INTO picks (draft_id, overall_pick, round, player_name, position, nfl_team, draft_slot, is_my_pick, player_id, match_confidence, match_via)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [
            draft.id,
            parseInt(p.overallPick, 10), parseInt(p.round, 10),
            p.playerName,
            p.position || null, p.nflTeam || null,
            p.draftSlot != null ? parseInt(p.draftSlot, 10) : null,
            !!p.isMyPick,
            m.player_id, m.confidence, m.via,
          ]
        );
      }
      await client.query('COMMIT');
      res.json({ ok: true, data: { id: draft.id } });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error(`POST /api/drafts: ${err.message}`);
    res.json({ ok: false, error: 'Failed to save draft.' });
  }
});

// GET /api/drafts/:id — draft detail with all picks.
router.get('/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { rows: [draft] } = await pool.query('SELECT * FROM drafts WHERE id = $1', [id]);
    if (!draft) return res.status(404).json({ ok: false, error: 'Draft not found.' });

    const { rows: picks } = await pool.query(
      'SELECT * FROM picks WHERE draft_id = $1 ORDER BY overall_pick', [id]
    );
    res.json({ ok: true, data: { ...draft, picks } });
  } catch (err) {
    console.error(`GET /api/drafts/${req.params.id}: ${err.message}`);
    res.json({ ok: false, error: 'Failed to load draft.' });
  }
});

// The ADP scoring format to grade a draft against when the request doesn't
// say: Underdog is half-PPR best ball; otherwise the ACTIVE league profile's
// scoring (never a hardcoded league shape — CLAUDE.md), else half.
async function defaultFormat(draft) {
  if (String(draft.site || '').toLowerCase() === 'underdog') return 'half';
  const profiles = await settings.get('league.profiles', null);
  const activeId = await settings.get('league.active', null);
  if (Array.isArray(profiles) && profiles.length) {
    const p = profiles.find((x) => x && x.id === activeId) || profiles[0];
    if (p) return p.superflex ? 'superflex' : (p.scoring || 'half');
  }
  return 'half';
}

// GET /api/drafts/:id/analysis — value vs ADP, reaches/steals, positional
// balance, team leaderboard. ?format=&site=&teams= override the ADP board
// (defaults: format from the draft's site / active league profile, teams from
// the draft's league size). Lazily resolves picks never matched before, so
// pre-rebuild drafts heal on first view.
router.get('/:id/analysis', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { rows: [draft] } = await pool.query('SELECT * FROM drafts WHERE id = $1', [id]);
    if (!draft) return res.status(404).json({ ok: false, error: 'Draft not found.' });

    const healed = await resolve.resolveDraftPicks(id);
    const { rows: picks } = await pool.query(
      'SELECT * FROM picks WHERE draft_id = $1 ORDER BY overall_pick', [id]
    );

    const format = String(req.query.format || '').toLowerCase() || await defaultFormat(draft);
    const key = await boards.resolveKey({
      site: req.query.site || undefined,
      format,
      teams: req.query.teams || draft.league_size,
    });
    const adpRows = key ? await boards.snapshotRows(key, key.latest) : [];

    // The owner's own opinion column: latest saved My Rankings run.
    const { rows: [run] } = await pool.query(
      'SELECT id, name, target_format, created_at FROM my_ranking_runs ORDER BY created_at DESC, id DESC LIMIT 1'
    );
    const myRanks = run
      ? (await pool.query('SELECT player_id, rank FROM my_rankings WHERE run_id = $1', [run.id])).rows
      : [];

    const options = await settings.get('playbook.analysis', {});
    const result = analysis.analyze({ picks, adp: adpRows, myRanks, mySlot: draft.my_slot, options });

    res.json({
      ok: true,
      data: {
        ...result,
        adp_board: key, // null = nothing stored for that format yet
        boards: await boards.availableBoards(),
        run: run ? { id: run.id, name: run.name, target_format: run.target_format, created_at: run.created_at } : null,
        resolved_now: healed,
      },
    });
  } catch (err) {
    console.error(`GET /api/drafts/${req.params.id}/analysis: ${err.message}`);
    res.json({ ok: false, error: 'Could not analyze this draft: ' + err.message });
  }
});

// POST /api/drafts/:id/resolve — force re-match EVERY pick against the current
// players_master (so learned aliases / manually added players heal old drafts).
router.post('/:id/resolve', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { rows: [draft] } = await pool.query('SELECT id FROM drafts WHERE id = $1', [id]);
    if (!draft) return res.status(404).json({ ok: false, error: 'Draft not found.' });
    const out = await resolve.resolveDraftPicks(id, { force: true });
    res.json({ ok: true, data: out });
  } catch (err) {
    console.error(`POST /api/drafts/${req.params.id}/resolve: ${err.message}`);
    res.json({ ok: false, error: 'Re-matching failed: ' + err.message });
  }
});

// PUT /api/drafts/:id — edit draft metadata (not picks).
router.put('/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { site, draftType, draftedAt, leagueSize, mySlot, strategy, rating, notes, isTest = false, checkedOutAt = null } = req.body;

    if (!site || !draftType || !draftedAt || !leagueSize || !mySlot) {
      return res.json({ ok: false, error: 'Site, draft type, date, league size, and my slot are required.' });
    }

    const { rowCount } = await pool.query(
      `UPDATE drafts
       SET site=$1, draft_type=$2, drafted_at=$3, league_size=$4, my_slot=$5,
           strategy=$6, rating=$7, notes=$8, is_test=$9, checked_out_at=$10
       WHERE id=$11`,
      [
        site, draftType, draftedAt,
        parseInt(leagueSize, 10), parseInt(mySlot, 10),
        strategy || null,
        rating ? parseInt(rating, 10) : null,
        notes || null,
        !!isTest,
        checkedOutAt ? parseInt(checkedOutAt, 10) : null,
        id,
      ]
    );
    if (rowCount === 0) return res.status(404).json({ ok: false, error: 'Draft not found.' });
    res.json({ ok: true, data: { id } });
  } catch (err) {
    console.error(`PUT /api/drafts/${req.params.id}: ${err.message}`);
    res.json({ ok: false, error: 'Failed to update draft.' });
  }
});

// DELETE /api/drafts/:id — delete draft and all its picks (cascade).
router.delete('/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { rowCount } = await pool.query('DELETE FROM drafts WHERE id = $1', [id]);
    if (rowCount === 0) return res.status(404).json({ ok: false, error: 'Draft not found.' });
    res.json({ ok: true, data: { id } });
  } catch (err) {
    console.error(`DELETE /api/drafts/${req.params.id}: ${err.message}`);
    res.json({ ok: false, error: 'Failed to delete draft.' });
  }
});

module.exports = router;
