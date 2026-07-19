// Unit tests for the pure news-source normalizer. No DB, no network. Run with:
//   node --test lib/news/normalize.test.js
// These guard the rules the owner relies on when editing sources in Settings:
// a feed URL makes a source list headlines, no feed makes it a link tile, keys
// stay unique and stable, and a bad row is rejected loudly (not dropped).

const test = require('node:test');
const assert = require('node:assert');
const { slugify, normalizeSource, coerceList, validateList } = require('./normalize');

test('slugify makes a stable, url-safe key', () => {
  assert.equal(slugify('NBC · Rotoworld Player News'), 'nbc-rotoworld-player-news');
  assert.equal(slugify('  FantasyPoints!!  '), 'fantasypoints');
  assert.equal(slugify(''), '');
});

test('kind is derived: a feed URL means rss, no feed means link', () => {
  const rss = normalizeSource({ name: 'Beast', siteUrl: 'https://b.com', feedUrl: 'https://b.com/feed' });
  assert.equal(rss.kind, 'rss');
  assert.equal(rss.feedUrl, 'https://b.com/feed');

  const link = normalizeSource({ name: 'Paywalled', siteUrl: 'https://p.com' });
  assert.equal(link.kind, 'link');
  assert.equal(link.feedUrl, null);
});

test('a non-http feed URL is treated as no feed (link tile)', () => {
  const s = normalizeSource({ name: 'X', siteUrl: 'https://x.com', feedUrl: 'not-a-url' });
  assert.equal(s.kind, 'link');
  assert.equal(s.feedUrl, null);
});

test('coerceList drops rows missing a name or a real site URL', () => {
  const out = coerceList([
    { name: 'Good', siteUrl: 'https://good.com' },
    { name: '', siteUrl: 'https://noname.com' },
    { name: 'No URL', siteUrl: '' },
    { name: 'Bad URL', siteUrl: 'ftp://nope' },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].name, 'Good');
});

test('coerceList keeps keys unique when names collide', () => {
  const out = coerceList([
    { name: 'Rotoworld', siteUrl: 'https://a.com' },
    { name: 'Rotoworld', siteUrl: 'https://b.com' },
    { name: 'Rotoworld', siteUrl: 'https://c.com' },
  ]);
  assert.deepEqual(out.map((s) => s.key), ['rotoworld', 'rotoworld-2', 'rotoworld-3']);
});

test('an explicit key is preserved (so cached headlines stay attached on edit)', () => {
  const out = coerceList([{ key: 'beastdome', name: 'BEAST DOME renamed', siteUrl: 'https://x.com' }]);
  assert.equal(out[0].key, 'beastdome');
});

test('validateList throws a helpful error on a missing name', () => {
  assert.throws(() => validateList([{ name: '', siteUrl: 'https://x.com' }]), /needs a name/i);
});

test('validateList throws on a non-http site URL', () => {
  assert.throws(() => validateList([{ name: 'X', siteUrl: 'x.com' }]), /site URL must start with http/i);
});

test('validateList throws on a present-but-bad feed URL', () => {
  assert.throws(
    () => validateList([{ name: 'X', siteUrl: 'https://x.com', feedUrl: 'feed' }]),
    /feed URL must start with http/i
  );
});

test('validateList accepts a good list and returns normalized rows', () => {
  const out = validateList([
    { name: 'Beast', siteUrl: 'https://b.com', feedUrl: 'https://b.com/feed' },
    { name: 'Paywalled', siteUrl: 'https://p.com', feedUrl: '' },
  ]);
  assert.equal(out.length, 2);
  assert.equal(out[0].kind, 'rss');
  assert.equal(out[1].kind, 'link');
});
