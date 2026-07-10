// Golden tests for Edge Rush's source parsers (fixtures mirror the real
// payload shapes verified against both APIs).
const test = require('node:test');
const assert = require('node:assert');
const { parseFfc, parseSleeper, clampTeams, seasonYear } = require('./sources');

test('parseFfc normalizes players and keeps the distribution fields', () => {
  const { rows, meta } = parseFfc({
    status: 'Success',
    meta: { type: 'PPR', teams: 12, total_drafts: 1587, start_date: '2026-06-06', end_date: '2026-07-08' },
    players: [
      { player_id: 2434, name: 'Christian McCaffrey', position: 'RB', team: 'SF', adp: 1.3, adp_formatted: '1.01', times_drafted: 351, high: 1, low: 4, stdev: 0.6, bye: 9 },
      { player_id: 9999, name: 'Denver Defense', position: 'DEF', team: 'DEN', adp: 140.1, high: 120, low: 160, stdev: 8.2, times_drafted: 40, bye: 14 },
      { player_id: 1, name: '', adp: 5 },                 // nameless -> dropped
      { player_id: 2, name: 'No ADP Guy', adp: null },    // no adp -> dropped
    ],
  });
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], {
    name: 'Christian McCaffrey', position: 'RB', team: 'SF', bye: 9,
    adp: 1.3, high: 1, low: 4, stdev: 0.6, times_drafted: 351,
  });
  assert.equal(rows[1].position, 'DST'); // DEF -> DST like the rest of the app
  assert.equal(meta.total_drafts, 1587);
  assert.equal(meta.end_date, '2026-07-08');
});

test('parseFfc fails loudly on shape drift', () => {
  assert.throws(() => parseFfc({ nope: true }), /players/i);
});

test('parseSleeper reads adp stats, filters the 999 sentinel, handles both shapes', () => {
  const item = {
    player_id: '11564',
    team: 'NE',
    player: { first_name: 'Drake', last_name: 'Maye', position: 'QB', team: 'NE' },
    stats: { adp_ppr: 129.5, adp_half_ppr: 130.1, adp_std: 130.1, adp_2qb: 58.9, adp_rookie: 999.0, pts_ppr: 301.5 },
  };
  const noAdp = { player_id: '1', player: { first_name: 'Camp', last_name: 'Body', position: 'WR' }, stats: { adp_ppr: 999.0 } };

  const fromArray = parseSleeper([item, noAdp]);
  assert.equal(fromArray.length, 1);
  assert.equal(fromArray[0].sleeper_id, '11564');
  assert.equal(fromArray[0].name, 'Drake Maye');
  assert.deepEqual(fromArray[0].adps, { standard: 130.1, ppr: 129.5, half: 130.1, superflex: 58.9 });

  const fromObject = parseSleeper({ 11564: item });
  assert.equal(fromObject.length, 1);
  assert.equal(fromObject[0].team, 'NE');
});

test('parseSleeper fails loudly when no ADP is present at all', () => {
  assert.throws(() => parseSleeper([{ player_id: '1', player: { first_name: 'A', last_name: 'B' }, stats: {} }]), /ADP/);
});

test('clampTeams snaps to the league sizes FFC actually runs', () => {
  assert.equal(clampTeams(12), 12);
  assert.equal(clampTeams(14), 14);
  assert.equal(clampTeams(16), 14);
  assert.equal(clampTeams(9), 8);   // 9 is equidistant-ish; nearest wins (8)
  assert.equal(clampTeams(undefined), 12);
});

test('seasonYear rolls over in March', () => {
  assert.equal(seasonYear(new Date(Date.UTC(2026, 6, 10))), 2026);  // July 2026
  assert.equal(seasonYear(new Date(Date.UTC(2027, 0, 15))), 2026);  // Jan 2027 -> 2026 season
  assert.equal(seasonYear(new Date(Date.UTC(2027, 2, 1))), 2027);   // Mar 2027 -> new season
});
