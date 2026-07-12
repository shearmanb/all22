// collect.js — Edge Rush's snapshot collector. Pulls each configured ADP feed
// at most once per day into adp_history, resolving names through the one
// canonical matching stack (players_master + ingest.matchRow).
//
// Which feeds? Never hardcoded (CLAUDE.md): the explicit settings override
// 'adp.sources' wins; otherwise targets derive from the owner's league
// profiles (every league's scoring + size gets a feed); otherwise sane
// defaults. Sleeper is always collected — one call covers every format,
// joined EXACTLY by sleeper_id (teams stored as 0 = sitewide, not size-based).
//
// Identity rule: only 'high'-confidence matches get a player_id. Anything
// fuzzier keeps player_id NULL with the site's raw_name preserved — visible
// as "unmatched" on the page, never a silent guess (CLAUDE.md).
const pool = require('../../../db/pool');
const settings = require('../../../lib/settings');
const master = require('../../../lib/players-master');
const ingest = require('../../combine/lib/ingest');
const sources = require('./sources');
const custom = require('./custom');

const hasDb = () => Boolean(process.env.DATABASE_URL);

function today() {
  return new Date().toISOString().slice(0, 10);
}

// The FFC feeds to collect: settings override, else league profiles, else defaults.
async function ffcTargets() {
  const push = (list, seen, format, teams) => {
    if (!sources.FFC_FORMATS[format]) return;
    const t = sources.clampTeams(teams);
    const k = `${format}:${t}`;
    if (!seen.has(k)) { seen.add(k); list.push({ format, teams: t }); }
  };
  const list = [];
  const seen = new Set();

  const explicit = await settings.get('adp.sources', null);
  if (Array.isArray(explicit) && explicit.length) {
    for (const s of explicit) push(list, seen, String((s && s.format) || '').toLowerCase(), s && s.teams);
    return list;
  }
  const profiles = await settings.get('league.profiles', null);
  if (Array.isArray(profiles)) {
    for (const p of profiles) {
      if (!p) continue;
      push(list, seen, p.superflex ? 'superflex' : (p.scoring || 'half'), p.teams || 12);
    }
  }
  if (!list.length) {
    const legacy = await settings.get('league.profile', null);
    if (legacy) push(list, seen, legacy.superflex ? 'superflex' : (legacy.scoring || 'half'), legacy.teams || 12);
  }
  if (!list.length) {
    push(list, seen, 'ppr', 12);
    push(list, seen, 'half', 12);
    push(list, seen, 'standard', 12);
  }
  return list;
}

async function haveSnapshot(site, format, teams, date) {
  const { rows } = await pool.query(
    'SELECT 1 FROM adp_history WHERE site = $1 AND format = $2 AND teams = $3 AND snapshot_date = $4 LIMIT 1',
    [site, format, teams, date]
  );
  return rows.length > 0;
}

// Replace one (site, format, teams, date) slice atomically. Dedupes by
// raw_name (the snapshot key) keeping the earliest pick.
async function writeSnapshot(site, format, teams, date, rows) {
  const byName = new Map();
  for (const r of rows) {
    const prev = byName.get(r.raw_name);
    if (!prev || r.adp < prev.adp) byName.set(r.raw_name, r);
  }
  const deduped = Array.from(byName.values());
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      'DELETE FROM adp_history WHERE site = $1 AND format = $2 AND teams = $3 AND snapshot_date = $4',
      [site, format, teams, date]
    );
    await client.query(
      `INSERT INTO adp_history (site, format, teams, snapshot_date,
                                player_id, raw_name, raw_position, raw_team,
                                bye, adp, high, low, stdev, times_drafted)
       SELECT $1, $2, $3, $4::date,
              (r->>'player_id')::int, r->>'raw_name',
              COALESCE(r->>'raw_position', ''), COALESCE(r->>'raw_team', ''),
              (r->>'bye')::int, (r->>'adp')::numeric, (r->>'high')::numeric,
              (r->>'low')::numeric, (r->>'stdev')::numeric, (r->>'times_drafted')::int
       FROM jsonb_array_elements($5::jsonb) r`,
      [site, format, teams, date, JSON.stringify(deduped)]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  return deduped.length;
}

async function collectFfc(target, { force, year, index, date }) {
  const summary = { site: 'ffc', format: target.format, teams: target.teams };
  if (!force && await haveSnapshot('ffc', target.format, target.teams, date)) {
    return Object.assign(summary, { skipped: 'already collected today' });
  }
  const { rows } = await sources.fetchFfc({ format: target.format, teams: target.teams, year });
  let unmatched = 0;
  const out = rows.map((r) => {
    const m = ingest.matchRow({ name: r.name, position: r.position, team: r.team }, index);
    const ok = m.player_id && m.confidence === 'high';
    if (!ok) unmatched++;
    return {
      player_id: ok ? m.player_id : null,
      raw_name: r.name,
      raw_position: r.position,
      raw_team: r.team,
      bye: r.bye,
      adp: r.adp,
      high: r.high,
      low: r.low,
      stdev: r.stdev,
      times_drafted: r.times_drafted,
    };
  });
  const inserted = await writeSnapshot('ffc', target.format, target.teams, date, out);
  return Object.assign(summary, { inserted, unmatched });
}

