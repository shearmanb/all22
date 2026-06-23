// Config-invariant tests for the news source list. Run with:
//   node --test lib/news/sources.test.js
// These don't touch the network — they guard the shape of sources.js so a
// future edit can't, say, mark a source 'rss' but forget its feed URL (which
// would silently fetch nothing and show an empty card forever).

const test = require('node:test');
const assert = require('node:assert');
const SOURCES = require('./sources');

test('every source has a key, name, siteUrl, and valid kind', () => {
  assert.ok(Array.isArray(SOURCES) && SOURCES.length > 0);
  for (const s of SOURCES) {
    assert.ok(s.key, 'source missing key');
    assert.ok(s.name, `${s.key}: missing name`);
    assert.match(s.siteUrl || '', /^https?:\/\//, `${s.key}: siteUrl must be http(s)`);
    assert.ok(s.kind === 'rss' || s.kind === 'link', `${s.key}: kind must be rss|link`);
  }
});

test('source keys are unique', () => {
  const keys = SOURCES.map((s) => s.key);
  assert.equal(new Set(keys).size, keys.length, 'duplicate source key');
});

test("'rss' sources have a feed URL; 'link' sources do not", () => {
  for (const s of SOURCES) {
    if (s.kind === 'rss') {
      assert.match(s.feedUrl || '', /^https?:\/\//, `${s.key}: rss source needs an http(s) feedUrl`);
    } else {
      assert.ok(!s.feedUrl, `${s.key}: link source must not carry a feedUrl`);
    }
  }
});
