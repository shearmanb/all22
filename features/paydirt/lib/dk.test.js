// Tests for the DraftKings lobby/draftables parsers. Run with: node --test
const test = require('node:test');
const assert = require('node:assert');
const { parseLobby, draftablesToCsv, opponentOf, slateWhen } = require('./dk');
const { parseSalaries } = require('./value');

test('parseLobby keeps classic slates, main slate (most contests) first', () => {
  const lobby = {
    Contests: [{ dg: 100 }, { dg: 100 }, { dg: 100 }, { dg: 200 }, { dg: 300 }, { dg: 300 }, { dg: 300 }, { dg: 300 }],
    DraftGroups: [
      { DraftGroupId: 200, GameTypeId: 1, GameCount: 3, StartDateEst: '2026-11-22T16:05:00.0000000', ContestStartTimeSuffix: ' (Afternoon Only)' },
      { DraftGroupId: 100, GameTypeId: 1, GameCount: 11, StartDateEst: '2026-11-22T13:00:00.0000000', ContestStartTimeSuffix: null, DraftGroupTag: 'Featured' },
      { DraftGroupId: 300, GameTypeId: 96, GameCount: 1, StartDateEst: '2026-11-23T20:15:00.0000000' }, // showdown: left out
    ],
  };
  const out = parseLobby(lobby);
  assert.deepEqual(out.map((g) => g.id), [100, 200]);
  assert.equal(out[0].label, 'Sun 11/22 1:00 PM ET · 11 games');
  assert.equal(out[1].label, 'Sun 11/22 4:05 PM ET · Afternoon Only · 3 games');
  assert.throws(() => parseLobby({ nope: 1 }), /DraftGroups/);
});

test('slateWhen and opponentOf', () => {
  assert.equal(slateWhen('2026-11-26T20:20:00'), 'Thu 11/26 8:20 PM ET');
  assert.equal(slateWhen(''), '');
  assert.equal(opponentOf('BAL @ CIN', 'BAL'), 'CIN');
  assert.equal(opponentOf('BAL @ CIN', 'CIN'), 'BAL');
  assert.equal(opponentOf('', 'CIN'), '');
});

test('draftablesToCsv folds roster-slot duplicates to one row at the lowest price, readable by parseSalaries', () => {
  const json = {
    draftables: [
      { draftableId: 1, playerId: 11, displayName: 'Jahmyr Gibbs', position: 'RB', salary: 8800, teamAbbreviation: 'DET', status: 'None', competition: { name: 'DET @ NO' } },
      { draftableId: 2, playerId: 11, displayName: 'Jahmyr Gibbs', position: 'RB', salary: 8800, teamAbbreviation: 'DET', status: 'None', competition: { name: 'DET @ NO' } },
      { draftableId: 3, playerId: 22, displayName: 'Puka Nacua', position: 'WR', salary: 12000, teamAbbreviation: 'LAR', status: 'Q', competition: { name: 'SF @ LAR' } },
      { draftableId: 4, playerId: 22, displayName: 'Puka Nacua', position: 'WR', salary: 8000, teamAbbreviation: 'LAR', status: 'Q', competition: { name: 'SF @ LAR' } },
      { draftableId: 5, playerId: 33, displayName: 'Ravens ', position: 'DST', salary: 3400, teamAbbreviation: 'BAL', status: 'None', competition: { name: 'IND @ BAL' } },
      { draftableId: 6, playerId: 44, displayName: 'Nobody', position: 'WR', salary: 0 },
    ],
  };
  const { csv, count } = draftablesToCsv(json);
  assert.equal(count, 3);
  const rows = parseSalaries(csv);
  assert.deepEqual(rows.map((r) => [r.name, r.position, r.team, r.opp, r.salary, r.injury]), [
    ['Jahmyr Gibbs', 'RB', 'DET', 'NO', 8800, ''],
    ['Puka Nacua', 'WR', 'LAR', 'SF', 8000, 'Q'],
    ['Ravens', 'DST', 'BAL', 'IND', 3400, ''],
  ]);
  assert.throws(() => draftablesToCsv({}), /draftables/);
  assert.throws(() => draftablesToCsv({ draftables: [] }), /no priced players/);
});

test('parseSalaries reads DraftKings\' own Export to CSV and skips captain rows', () => {
  const csv =
    'Position,Name + ID,Name,ID,Roster Position,Salary,Game Info,TeamAbbrev,AvgPointsPerGame\n' +
    'RB,Jahmyr Gibbs (1),Jahmyr Gibbs,1,RB/FLEX,8800,DET@NO 11/22/2026 01:00PM ET,DET,21.4\n' +
    'RB,Jahmyr Gibbs (2),Jahmyr Gibbs,2,CPT,13200,DET@NO 11/22/2026 01:00PM ET,DET,21.4\n' +
    'DST,Ravens  (3),Ravens ,3,DST,3400,IND@BAL 11/22/2026 01:00PM ET,BAL,8.0\n';
  const rows = parseSalaries(csv);
  assert.deepEqual(rows.map((r) => [r.name, r.position, r.team, r.salary]), [
    ['Jahmyr Gibbs', 'RB', 'DET', 8800],
    ['Ravens', 'DST', 'BAL', 3400],
  ]);
});