async function collectSleeper({ force, year, index, date }) {
  const formats = ['standard', 'ppr', 'half', 'superflex'];
  const pending = [];
  for (const f of formats) {
    if (force || !(await haveSnapshot('sleeper', f, 0, date))) pending.push(f);
  }
  if (!pending.length) {
    return [{ site: 'sleeper', skipped: 'already collected today' }];
  }
  const { rows } = await sources.fetchSleeper({ year });

  // Exact joins by sleeper_id (players_master stores it since migration 018);
  // names only as fallback while the column backfills.
  const ids = rows.map((r) => r.sleeper_id).filter(Boolean);
  const byId = new Map();
  if (ids.length) {
    const { rows: found } = await pool.query(
      'SELECT player_id, sleeper_id FROM players_master WHERE sleeper_id = ANY($1)',
      [ids]
    );
    for (const f of found) byId.set(f.sleeper_id, f.player_id);
  }

  // Resolve each row's identity ONCE (rows are identical across formats):
  // exact sleeper_id join first, high-confidence name match as fallback.
  const resolved = new Map();
  for (const r of rows) {
    const exact = byId.get(r.sleeper_id);
    let playerId = exact === undefined ? null : exact;
    if (playerId === null) {
      const m = ingest.matchRow({ name: r.name, position: r.position, team: r.team }, index);
      playerId = (m.player_id && m.confidence === 'high') ? m.player_id : null;
    }
    resolved.set(r, playerId);
  }

  const summaries = [];
  for (const f of pending) {
    let unmatched = 0;
    const out = [];
    for (const r of rows) {
      const adp = r.adps[f];
      if (adp === undefined) continue;
      const playerId = resolved.get(r);
      if (!playerId) unmatched++;
      out.push({
        player_id: playerId,
        raw_name: r.name,
        raw_position: r.position,
        raw_team: r.team,
        bye: null, adp, high: null, low: null, stdev: null, times_drafted: null,
      });
    }
    out.sort((a, b) => a.adp - b.adp);
    const inserted = await writeSnapshot('sleeper', f, 0, date, out);
    summaries.push({ site: 'sleeper', format: f, teams: 0, inserted, unmatched });
  }
  return summaries;
}

// User-added sources (settings 'adp.custom_sources'): each is fetched through
// the custom adapter dispatcher, name-matched high-confidence-only, and stored
// under its own site slug so it appears as its own board.
async function collectCustom(entry, { force, index, date }) {
  const summary = { site: custom.identify(entry.url) ? custom.identify(entry.url).site : 'custom', url: entry.url };
  const result = await custom.fetchCustom(entry);
  if (!force && await haveSnapshot(result.site, result.format, result.teams, date)) {
    return Object.assign(summary, { format: result.format, teams: result.teams, skipped: 'already collected today' });
  }
  let unmatched = 0;
  const out = result.rows.map((r) => {
    const m = ingest.matchRow({ name: r.name, position: r.position, team: r.team }, index);
    const ok = m.player_id && m.confidence === 'high';
    if (!ok) unmatched++;
    return {
      player_id: ok ? m.player_id : null,
      raw_name: r.name, raw_position: r.position, raw_team: r.team,
      bye: r.bye, adp: r.adp, high: r.high, low: r.low, stdev: r.stdev, times_drafted: r.times_drafted,
    };
  });
  const inserted = await writeSnapshot(result.site, result.format, result.teams, date, out);
  return Object.assign(summary, { format: result.format, teams: result.teams, inserted, unmatched });
}

// Ingest a batch of ADP rows captured client-side (the Yahoo bookmarklet):
// the browser scrapes a logged-in page and POSTs the rows, so no credentials
// ever reach the server. Same match-high-confidence-only + write path as the
// server-side feeds; records the page URL so the board gets a "View source".
// Merge rows into a day's snapshot without clearing it first (ON CONFLICT
// upsert). Used by accumulate mode so a paginated source captured page-by-page
// adds up into one board instead of each click replacing the last.
async function writeSnapshotMerge(site, format, teams, date, rows) {
  const byName = new Map();
  for (const r of rows) { const prev = byName.get(r.raw_name); if (!prev || r.adp < prev.adp) byName.set(r.raw_name, r); }
  const deduped = Array.from(byName.values());
  await pool.query(
    `INSERT INTO adp_history (site, format, teams, snapshot_date,
                              player_id, raw_name, raw_position, raw_team,
                              bye, adp, high, low, stdev, times_drafted)
     SELECT $1, $2, $3, $4::date,
            (r->>'player_id')::int, r->>'raw_name',
            COALESCE(r->>'raw_position', ''), COALESCE(r->>'raw_team', ''),
            (r->>'bye')::int, (r->>'adp')::numeric, (r->>'high')::numeric,
            (r->>'low')::numeric, (r->>'stdev')::numeric, (r->>'times_drafted')::int
     FROM jsonb_array_elements($5::jsonb) r
     ON CONFLICT (site, format, teams, snapshot_date, raw_name) DO UPDATE
       SET player_id = EXCLUDED.player_id, adp = EXCLUDED.adp,
           raw_position = EXCLUDED.raw_position, raw_team = EXCLUDED.raw_team`,
    [site, format, teams, date, JSON.stringify(deduped)]
  );
  return deduped.length;
}

