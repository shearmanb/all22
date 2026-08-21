// Golden tests for Edge Rush's source parsers.
//
// The FFC and Sleeper fixtures mirror payload shapes verified against the live
// APIs. The ESPN fixtures do NOT: that API is undocumented and was unreachable
// from the machine this was written on, so they encode the shape we believe in
// and the parser is written to fail loudly if a real pull disagrees. Confirm
// the first ESPN pull on Railway (docs/INTEGRATIONS.md).
const test = require('node:test');
const assert = require('node:assert');
const sources = require('./sources');
const { parseFfc, parseSleeper, clampTeams, seasonYear } = sources;

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

// --- ESPN ------------------------------------------------------------------
// ESPN's API is undocumented, so these pin the shape we believe in. If a real
// pull ever stops matching, the parser throws a plain message and the board is
// simply missing — it never invents an order. A wrong ADP on draft day would
// be worse than none.
const espnPlayer = (over = {}) => ({
  player: Object.assign({
    id: 3918298,
    fullName: 'Josh Allen',
    defaultPositionId: 1,
    proTeamId: 2,
    ownership: { averageDraftPosition: 18.4 },
    draftRanksByRankType: { PPR: { rank: 20, auctionValue: 32 }, STANDARD: { rank: 14, auctionValue: 38 } },
  }, over),
});

test('parseEspn reads name, position, team and the real ADP', () => {
  const rows = sources.parseEspn({ players: [espnPlayer()] }, { format: 'ppr' });
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], {
    espn_id: '3918298', name: 'Josh Allen', position: 'QB', team: 'BUF',
    adp: 18.4, auction_value: 32,
  });
});

test('ADP comes from where he actually goes, not from ESPN’s own ranking', () => {
  // averageDraftPosition (18.4) and the PPR rank (20) disagree on purpose.
  const rows = sources.parseEspn({ players: [espnPlayer()] }, { format: 'ppr' });
  assert.equal(rows[0].adp, 18.4, 'draft result beats projected rank');
});

test('a player ESPN has never seen drafted falls back to his rank', () => {
  const rows = sources.parseEspn({ players: [espnPlayer({ ownership: { averageDraftPosition: 0 } })] }, { format: 'ppr' });
  assert.equal(rows[0].adp, 20);
});

test('a player with neither an ADP nor a rank is left out, not given a fake one', () => {
  assert.throws(() => sources.parseEspn({
    players: [espnPlayer({ ownership: { averageDraftPosition: -1 }, draftRanksByRankType: {} })],
  }, { format: 'ppr' }), /no draft positions/);
});

test('the format picks which rank type is read', () => {
  const p = espnPlayer({ ownership: {} });
  assert.equal(sources.parseEspn({ players: [p] }, { format: 'ppr' })[0].adp, 20);
  assert.equal(sources.parseEspn({ players: [p] }, { format: 'standard' })[0].adp, 14);
  // ESPN publishes no half-PPR, so half and superflex borrow PPR.
  assert.equal(sources.espnRankType('half'), 'PPR');
  assert.equal(sources.espnRankType('superflex'), 'PPR');
  assert.equal(sources.espnRankType('nonsense'), 'PPR');
});

test('positions and teams come from ESPN’s id maps, never a guess', () => {
  const rows = sources.parseEspn({ players: [
    espnPlayer({ fullName: 'Bijan Robinson', defaultPositionId: 2, proTeamId: 1 }),
    espnPlayer({ fullName: 'Ravens D/ST', defaultPositionId: 16, proTeamId: 33 }),
    espnPlayer({ fullName: 'Mystery Man', defaultPositionId: 99, proTeamId: 99 }),
  ] }, { format: 'ppr' });
  assert.deepEqual(rows.map((r) => [r.position, r.team]).sort(),
    [['DST', 'BAL'], ['RB', 'ATL'], ['', '']].sort());
});

test('rows come back in draft order', () => {
  const rows = sources.parseEspn({ players: [
    espnPlayer({ fullName: 'Third', ownership: { averageDraftPosition: 30 } }),
    espnPlayer({ fullName: 'First', ownership: { averageDraftPosition: 1.2 } }),
    espnPlayer({ fullName: 'Second', ownership: { averageDraftPosition: 12 } }),
  ] }, { format: 'ppr' });
  assert.deepEqual(rows.map((r) => r.name), ['First', 'Second', 'Third']);
});

test('a changed ESPN shape throws a readable error, never a silent empty board', () => {
  assert.throws(() => sources.parseEspn({}, { format: 'ppr' }), /no players array/);
  assert.throws(() => sources.parseEspn({ players: 'nope' }, { format: 'ppr' }), /no players array/);
  assert.throws(() => sources.parseEspn({ players: [] }, { format: 'ppr' }), /no draft positions/);
  assert.throws(() => sources.parseEspn({ players: [{ nothing: true }] }, { format: 'ppr' }), /no draft positions/);
});

test('junk entries are skipped without losing the good ones', () => {
  const rows = sources.parseEspn({ players: [
    null, { player: null }, { player: { fullName: '   ' } }, espnPlayer(),
  ] }, { format: 'ppr' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'Josh Allen');
});
