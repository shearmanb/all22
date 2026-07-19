// News aggregator core: fetch each source's feed, cache items in Postgres,
// and read them back grouped by source for The Wire page. One slow or broken
// source must never take down the others or the page, so every fetch is
// time-boxed and failures are recorded as per-source status, never thrown to
// the caller.
//
// The source list is OWNER-EDITABLE (Settings → News sources): it lives in the
// settings table under `news.sources`, seeded once from lib/news/sources.js.
// Everything downstream reads the current list via getSources(), so adding or
// dropping a site never needs a code edit.

const pool = require('../../db/pool');
const settings = require('../settings');
const DEFAULT_SOURCES = require('./sources');
const { parseFeed } = require('./feed');
const { coerceList, validateList } = require('./normalize');

const SOURCES_KEY = 'news.sources';
const FETCH_TIMEOUT_MS = 8000;
const REFRESH_TTL_MS = 20 * 60 * 1000; // refresh a source at most ~every 20 min
const MAX_ITEMS_PER_SOURCE = 12;        // how many to keep/show per source

// Browser-ish identification; bare scripts are often blocked outright.
const FETCH_HEADERS = {
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
};

// ---------------------------------------------------------------------------
// The editable source list, stored in settings and seeded from the defaults.
// ---------------------------------------------------------------------------

// Read the owner's current source list. Seeds the defaults on FIRST use only
// (when the key has never been set) — an explicit empty list is respected, so
// deleting every source doesn't resurrect the defaults on the next page load.
async function getSources() {
  const stored = await settings.get(SOURCES_KEY, null);
  if (stored === null || stored === undefined) {
    const seed = coerceList(DEFAULT_SOURCES);
    try { await settings.set(SOURCES_KEY, seed); } catch (e) { /* no DB — use defaults in-memory */ }
    return seed;
  }
  return coerceList(stored);
}

// Save an edited source list (validates loudly, then persists). Returns the
// normalized rows so the UI can re-render with assigned keys.
async function setSources(list) {
  const clean = validateList(list);
  await settings.set(SOURCES_KEY, clean);
  return clean;
}

async function getSource(key) {
  const sources = await getSources();
  return sources.find((s) => s.key === key) || null;
}

async function fetchText(url) {
  const res = await fetch(url, {
    headers: FETCH_HEADERS,
    redirect: 'follow',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

// Fetch + parse a feed URL and report what came back, WITHOUT caching it — the
// "Test" button in Settings uses this so the owner can confirm a feed works
// before saving the source.
async function testFeed(feedUrl) {
  const url = String(feedUrl || '').trim();
  if (!/^https?:\/\//i.test(url)) throw new Error('Enter a feed URL starting with http:// or https://');
  const xml = await fetchText(url);
  const items = parseFeed(xml, { max: MAX_ITEMS_PER_SOURCE }).filter((it) => it.guid);
  return {
    count: items.length,
    sample: items.slice(0, 3).map((it) => ({ title: it.title, publishedAt: it.publishedAt })),
  };
}

async function recordStatus(key, ok, error) {
  await pool.query(
    `INSERT INTO news_source_status (source_key, last_fetched_at, last_ok, last_error, updated_at)
     VALUES ($1, now(), $2, $3, now())
     ON CONFLICT (source_key) DO UPDATE
       SET last_fetched_at = now(), last_ok = $2, last_error = $3, updated_at = now()`,
    [key, ok, error || null]
  );
}

// Fetch + parse + cache a single source. Returns the number of items stored,
// or records an error status and returns 0. Never throws — callers refresh
// many sources and want partial success.
async function refreshSource(source) {
  if (source.kind !== 'rss' || !source.feedUrl) return 0; // 'link' tiles have nothing to fetch
  try {
    const xml = await fetchText(source.feedUrl);
    const items = parseFeed(xml, { max: MAX_ITEMS_PER_SOURCE }).filter((it) => it.guid);
    for (const it of items) {
      await pool.query(
        `INSERT INTO news_items
           (source_key, guid, title, url, summary, author, published_at, fetched_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7, now())
         ON CONFLICT (source_key, guid) DO UPDATE
           SET title = EXCLUDED.title,
               url = EXCLUDED.url,
               summary = EXCLUDED.summary,
               author = EXCLUDED.author,
               published_at = COALESCE(EXCLUDED.published_at, news_items.published_at),
               fetched_at = now()`,
        [source.key, it.guid, it.title, it.url, it.summary || null, it.author || null, it.publishedAt]
      );
    }
    await recordStatus(source.key, true, null);
    return items.length;
  } catch (err) {
    console.error(`news refresh ${source.key}: ${err.message}`);
    await recordStatus(source.key, false, err.message).catch(() => {});
    return 0;
  }
}

// Refresh every feed source in parallel. Resolves once all settle.
async function refreshAll() {
  const sources = await getSources();
  await Promise.allSettled(sources.map((s) => refreshSource(s)));
}

// Refresh only feed sources whose cache is older than the TTL (or never
// fetched). Keeps page loads from hammering the sites on every visit.
async function refreshIfStale(ttlMs = REFRESH_TTL_MS) {
  const sources = await getSources();
  const feeds = sources.filter((s) => s.kind === 'rss' && s.feedUrl);
  if (!feeds.length) return;
  const { rows } = await pool.query(
    'SELECT source_key, last_fetched_at FROM news_source_status'
  );
  const lastByKey = new Map(rows.map((r) => [r.source_key, r.last_fetched_at]));
  const cutoff = Date.now() - ttlMs;
  const stale = feeds.filter((s) => {
    const last = lastByKey.get(s.key);
    return !last || new Date(last).getTime() < cutoff;
  });
  await Promise.allSettled(stale.map((s) => refreshSource(s)));
}

// Read the cached news back, grouped by source in display order, with each
// source's latest fetch status attached.
async function getNews() {
  const sources = await getSources();
  const keys = sources.map((s) => s.key);
  if (!keys.length) return [];

  const [{ rows: items }, { rows: statuses }] = await Promise.all([
    pool.query(
      `SELECT source_key, title, url, summary, author, published_at
         FROM news_items
        WHERE source_key = ANY($1)
        ORDER BY published_at DESC NULLS LAST, fetched_at DESC`,
      [keys]
    ),
    pool.query('SELECT * FROM news_source_status WHERE source_key = ANY($1)', [keys]),
  ]);

  const itemsByKey = new Map();
  for (const it of items) {
    const list = itemsByKey.get(it.source_key) || [];
    if (list.length < MAX_ITEMS_PER_SOURCE) {
      list.push({
        title: it.title,
        url: it.url,
        summary: it.summary,
        author: it.author,
        publishedAt: it.published_at,
      });
    }
    itemsByKey.set(it.source_key, list);
  }
  const statusByKey = new Map(statuses.map((s) => [s.source_key, s]));

  return sources.map((s) => {
    const status = statusByKey.get(s.key);
    return {
      key: s.key,
      name: s.name,
      siteUrl: s.siteUrl,
      kind: s.kind,
      items: itemsByKey.get(s.key) || [],
      lastFetchedAt: status ? status.last_fetched_at : null,
      lastOk: status ? status.last_ok : null,
      lastError: status && !status.last_ok ? status.last_error : null,
    };
  });
}

module.exports = {
  getNews,
  refreshAll,
  refreshIfStale,
  refreshSource,
  getSource,
  getSources,
  setSources,
  testFeed,
  SOURCES_KEY,
};
