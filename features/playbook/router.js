const express = require('express');
const pool = require('../../db/pool');
const { parse: parserParse } = require('./lib/parsers');
const { suggest } = require('./lib/strategy');
const fpwizard = require('./lib/fpwizard');

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
    `All22 Draft Wizard fetch diagnostic — ${d.at}`,
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
      for (const p of picks) {
        await client.query(
          `INSERT INTO picks (draft_id, overall_pick, round, player_name, position, nfl_team, draft_slot, is_my_pick)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            draft.id,
            parseInt(p.overallPick, 10), parseInt(p.round, 10),
            p.playerName,
            p.position || null, p.nflTeam || null,
            p.draftSlot != null ? parseInt(p.draftSlot, 10) : null,
            !!p.isMyPick,
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
