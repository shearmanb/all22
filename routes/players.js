// Player DB API (mounted at /api/players, behind the password gate).
// A window into players_master — the registry every dataset joins on — and
// the per-site alias map ("what does each site call this player?").
// Read-mostly; the only writes are alias add/forget, which go through the
// players_master service so the live match index stays coherent.
const express = require('express');
const pool = require('../db/pool');
const players = require('../lib/players');
const master = require('../lib/players-master');

const router = express.Router();
const hasDb = () => Boolean(process.env.DATABASE_URL);

// List/search players. ?q= matches name, name_key or any alias text;
// ?pos=, ?source=, ?active=1|0, ?aliased=1 filter; limit/offset page.
router.get('/', async (req, res) => {
  try {
    if (!hasDb()) return res.json({ ok: true, data: { rows: [], total: 0 } });
    const where = [];
    const params = [];
    const add = (sql, val) => { params.push(val); where.push(sql.replace('?', `$${params.length}`)); };

    const q = String(req.query.q || '').trim();
    if (q) {
      const k = players.key(q);
      // name-key prefix / word-start, display-name substring, or alias text —
      // searching a site's spelling should find the canonical player.
      params.push(k + '%');
      const p1 = `$${params.length}`;
      params.push('% ' + k + '%');
      const p2 = `$${params.length}`;
      params.push('%' + q + '%');
      const p3 = `$${params.length}`;
      where.push(`(name_key LIKE ${p1} OR name_key LIKE ${p2} OR name ILIKE ${p3} OR aliases::text ILIKE ${p3})`);
    }
    const pos = String(req.query.pos || '').toUpperCase().trim();
    if (pos) add('position = ?', pos);
    const source = String(req.query.source || '').toLowerCase().trim();
    if (source) add('source = ?', source);
    if (req.query.active === '1') where.push('active');
    if (req.query.active === '0') where.push('NOT active');
    if (req.query.aliased === '1') where.push(`aliases <> '{}'::jsonb`);

    const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 100));
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
    params.push(limit, offset);

    const { rows } = await pool.query(
      `SELECT player_id, name, name_key, position, team, active, source, aliases, updated_at,
              COUNT(*) OVER()::int AS total
       FROM players_master
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY active DESC,
                (position IN ('QB','RB','WR','TE','K','DST')) DESC,
                name ASC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    const total = rows.length ? rows[0].total : 0;
    res.json({ ok: true, data: { rows: rows.map(({ total: _t, ...r }) => r), total } });
  } catch (err) {
    console.error(`GET /api/players: ${err.message}`);
    res.status(500).json({ ok: false, error: 'Could not load the player list.' });
  }
});

router.get('/stats', async (req, res) => {
  try {
    if (!hasDb()) return res.json({ ok: true, data: { total: 0 } });
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE active)::int AS active,
              COUNT(*) FILTER (WHERE source = 'manual')::int AS manual,
              COUNT(*) FILTER (WHERE aliases <> '{}'::jsonb)::int AS with_aliases,
              COALESCE(SUM((SELECT COUNT(*)::int
                            FROM jsonb_each(aliases) s,
                                 jsonb_array_elements_text(s.value))), 0)::int AS alias_variants
       FROM players_master`
    );
    res.json({ ok: true, data: Object.assign({}, rows[0], { synced_at: await master.syncedAt() }) });
  } catch (err) {
    console.error(`GET /api/players/stats: ${err.message}`);
    res.status(500).json({ ok: false, error: 'Could not load player registry stats.' });
  }
});

// Teach an alias: "site writes `variant`, meaning this player."
router.post('/:playerId/alias', async (req, res) => {
  try {
    if (!hasDb()) return res.status(400).json({ ok: false, error: 'Aliases need a database.' });
    const { variant, site } = req.body || {};
    if (!variant || !String(variant).trim()) {
      return res.status(400).json({ ok: false, error: 'Type the name the site uses first.' });
    }
    const data = await master.learnAlias(Number(req.params.playerId), String(variant), site);
    if (!data) return res.status(400).json({ ok: false, error: 'That alias is empty after cleanup.' });
    res.json({ ok: true, data });
  } catch (err) {
    console.error(`POST /api/players/:playerId/alias: ${err.message}`);
    const missing = /not found/i.test(err.message);
    res.status(missing ? 404 : 500).json({ ok: false, error: missing ? 'Player not found.' : 'Could not save that alias.' });
  }
});

// Forget an alias.
router.delete('/:playerId/alias', async (req, res) => {
  try {
    if (!hasDb()) return res.status(400).json({ ok: false, error: 'Aliases need a database.' });
    const { variant, site } = req.body || {};
    if (!variant) return res.status(400).json({ ok: false, error: 'Say which alias to forget.' });
    const data = await master.removeAlias(Number(req.params.playerId), String(variant), site);
    res.json({ ok: true, data });
  } catch (err) {
    console.error(`DELETE /api/players/:playerId/alias: ${err.message}`);
    const missing = /not found/i.test(err.message);
    res.status(missing ? 404 : 500).json({ ok: false, error: missing ? 'Player not found.' : 'Could not remove that alias.' });
  }
});

module.exports = router;
