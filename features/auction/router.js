// War Chest — auction budget calculator (web version of the owner's auction
// spreadsheet). Mounted at /api/auction. An auction = config (teams, budget,
// roster slots) + one row per roster slot (plan $ / player / paid $) + target
// lists. All the arithmetic lives in public/auction-math.js, shared with the
// browser so the numbers can never disagree.
const express = require('express');
const router = express.Router();

const pool = require('../../db/pool');
const master = require('../../lib/players-master');
const math = require('./public/auction-math');

const hasDb = () => Boolean(process.env.DATABASE_URL);

function slotSort(a, b) {
  const d = math.SLOT_ORDER.indexOf(a.slot) - math.SLOT_ORDER.indexOf(b.slot);
  return d !== 0 ? d : a.slot_num - b.slot_num;
}

// Latest published auction value per player, from any ingested ranking set that
// carried auction values (rankings_raw.auction_value) — used as price hints.
async function auctionValues(playerIds) {
  if (!playerIds.length) return {};
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (rn.player_id) rn.player_id, rr.auction_value
     FROM rankings_normalized rn
     JOIN rankings_raw rr ON rr.id = rn.raw_id
     JOIN ranking_sets rs ON rs.id = rn.set_id
     WHERE rn.player_id = ANY($1) AND rr.auction_value IS NOT NULL
     ORDER BY rn.player_id, rs.captured_on DESC NULLS LAST, rs.created_at DESC`,
    [playerIds]
  );
  const map = {};
  rows.forEach((r) => { map[r.player_id] = Number(r.auction_value); });
  return map;
}

// --- Player search (declared before /:id so "players" isn't read as an id) ---
// ?slot=RB filters to positions that can legally fill that slot type; each hit
// carries `value` (latest ingested auction value) when one is known.
router.get('/players', async (req, res) => {
  try {
    if (!hasDb()) return res.json({ ok: true, data: [] });
    let hits = await master.search(String(req.query.q || ''), 30);
    const allowed = math.SLOT_POSITIONS[String(req.query.slot || '').toUpperCase()];
    if (allowed) hits = hits.filter((p) => allowed.includes(p.position));
    hits = hits.slice(0, 12);
    const values = await auctionValues(hits.map((p) => p.player_id));
    hits.forEach((p) => { p.value = values[p.player_id] !== undefined ? values[p.player_id] : null; });
    res.json({ ok: true, data: hits });
  } catch (err) {
    console.error(`GET /api/auction/players: ${err.message}`);
    res.status(500).json({ ok: false, error: 'Player search failed.' });
  }
});

// --- Auctions ---------------------------------------------------------------

router.get('/', async (req, res) => {
  try {
    if (!hasDb()) return res.json({ ok: true, data: [] });
    const { rows } = await pool.query(
      `SELECT a.id, a.name, a.teams, a.budget, a.created_at, a.updated_at,
              COUNT(s.id)::int AS slot_count,
              COUNT(s.paid)::int AS filled_count,
              COALESCE(SUM(s.paid), 0)::numeric AS spent
       FROM auctions a
       LEFT JOIN auction_slots s ON s.auction_id = a.id
       GROUP BY a.id
       ORDER BY a.updated_at DESC NULLS LAST, a.created_at DESC`
    );
    res.json({ ok: true, data: rows });
  } catch (err) {
    console.error(`GET /api/auction: ${err.message}`);
    res.status(500).json({ ok: false, error: 'Could not load your auctions.' });
  }
});

router.post('/', async (req, res) => {
  const client = await pool.connect();
  try {
    if (!hasDb()) return res.status(400).json({ ok: false, error: 'The auction calculator needs a database (DATABASE_URL is not set).' });
    const body = req.body || {};
    const name = String(body.name || '').trim();
    if (!name) return res.status(400).json({ ok: false, error: 'Give the auction a name first.' });
    const teams = clampInt(body.teams, 2, 24, 12);
    const budget = clampMoney(body.budget, 200);
    const roster = math.cleanRoster(body.roster === undefined ? math.DEFAULT_ROSTER : body.roster);
    if (math.totalSlots(roster) < 1) return res.status(400).json({ ok: false, error: 'The roster needs at least one slot.' });
    await client.query('BEGIN');
    const { rows } = await client.query(
      'INSERT INTO auctions (name, teams, budget, roster) VALUES ($1, $2, $3, $4) RETURNING id',
      [name, teams, budget, JSON.stringify(roster)]
    );
    for (const s of math.expandRoster(roster)) {
      await client.query(
        'INSERT INTO auction_slots (auction_id, slot, slot_num) VALUES ($1, $2, $3)',
        [rows[0].id, s.slot, s.slot_num]
      );
    }
    await client.query('COMMIT');
    res.json({ ok: true, data: await fullAuction(rows[0].id) });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(`POST /api/auction: ${err.message}`);
    res.status(500).json({ ok: false, error: 'Could not create that auction.' });
  } finally {
    client.release();
  }
});

router.get('/:id', async (req, res) => {
  try {
    if (!hasDb()) return res.status(400).json({ ok: false, error: 'The auction calculator needs a database.' });
    const data = await fullAuction(req.params.id);
    if (!data) return res.status(404).json({ ok: false, error: 'Auction not found.' });
    res.json({ ok: true, data });
  } catch (err) {
    console.error(`GET /api/auction/:id: ${err.message}`);
    res.status(500).json({ ok: false, error: 'Could not load that auction.' });
  }
});

// Update config. Changing the roster adds the new empty slots and removes
// surplus ones — but never a slot with a player or price on it (400 instead).
router.patch('/:id', async (req, res) => {
  const client = await pool.connect();
  try {
    if (!hasDb()) return res.status(400).json({ ok: false, error: 'The auction calculator needs a database.' });
    const body = req.body || {};
    const sets = ['updated_at = now()'];
    const params = [req.params.id];
    if (body.name !== undefined) {
      const name = String(body.name).trim();
      if (!name) return res.status(400).json({ ok: false, error: 'An auction needs a name.' });
      params.push(name); sets.push(`name = $${params.length}`);
    }
    if (body.teams !== undefined) {
      params.push(clampInt(body.teams, 2, 24, 12)); sets.push(`teams = $${params.length}`);
    }
    if (body.budget !== undefined) {
      params.push(clampMoney(body.budget, 200)); sets.push(`budget = $${params.length}`);
    }
    if (body.notes !== undefined) {
      params.push(body.notes ? String(body.notes) : null); sets.push(`notes = $${params.length}`);
    }
    let roster = null;
    if (body.roster !== undefined) {
      roster = math.cleanRoster(body.roster);
      if (math.totalSlots(roster) < 1) return res.status(400).json({ ok: false, error: 'The roster needs at least one slot.' });
      params.push(JSON.stringify(roster)); sets.push(`roster = $${params.length}`);
    }

    await client.query('BEGIN');
    if (roster) {
      const { rows: slots } = await client.query(
        'SELECT id, slot, slot_num, plan, player_id, player_name, paid FROM auction_slots WHERE auction_id = $1',
        [req.params.id]
      );
      const diff = math.reconcileSlots(slots, roster);
      if (diff.blocked.length) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          ok: false,
          error: `Clear ${diff.blocked.join(', ')} first — there are players or prices on those slots.`,
        });
      }
      if (diff.removeIds.length) {
        await client.query('DELETE FROM auction_slots WHERE id = ANY($1)', [diff.removeIds]);
      }
      for (const s of diff.add) {
        await client.query(
          'INSERT INTO auction_slots (auction_id, slot, slot_num) VALUES ($1, $2, $3)',
          [req.params.id, s.slot, s.slot_num]
        );
      }
    }
    const { rows } = await client.query(
      `UPDATE auctions SET ${sets.join(', ')} WHERE id = $1 RETURNING id`, params
    );
    if (!rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ ok: false, error: 'Auction not found.' });
    }
    await client.query('COMMIT');
    res.json({ ok: true, data: await fullAuction(req.params.id) });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(`PATCH /api/auction/:id: ${err.message}`);
    res.status(500).json({ ok: false, error: 'Could not update that auction.' });
  } finally {
    client.release();
  }
});

router.delete('/:id', async (req, res) => {
  try {
    if (!hasDb()) return res.status(400).json({ ok: false, error: 'The auction calculator needs a database.' });
    await pool.query('DELETE FROM auctions WHERE id = $1', [req.params.id]);
    res.json({ ok: true, data: { deleted: true } });
  } catch (err) {
    console.error(`DELETE /api/auction/:id: ${err.message}`);
    res.status(500).json({ ok: false, error: 'Could not delete that auction.' });
  }
});

// --- Slots ------------------------------------------------------------------

// Update one budget-board row. Body may carry plan, paid, player_id and/or
// player_name; null (or '' for the $ fields) clears a value. "Assume I get
// him" = set player + paid; clearing paid reopens the slot.
router.patch('/:id/slots/:slotId', async (req, res) => {
  try {
    if (!hasDb()) return res.status(400).json({ ok: false, error: 'The auction calculator needs a database.' });
    const body = req.body || {};
    const sets = [];
    const params = [req.params.slotId, req.params.id];

    for (const field of ['plan', 'paid']) {
      if (body[field] === undefined) continue;
      const val = math.money(body[field]);
      if (val === null && body[field] !== null && body[field] !== '') {
        return res.status(400).json({ ok: false, error: 'Enter a dollar amount of 0 or more.' });
      }
      params.push(val); sets.push(`${field} = $${params.length}`);
    }
    if (body.player_id !== undefined || body.player_name !== undefined) {
      let playerId = body.player_id === undefined ? null : body.player_id;
      let playerName = body.player_name === undefined ? null : String(body.player_name || '').trim() || null;
      if (playerId != null) {
        const { rows } = await pool.query('SELECT name FROM players_master WHERE player_id = $1', [playerId]);
        if (!rows.length) return res.status(400).json({ ok: false, error: 'That player is not in the player list.' });
        if (!playerName) playerName = rows[0].name;
      }
      params.push(playerId); sets.push(`player_id = $${params.length}`);
      params.push(playerName); sets.push(`player_name = $${params.length}`);
    }
    if (!sets.length) return res.status(400).json({ ok: false, error: 'Nothing to update.' });

    const { rows } = await pool.query(
      `UPDATE auction_slots SET ${sets.join(', ')} WHERE id = $1 AND auction_id = $2
       RETURNING id, slot, slot_num, plan, player_id, player_name, paid`,
      params
    );
    if (!rows.length) return res.status(404).json({ ok: false, error: 'Slot not found.' });
    await pool.query('UPDATE auctions SET updated_at = now() WHERE id = $1', [req.params.id]);
    res.json({ ok: true, data: rows[0] });
  } catch (err) {
    console.error(`PATCH /api/auction/:id/slots/:slotId: ${err.message}`);
    res.status(500).json({ ok: false, error: 'Could not save that slot.' });
  }
});

// --- Targets (the sheet's Must Haves / Wants / watch lists) -----------------

router.post('/:id/targets', async (req, res) => {
  try {
    if (!hasDb()) return res.status(400).json({ ok: false, error: 'The auction calculator needs a database.' });
    const body = req.body || {};
    const name = String(body.player_name || '').trim();
    if (!name) return res.status(400).json({ ok: false, error: 'Type a player name first.' });
    const tier = ['must', 'want', 'watch'].includes(body.tier) ? body.tier : 'want';
    let playerId = body.player_id || null;
    if (playerId != null) {
      const { rows } = await pool.query('SELECT 1 FROM players_master WHERE player_id = $1', [playerId]);
      if (!rows.length) playerId = null; // freetext fallback — keep the name either way
    }
    const { rows } = await pool.query(
      `INSERT INTO auction_targets (auction_id, tier, player_id, player_name, est, sort)
       VALUES ($1, $2, $3, $4, $5,
               (SELECT COALESCE(MAX(sort), 0) + 1 FROM auction_targets WHERE auction_id = $1 AND tier = $2))
       RETURNING id, tier, player_id, player_name, est, gone, sort`,
      [req.params.id, tier, playerId, name, math.money(body.est)]
    );
    await pool.query('UPDATE auctions SET updated_at = now() WHERE id = $1', [req.params.id]);
    res.json({ ok: true, data: rows[0] });
  } catch (err) {
    console.error(`POST /api/auction/:id/targets: ${err.message}`);
    res.status(500).json({ ok: false, error: 'Could not add that target.' });
  }
});

router.patch('/:id/targets/:targetId', async (req, res) => {
  try {
    if (!hasDb()) return res.status(400).json({ ok: false, error: 'The auction calculator needs a database.' });
    const body = req.body || {};
    const sets = [];
    const params = [req.params.targetId, req.params.id];
    if (body.tier !== undefined && ['must', 'want', 'watch'].includes(body.tier)) {
      params.push(body.tier); sets.push(`tier = $${params.length}`);
    }
    if (body.est !== undefined) {
      params.push(math.money(body.est)); sets.push(`est = $${params.length}`);
    }
    if (body.gone !== undefined) {
      params.push(!!body.gone); sets.push(`gone = $${params.length}`);
    }
    if (body.player_name !== undefined) {
      const name = String(body.player_name).trim();
      if (!name) return res.status(400).json({ ok: false, error: 'A target needs a name — remove it instead.' });
      params.push(name); sets.push(`player_name = $${params.length}`);
    }
    if (!sets.length) return res.status(400).json({ ok: false, error: 'Nothing to update.' });
    const { rows } = await pool.query(
      `UPDATE auction_targets SET ${sets.join(', ')} WHERE id = $1 AND auction_id = $2
       RETURNING id, tier, player_id, player_name, est, gone, sort`,
      params
    );
    if (!rows.length) return res.status(404).json({ ok: false, error: 'Target not found.' });
    res.json({ ok: true, data: rows[0] });
  } catch (err) {
    console.error(`PATCH /api/auction/:id/targets/:targetId: ${err.message}`);
    res.status(500).json({ ok: false, error: 'Could not update that target.' });
  }
});

router.delete('/:id/targets/:targetId', async (req, res) => {
  try {
    if (!hasDb()) return res.status(400).json({ ok: false, error: 'The auction calculator needs a database.' });
    await pool.query('DELETE FROM auction_targets WHERE id = $1 AND auction_id = $2', [req.params.targetId, req.params.id]);
    res.json({ ok: true, data: { deleted: true } });
  } catch (err) {
    console.error(`DELETE /api/auction/:id/targets/:targetId: ${err.message}`);
    res.status(500).json({ ok: false, error: 'Could not remove that target.' });
  }
});

// --- helpers ----------------------------------------------------------------

// The whole state of one auction: config + ordered slots (with position, for
// the pos badge) + targets + the computed summary.
async function fullAuction(id) {
  const { rows: auctions } = await pool.query(
    'SELECT id, name, teams, budget, roster, notes, created_at, updated_at FROM auctions WHERE id = $1', [id]
  );
  if (!auctions.length) return null;
  const auction = auctions[0];
  auction.budget = Number(auction.budget);
  const { rows: slots } = await pool.query(
    `SELECT s.id, s.slot, s.slot_num, s.plan, s.player_id, s.player_name, s.paid,
            p.position AS player_position, p.team AS player_team
     FROM auction_slots s
     LEFT JOIN players_master p ON p.player_id = s.player_id
     WHERE s.auction_id = $1`, [id]
  );
  slots.sort(slotSort);
  slots.forEach((s) => {
    s.plan = s.plan === null ? null : Number(s.plan);
    s.paid = s.paid === null ? null : Number(s.paid);
  });
  const { rows: targets } = await pool.query(
    `SELECT id, tier, player_id, player_name, est, gone, sort
     FROM auction_targets WHERE auction_id = $1 ORDER BY tier, sort, id`, [id]
  );
  targets.forEach((t) => { t.est = t.est === null ? null : Number(t.est); });
  return { auction, slots, targets, summary: math.summarize(auction.budget, slots) };
}

function clampInt(value, min, max, fallback) {
  const n = Math.round(Number(value));
  if (!isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function clampMoney(value, fallback) {
  const n = math.money(value);
  if (n === null || n < 1) return fallback;
  return Math.min(n, 100000);
}

module.exports = router;
