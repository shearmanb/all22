// lib/news/normalize.js — pure helpers for the editable news-source list.
//
// The owner manages the sites The Wire follows in the Settings panel. These
// functions turn raw UI rows into the canonical stored shape and guard their
// validity. No DB, no network — unit-tested so a bad edit can't silently
// produce an empty or broken source. Kept separate from index.js (which needs
// the DB) exactly so these stay pure and testable, mirroring lib/ecr.js.

// A stable, url-safe key derived from a source's name (or an explicit key).
// The key ties a source to its cached headlines, so we keep it steady.
function slugify(s) {
  return String(s == null ? '' : s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

const isHttp = (u) => /^https?:\/\//i.test(String(u || '').trim());

// Turn one raw row into the canonical stored shape. `kind` is DERIVED, never
// hand-set: a source with a usable feed URL lists headlines ('rss'); without
// one it shows a single "open the site" tile ('link'). This is the feed-first
// rule the original hardcoded list followed, now applied to owner-added sites.
function normalizeSource(raw) {
  raw = raw || {};
  const name = String(raw.name || '').trim();
  const siteUrl = String(raw.siteUrl || '').trim();
  const feedRaw = String(raw.feedUrl || '').trim();
  const feedUrl = isHttp(feedRaw) ? feedRaw : null;
  return {
    key: slugify(raw.key || name) || 'source',
    name,
    siteUrl,
    feedUrl,
    kind: feedUrl ? 'rss' : 'link',
  };
}

// Ensure every key in the list is unique (append -2, -3, … on collision), so
// two sites named alike can't clobber each other's cached items.
function dedupeKeys(list) {
  const seen = new Set();
  for (const s of list) {
    const base = s.key || 'source';
    let k = base;
    let n = 2;
    while (seen.has(k)) { k = base + '-' + n; n++; }
    seen.add(k);
    s.key = k;
  }
  return list;
}

// Lenient read path: coerce whatever is stored (or the seed defaults) into
// valid rows, dropping any that lack a name or a real site URL. Never throws —
// a hand-corrupted settings row degrades to "that one source vanished", not a
// dead page.
function coerceList(list) {
  const rows = (Array.isArray(list) ? list : [])
    .map(normalizeSource)
    .filter((s) => s.name && isHttp(s.siteUrl));
  return dedupeKeys(rows);
}

// Strict write path: throw a human-readable error on any bad row so a bad save
// lands in the UI error banner instead of silently discarding a site. Returns
// the same normalized rows coerceList would.
function validateList(list) {
  if (!Array.isArray(list)) throw new Error('Sources must be a list.');
  for (const raw of list) {
    const name = String((raw && raw.name) || '').trim();
    const siteUrl = String((raw && raw.siteUrl) || '').trim();
    const feed = String((raw && raw.feedUrl) || '').trim();
    if (!name) throw new Error('Every source needs a name.');
    if (!isHttp(siteUrl)) throw new Error(`"${name}": the site URL must start with http:// or https://`);
    if (feed && !isHttp(feed)) {
      throw new Error(`"${name}": the feed URL must start with http:// or https:// (or leave it blank for a link-only tile).`);
    }
  }
  return coerceList(list);
}

module.exports = { slugify, normalizeSource, dedupeKeys, coerceList, validateList };
