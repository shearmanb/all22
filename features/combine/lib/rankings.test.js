// Tests for the rankings text parser. Run with: node --test
// Covers the two input shapes (space- and comma-delimited), defense rows, header
// rejection, and the position/team-aware dedupe (so two different players who
// normalize to the same name aren't collapsed).
const test = require('node:test');
const assert = require('node:assert');
const { parse, looksTabular } = require('./rankings');

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

test('captures $-prefixed auction values (Yahoo/FantasyPros value tables)', () => {
  const { players: out } = parse([
    '1 Bijan Robinson RB ATL $58',
    '2 Justin Jefferson, MIN, 6, $52.5',
    'Josh Allen QB BUF $41',
    '4 Derrick Henry RB BAL', // no value on this row
  ].join('\n'));
  assert.equal(out.length, 4);
  assert.deepEqual(out.map((p) => p.auction_value), [58, 52.5, 41, null]);
  assert.equal(out[0].name, 'Bijan Robinson'); // the $ token never bleeds into the name
  assert.equal(out[2].position, 'QB');
});

test('junks value-table header rows like "Player Avg Cost % Drafted"', () => {
  const { players: out, unparsed } = parse('Player Avg Pick Avg Cost % Drafted\n1 Bijan Robinson RB ATL $58');
  assert.equal(out.length, 1);
  assert.equal(unparsed.length, 1);
});

test('position-block headers stamp the rows beneath them, never become players', () => {
  const text = [
    'QB',
    '1. Josh Allen, BUF',
    '2. Lamar Jackson, BAL',
    'Wide Receivers',
    "1. Ja'Marr Chase, CIN",
    'RBs',
    '1. Christian McCaffrey, SF',
  ].join('\n');
  const { players: out, position_blocks } = parse(text);
  assert.deepEqual(position_blocks, ['QB', 'WR', 'RB']);
  assert.deepEqual(
    out.map((p) => ({ name: p.name, position: p.position })),
    [
      { name: 'Josh Allen', position: 'QB' },
      { name: 'Lamar Jackson', position: 'QB' },
      { name: "Ja'Marr Chase", position: 'WR' },
      { name: 'Christian McCaffrey', position: 'RB' },
    ]
  );
  // Rank is still overall paste order — position rank is derived downstream.
  assert.deepEqual(out.map((p) => p.rank), [1, 2, 3, 4]);
});

test('"QB Rankings" / "Tier 1 RBs" style headers are recognized too', () => {
  const { players: out } = parse('QB Rankings\n1 Josh Allen BUF\nTier 1 RBs\n1 Bijan Robinson ATL');
  assert.deepEqual(out.map((p) => p.position), ['QB', 'RB']);
});

test('a row that prints its own position wins over the block header', () => {
  const { players: out } = parse('RB\n1 Taysom Hill TE NO');
  assert.equal(out[0].position, 'TE');
});

test('D/ST header stamps DST and defense rows still resolve by team', () => {
  const { players: out } = parse('D/ST\n1. Philadelphia Eagles, PHI\n2. Baltimore Ravens, BAL');
  assert.deepEqual(out.map((p) => p.position), ['DST', 'DST']);
  assert.deepEqual(out.map((p) => p.team), ['PHI', 'BAL']);
});

test('pastes without headers keep working exactly as before', () => {
  const { players: out, position_blocks } = parse('1 Bijan Robinson RB ATL\n2 Justin Jefferson WR MIN');
  assert.deepEqual(out.map((p) => p.position), ['RB', 'WR']);
  assert.deepEqual(position_blocks, []);
});

test('a spreadsheet paste (tab-separated columns) strips rank, bye and $ off the name', () => {
  const text = [
    'OVERALL\tNAME\tPosition\tTeam\tBYE\t$$$',
    '1\tJahmyr Gibbs\tRB\tDET\t6\t$60 ',
    '2\tBijan Robinson\tRB\tATL\t11\t$59 ',
    "4\tJa'Marr Chase\tWR\tCIN\t6\t$54 ",
    '6\tAmon-Ra St. Brown\tWR\tDET\t6\t$47 ',
  ].join('\n');
  const { players: out, unparsed } = parse(text);
  assert.deepEqual(out.map((p) => p.name),
    ['Jahmyr Gibbs', 'Bijan Robinson', "Ja'Marr Chase", 'Amon-Ra St. Brown']);
  assert.deepEqual(out.map((p) => p.position), ['RB', 'RB', 'WR', 'WR']);
  assert.deepEqual(out.map((p) => p.team), ['DET', 'ATL', 'CIN', 'DET']);
  assert.deepEqual(out.map((p) => p.auction_value), [60, 59, 54, 47]);
  // Rank is list order, not the printed OVERALL column (which skips 3 and 5).
  assert.deepEqual(out.map((p) => p.rank), [1, 2, 3, 4]);
  assert.deepEqual(unparsed, []);
});

test('a spreadsheet paste with no header row still finds the columns', () => {
  const { players: out } = parse('1\tJahmyr Gibbs\tRB\tDET\t6\t$60\n2\tBijan Robinson\tRB\tATL\t11\t$59');
  assert.deepEqual(out.map((p) => p.name), ['Jahmyr Gibbs', 'Bijan Robinson']);
  assert.deepEqual(out.map((p) => p.team), ['DET', 'ATL']);
  assert.deepEqual(out.map((p) => p.auction_value), [60, 59]);
});

test('a notes column rides along with the player', () => {
  const text = [
    'Rank\tPlayer\tPos\tTeam\tNotes',
    '1\tJahmyr Gibbs\tRB\tDET\tElite dual-threat, locked top pick',
    '2\tBijan Robinson\tRB\tATL\t',
  ].join('\n');
  const { players: out } = parse(text);
  assert.equal(out[0].notes, 'Elite dual-threat, locked top pick');
  assert.equal(out[1].notes, null);
});

test('a trailing bye week no longer glues itself to the name', () => {
  const { players: out } = parse('1 Jahmyr Gibbs RB DET 6\n2 Bijan Robinson RB ATL 11');
  assert.deepEqual(out.map((p) => p.name), ['Jahmyr Gibbs', 'Bijan Robinson']);
});

test('looksTabular only fires on genuinely tab-separated pastes', () => {
  assert.equal(looksTabular('1 Bijan Robinson RB ATL\n2 Justin Jefferson WR MIN'), false);
  assert.equal(looksTabular('1\tBijan Robinson\tATL\n2\tJustin Jefferson\tMIN'), true);
});
