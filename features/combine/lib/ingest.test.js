// Tests for the matching pipeline (pure: takes a players_master-shaped index).
const test = require('node:test');
const assert = require('node:assert');
const players = require('../../../lib/players');
const { matchRows, reviewSummary } = require('./ingest');

const MASTER = [
  { player_id: 1, name: "Ja'Marr Chase", position: 'WR', team: 'CIN' },
  { player_id: 2, name: 'Bijan Robinson', position: 'RB', team: 'ATL' },
  { player_id: 3, name: 'Justin Jefferson', position: 'WR', team: 'MIN' },
  { player_id: 4, name: 'Philadelphia Eagles', position: 'DST', team: 'PHI' },
  { player_id: 5, name: 'Michael Carter', position: 'RB', team: 'ARI' },
];
const index = players.buildNameIndex(MASTER);

test('exact and OCR-garbled names resolve to player ids with rank = list order', () => {
  const rows = matchRows([
    { name: 'Jamarr Chase', position: 'WR', team: 'CIN' },   // punctuation variant
    { name: 'BijanRobinson' },                               // missing space
    { name: 'Justin Jefferson' },
  ], index);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((r) => r.player_id), [1, 2, 3]);
  assert.deepEqual(rows.map((r) => r.rank), [1, 2, 3]);
  assert.equal(rows[0].name, "Ja'Marr Chase");   // canonical spelling wins
  assert.equal(rows[1].position, 'RB');          // filled from master
});

test('a team-only row resolves as that team defense', () => {
  const rows = matchRows([{ name: 'Eagles DST' }], index);
  assert.equal(rows[0].player_id, 4);
  assert.equal(rows[0].position, 'DST');
  assert.equal(rows[0].team, 'PHI');
});

test('a position conflict downgrades confidence instead of silently matching', () => {
  const rows = matchRows([{ name: 'Michael Carter', position: 'WR' }], index);
  assert.equal(rows[0].player_id, 5);
  assert.notEqual(rows[0].confidence, 'high');
});

test('unknown players come back unmatched, never guessed', () => {
  const rows = matchRows([{ name: 'Zeke Fakeplayer' }], index);
  assert.equal(rows[0].player_id, null);
  assert.equal(rows[0].confidence, 'none');
  assert.equal(rows[0].name, 'Zeke Fakeplayer');
});

test('startRank continues numbering for appended screenshots', () => {
  const rows = matchRows([{ name: 'Justin Jefferson' }], index, 51);
  assert.equal(rows[0].rank, 51);
});

test('optional auction value passes through the pipeline (null when absent)', () => {
  const rows = matchRows([
    { name: 'Bijan Robinson', auction_value: 52 },
    { name: 'Justin Jefferson' },              // no value -> null
    { name: 'CeeDee Lamb', auction_value: '' }, // blank -> null
  ], index);
  assert.equal(rows[0].auction_value, 52);
  assert.equal(rows[1].auction_value, null);
  assert.equal(rows[2].auction_value, null);
});

test('reviewSummary counts unmatched and uncertain rows', () => {
  const rows = matchRows([
    { name: "Ja'Marr Chase" },
    { name: 'Michael Carter', position: 'WR' },  // downgraded
    { name: 'Zeke Fakeplayer' },                 // unmatched
  ], index);
  const s = reviewSummary(rows);
  assert.equal(s.total, 3);
  assert.equal(s.unmatched, 1);
  assert.equal(s.uncertain, 1);
});
