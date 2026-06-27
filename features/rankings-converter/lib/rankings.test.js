// Tests for the rankings text parser. Run with: node --test
// Covers the two input shapes (space- and comma-delimited), defense rows, header
// rejection, and the position/team-aware dedupe (so two different players who
// normalize to the same name aren't collapsed).
const test = require('node:test');
const assert = require('node:assert');
const { parse } = require('./rankings');

test('parses space-delimited "rank name POS TEAM" rows in list order', () => {
  const { players: out } = parse('1 Bijan Robinson RB ATL\n2 Justin Jefferson WR MIN');
  assert.equal(out.length, 2);
  assert.deepEqual(
    { name: out[0].name, position: out[0].position, team: out[0].team, rank: out[0].rank },
    { name: 'Bijan Robinson', position: 'RB', team: 'ATL', rank: 1 }
  );
  assert.equal(out[1].rank, 2);
});

test('parses comma-delimited rows and detects a defense row', () => {
  const { players: out } = parse('1 Bijan Robinson, ATL, 5\nPhiladelphia Eagles, PHI, 9');
  assert.equal(out.length, 2);
  assert.equal(out[0].name, 'Bijan Robinson');
  assert.equal(out[1].position, 'DST');
  assert.equal(out[1].team, 'PHI');
});

test('keeps two players who share a name key but differ by team', () => {
  const { players: out } = parse('1 Michael Carter RB NYJ\n2 Michael Carter S ARI');
  assert.equal(out.length, 2);
});

test('dedupes the same player listed twice on the same team', () => {
  const { players: out, unparsed } = parse('1 Bijan Robinson RB ATL\n2 Bijan Robinson RB ATL');
  assert.equal(out.length, 1);
  assert.ok(unparsed.some((u) => /duplicate/.test(u.reason)));
});

test('a header row goes to unparsed, never to players', () => {
  const { players: out } = parse('Rank Player Pos Team\n1 Bijan Robinson RB ATL');
  assert.equal(out.length, 1);
  assert.equal(out[0].name, 'Bijan Robinson');
});