async function ingestSnapshot({ site, format, teams, rows, source_url, accumulate }) {
  if (!hasDb()) throw new Error('ADP capture needs a database.');
  const cleanSite = String(site || 'capture').toLowerCase().replace(/[^a-z0-9_-]+/g, '-') || 'capture';
  const fmt = custom.cleanFormat(format);
  const t = Number(teams) || 12;
  const date = today();
  const index = await master.getIndex();
  let unmatched = 0;
  const out = (Array.isArray(rows) ? rows : [])
    .filter((r) => r && r.name && Number.isFinite(Number(r.adp)) && Number(r.adp) > 0)
    .map((r) => {
      const m = ingest.matchRow({ name: r.name, position: r.position, team: r.team }, index);
      const ok = m.player_id && m.confidence === 'high';
      if (!ok) unmatched++;
      return {
        player_id: ok ? m.player_id : null,
        raw_name: String(r.name), raw_position: String(r.position || ''), raw_team: String(r.team || ''),
        bye: null, adp: Number(r.adp), high: null, low: null, stdev: null, times_drafted: null,
      };
    });
  if (!out.length) throw new Error('No usable ADP rows were sent (nothing had a name and a number).');
  // accumulate = merge into today's board (paginated captures, page by page);
  // otherwise replace the day's slice like the server-side feeds.
  const inserted = accumulate
    ? await writeSnapshotMerge(cleanSite, fmt, t, date, out)
    : await writeSnapshot(cleanSite, fmt, t, date, out);
  const { rows: cnt } = await pool.query(
    'SELECT COUNT(*)::int AS n FROM adp_history WHERE site = $1 AND format = $2 AND teams = $3 AND snapshot_date = $4',
    [cleanSite, fmt, t, date]
  );
  const total = cnt[0].n;
  if (source_url) {
    const map = (await settings.get('adp.source_urls', {})) || {};
    map[cleanSite] = String(source_url);
    await settings.set('adp.source_urls', map);
  }
  await settings.set('adp.last_capture', {
    at: new Date().toISOString(), site: cleanSite, format: fmt, teams: t, inserted, unmatched, total,
  });
  return { site: cleanSite, format: fmt, teams: t, inserted, unmatched, total };
}

// Collect everything that's due. Never called twice concurrently (inflight guard).
let inflight = null;

async function collectNow({ force = false } = {}) {
  if (!hasDb()) throw new Error('ADP collection needs a database (DATABASE_URL is not set).');
  if (inflight) return inflight;
  inflight = (async () => {
    await master.ensureSeeded(); // first boot: match against a seeded registry
    const year = await settings.get('adp.year', null);
    const index = await master.getIndex();
    const date = today();
    const summaries = [];
    for (const target of await ffcTargets()) {
      try {
        summaries.push(await collectFfc(target, { force, year, index, date }));
      } catch (err) {
        console.error(`adp: ffc ${target.format}/${target.teams} failed: ${err.message}`);
        summaries.push({ site: 'ffc', format: target.format, teams: target.teams, error: err.message });
      }
    }
    try {
      summaries.push(...await collectSleeper({ force, year, index, date }));
    } catch (err) {
      console.error(`adp: sleeper collect failed: ${err.message}`);
      summaries.push({ site: 'sleeper', error: err.message });
    }
    const customSources = await settings.get('adp.custom_sources', []);
    for (const entry of (Array.isArray(customSources) ? customSources : [])) {
      if (!entry || !entry.url || entry.enabled === false) continue;
      try {
        summaries.push(await collectCustom(entry, { force, index, date }));
      } catch (err) {
        console.error(`adp: custom source ${entry.url} failed: ${err.message}`);
        summaries.push({ site: 'custom', url: entry.url, error: err.message });
      }
    }
    try {
      await settings.set('adp.last_run', { at: new Date().toISOString(), summary: summaries });
    } catch (err) {
      console.error(`adp: could not record last run: ${err.message}`);
    }
    return summaries;
  })().finally(() => { inflight = null; });
  return inflight;
}

// Boot/interval hook — never throws, never blocks boot (like players_master).
async function ensureCollected() {
  try {
    if (!hasDb()) return;
    const auto = await settings.get('adp.auto', true);
    if (auto === false) return;
    await collectNow({ force: false });
  } catch (err) {
    console.error(`adp: scheduled collect failed: ${err.message}`);
  }
}

module.exports = { collectNow, ensureCollected, ffcTargets, ingestSnapshot };
