// autopull.js — scheduled rankings pulls. The owner lists FantasyPros
// rankings URLs in settings 'combine.auto_pull' (managed on the Combine page);
// once a day each one is fetched, matched through the normal ingest pipeline,
// and saved as a new dated set — exactly as if he'd pasted it, review queue
// and all. Skips a URL when a set with the same source + format was already
// captured today (manual or automatic), so it never spams duplicates.
//
// Entry shape: { url, source?, format?, scope?, enabled? } — overrides beat
// what the URL itself implies (inferMeta). Results of the last sweep land in
// settings 'combine.auto_pull.last' for the page + data health to show.
const pool = require('../../../db/pool');
const settings = require('../../../lib/settings');
const master = require('../../../lib/players-master');
const fetchRankings = require('./fetch-rankings');
const ingest = require('./ingest');
const store = require('./store');

const hasDb = () => Boolean(process.env.DATABASE_URL);

function today() {
  return new Date().toISOString().slice(0, 10);
}

async function alreadyCapturedToday(source, format, date) {
  const { rows } = await pool.query(
    `SELECT 1 FROM ranking_sets
     WHERE source = $1 AND native_scoring_format = $2 AND captured_on = $3
     LIMIT 1`,
    [source, format, date]
  );
  return rows.length > 0;
}

async function pullOne(entry, { force, index, date }) {
  const inferred = fetchRankings.inferMeta(entry.url);
  const source = (entry.source && String(entry.source).trim()) || inferred.source;
  const format = store.cleanFormat(entry.format || inferred.format);
  const result = { url: entry.url, source, format };
  if (!force && await alreadyCapturedToday(source, format, date)) {
    return Object.assign(result, { skipped: 'already captured today' });
  }
  const { rows, meta } = await fetchRankings.fetchRankings(entry.url);
  const matched = ingest.matchRows(rows, index);
  const set = await store.createSet({
    name: `${source} ${format} ${date}`,
    source,
    native_scoring_format: format,
    ranking_scope: entry.scope || meta.scope,
    captured_on: date,
    notes: `Auto-pulled from ${meta.url}` +
      (meta.total_experts ? ` (${meta.total_experts} experts)` : ''),
  }, matched);
  const review = ingest.reviewSummary(matched);
  return Object.assign(result, { set_id: set.id, rows: matched.length, unmatched: review.unmatched, uncertain: review.uncertain });
}

// Run every configured pull that's due. Never throws; per-URL errors are
// captured in the results and logged.
let inflight = null;

async function runPulls({ force = false } = {}) {
  if (!hasDb()) return [];
  if (inflight) return inflight;
  inflight = (async () => {
    const entries = await settings.get('combine.auto_pull', []);
    const list = (Array.isArray(entries) ? entries : []).filter((e) => e && e.url && e.enabled !== false);
    if (!list.length) return [];
    await master.ensureSeeded();
    const index = await master.getIndex();
    const date = today();
    const results = [];
    for (const entry of list) {
      try {
        results.push(await pullOne(entry, { force, index, date }));
      } catch (err) {
        console.error(`combine: auto-pull ${entry.url} failed: ${err.message}`);
        results.push({ url: entry.url, error: err.message });
      }
    }
    try {
      await settings.set('combine.auto_pull.last', { at: new Date().toISOString(), results });
    } catch (err) {
      console.error(`combine: could not record auto-pull results: ${err.message}`);
    }
    return results;
  })().finally(() => { inflight = null; });
  return inflight;
}

// Boot/interval hook — quiet no-op when nothing is configured.
async function ensurePulled() {
  try {
    await runPulls({ force: false });
  } catch (err) {
    console.error(`combine: scheduled auto-pull failed: ${err.message}`);
  }
}

module.exports = { runPulls, ensurePulled };
