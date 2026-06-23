// Offline tests for the feed parser. Run with: node --test lib/news/feed.test.js
// No live network needed — these exercise the parser against representative
// RSS 2.0 and Atom 1.0 samples covering the messy bits (CDATA, entities,
// namespaced tags, HTML summaries, permalink guids, attribute-based links).

const test = require('node:test');
const assert = require('node:assert');
const { parseFeed } = require('./feed');

const RSS_SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>BEAST DOME Fantasy Football</title>
    <link>https://www.beastdome.com/</link>
    <item>
      <title><![CDATA[Week 1 Studs &amp; Duds]]></title>
      <link>https://www.beastdome.com/week-1-studs-duds/</link>
      <pubDate>Wed, 03 Sep 2025 14:30:00 +0000</pubDate>
      <dc:creator><![CDATA[Beast]]></dc:creator>
      <guid isPermaLink="false">https://www.beastdome.com/?p=12345</guid>
      <description><![CDATA[<p>Here are the <strong>top plays</strong> for Week&nbsp;1.</p>]]></description>
      <content:encoded><![CDATA[<p>Full article body that we ignore for the teaser.</p>]]></content:encoded>
    </item>
    <item>
      <title>No-link entry uses permalink guid</title>
      <pubDate>Tue, 02 Sep 2025 09:00:00 +0000</pubDate>
      <guid isPermaLink="true">https://www.beastdome.com/permalink-item/</guid>
      <description>Plain text summary with an &amp; ampersand.</description>
    </item>
  </channel>
</rss>`;

const ATOM_SAMPLE = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>NBC Sports Fantasy</title>
  <link rel="self" href="https://example.com/feed.atom"/>
  <entry>
    <title>Star RB questionable for Sunday</title>
    <link rel="alternate" href="https://www.nbcsports.com/fantasy/football/news/star-rb"/>
    <link rel="self" href="https://www.nbcsports.com/api/entry/1"/>
    <id>tag:nbcsports.com,2025:/news/star-rb</id>
    <published>2025-09-03T18:45:00Z</published>
    <author><name>Rotoworld Staff</name></author>
    <summary type="html">&lt;p&gt;The back is &lt;em&gt;questionable&lt;/em&gt; with a knee issue.&lt;/p&gt;</summary>
  </entry>
</feed>`;

test('parses RSS items with CDATA, entities, and namespaced tags', () => {
  const items = parseFeed(RSS_SAMPLE);
  assert.equal(items.length, 2);

  const a = items[0];
  assert.equal(a.title, 'Week 1 Studs & Duds');
  assert.equal(a.url, 'https://www.beastdome.com/week-1-studs-duds/');
  assert.equal(a.author, 'Beast');
  assert.equal(a.guid, 'https://www.beastdome.com/?p=12345');
  // Summary comes from <description>, HTML stripped, entities decoded.
  assert.equal(a.summary, 'Here are the top plays for Week 1.');
  assert.ok(a.publishedAt instanceof Date);
  assert.equal(a.publishedAt.toISOString(), '2025-09-03T14:30:00.000Z');
});

test('RSS item without <link> falls back to a permalink guid', () => {
  const items = parseFeed(RSS_SAMPLE);
  const b = items[1];
  assert.equal(b.url, 'https://www.beastdome.com/permalink-item/');
  assert.equal(b.summary, 'Plain text summary with an & ampersand.');
});

test('parses Atom entries and prefers rel="alternate" links', () => {
  const items = parseFeed(ATOM_SAMPLE);
  assert.equal(items.length, 1);

  const e = items[0];
  assert.equal(e.title, 'Star RB questionable for Sunday');
  assert.equal(e.url, 'https://www.nbcsports.com/fantasy/football/news/star-rb');
  assert.equal(e.author, 'Rotoworld Staff');
  assert.equal(e.guid, 'tag:nbcsports.com,2025:/news/star-rb');
  assert.equal(e.summary, 'The back is questionable with a knee issue.');
  assert.equal(e.publishedAt.toISOString(), '2025-09-03T18:45:00.000Z');
});

test('respects the max-item cap', () => {
  const items = parseFeed(RSS_SAMPLE, { max: 1 });
  assert.equal(items.length, 1);
});

test('returns [] for junk or empty input', () => {
  assert.deepEqual(parseFeed(''), []);
  assert.deepEqual(parseFeed('<html><body>not a feed</body></html>'), []);
  assert.deepEqual(parseFeed(null), []);
});
