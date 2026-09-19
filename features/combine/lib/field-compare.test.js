// Golden tests for the "vs the field" comparison. Run with: node --test
//
// The load-bearing claim here is the shared-pool re-numbering: an Underdog
// slate is a SUBSET of a weekly rankings file (only the teams playing, no
// kickers or defenses) and a weekly ECR flex list carries no quarterbacks, so
// subtracting raw ranks measures the size difference between two lists rather
// than any disagreement between them.
const test = require('node:test');
const assert = require('node:assert');
const { underdogBoard, ecrBoard, compare } = require('./field-compare');

const SLATE =
  '"id","firstName","lastName","adp","projectedPoints","slotName","teamName"\n' +
  '"u1","Jahmyr","Gibbs","1.2","19.4","RB","Detroit Lions"\n' +
  '"u2","Bijan","Robinson","2.4","18.1","RB","Atlanta Falcons"\n' +
  '"u3","Ja\'Marr","Chase","3.1","17.2","WR","Cincinnati Bengals"\n' +
  '"u4","Demarcus","Robinson","95.0","4.0","WR","San Francisco 49ers"';

const FP = [
  { rank: 1, name: 'Patrick Mahomes', position: 'QB', team: 'KC' },
  { rank: 2, name: 'Jahmyr Gibbs', position: 'RB', team: 'DET' },
  { rank: 3, name: 'Bijan Robinson', position: 'RB', team: 'ATL' },
  { rank: 4, name: "Ja'Marr Chase", position: 'WR', team: 'CIN' },
];

test('Underdog ranks off ADP, not the file\'s own row order', () => {
  // The file arrives in a deliberately wrong order — this is what a download
  // looks like AFTER the owner has uploaded his own ranking to Underdog once,
  // which is exactly why file order can never be read as Underdog's opinion.
  const shuffled =
    '"id","firstName","lastName","adp","slotName","teamName"\n' +
    '"u3","Ja\'Marr","Chase","3.1","WR","Cincinnati Bengals"\n' +
    '"u1","Jahmyr","Gibbs","1.2","RB","Detroit Lions"\n' +
    '"u2","Bijan","Robinson","2.4","RB","Atlanta Falcons"';
  const board = underdogBoard(shuffled);
  assert.equal(board.basis, 'adp');
  assert.equal(board.fell_back, false);
  const byRank = board.rows.slice().sort((a, b) => a.rank - b.rank).map((r) => r.name);
  assert.deepEqual(byRank, ['Jahmyr Gibbs', 'Bijan Robinson', "Ja'Marr Chase"]);
});

test('Underdog can rank off projections, high to low', () => {
  const board = underdogBoard(SLATE, 'projection');
  assert.equal(board.basis, 'projection');
  const byRank = board.rows.slice().sort((a, b) => a.rank - b.rank).map((r) => r.name);
  assert.deepEqual(byRank, ['Jahmyr Gibbs', 'Bijan Robinson', "Ja'Marr Chase", 'Demarcus Robinson']);
});

test('with no numbers to rank on, file order is used AND announced', () => {
  const bare =
    '"id","firstName","lastName","slotName"\n' +
    '"u1","Jahmyr","Gibbs","RB"\n' +
    '"u2","Bijan","Robinson","RB"';
  const board = underdogBoard(bare);
  assert.equal(board.basis, 'file');
  assert.equal(board.fell_back, true);
  assert.match(board.note, /file's own row order/);
  // Asking for projections when the file has none lands in the same place.
  assert.equal(underdogBoard(bare, 'projection').basis, 'file');
});

test('a player Underdog never priced is unranked, not ranked zeroth', () => {
  const board = underdogBoard(
    '"id","firstName","lastName","adp","slotName"\n' +
    '"u1","Jahmyr","Gibbs","1.2","RB"\n' +
    '"u2","Bijan","Robinson","2.4","RB"\n' +
    '"u3","Ja\'Marr","Chase","3.1","WR"\n' +
    '"u4","Tank","Bigsby","4.0","RB"\n' +
    '"u5","Roschon","Johnson","5.0","RB"\n' +
    '"u6","Third","Stringer","","RB"'
  );
  const blank = board.rows.find((r) => r.name === 'Third Stringer');
  assert.equal(blank.rank, null);
  assert.equal(board.ranked, 5);
  assert.equal(board.total, 6);
});

test('ranks are compared over the players two lists share, not raw', () => {
  // Underdog's slate has no QB, so Mahomes at #1 pushes every raw Fantasy
  // Points rank one slot behind Underdog's. The two lists actually AGREE
  // about the three players they both carry, and the gaps must say so.
  const out = compare(FP, { underdog: underdogBoard(SLATE) });
  const by = Object.fromEntries(out.rows.map((r) => [r.name, r]));

  assert.equal(by['Patrick Mahomes'].ud, null); // not in this contest at all
  assert.equal(by['Jahmyr Gibbs'].ud.delta, 0);
  assert.equal(by['Bijan Robinson'].ud.delta, 0);
  assert.equal(by["Ja'Marr Chase"].ud.delta, 0);

  // The raw numbers still travel, because "Underdog's ADP has him 1.2" is
  // worth reading even when it isn't what the gap is computed from.
  assert.equal(by['Jahmyr Gibbs'].ud.rank, 1);
  assert.equal(by['Jahmyr Gibbs'].ud.adp, 1.2);
  assert.equal(by['Jahmyr Gibbs'].ud.my_pool_rank, 1);
  assert.equal(out.underdog.pool, 3);
  assert.equal(out.underdog.matched, 3);
  assert.equal(out.underdog.basis, 'adp');
});

test('a positive gap means his source is HIGHER on the player than the field', () => {
  const mine = [
    { rank: 1, name: 'Bijan Robinson', position: 'RB', team: 'ATL' },
    { rank: 2, name: 'Jahmyr Gibbs', position: 'RB', team: 'DET' },
    { rank: 3, name: "Ja'Marr Chase", position: 'WR', team: 'CIN' },
  ];
  // Underdog has Gibbs first, this list has Bijan first.
  const out = compare(mine, { underdog: underdogBoard(SLATE) });
  const by = Object.fromEntries(out.rows.map((r) => [r.name, r]));
  assert.equal(by['Bijan Robinson'].ud.delta, 1);  // he is 1st here, 2nd there
  assert.equal(by['Jahmyr Gibbs'].ud.delta, -1);   // he is 2nd here, 1st there
  assert.equal(by["Ja'Marr Chase"].ud.delta, 0);
});

test('the strict resolver still applies — no wrong Robinson', () => {
  const out = compare(
    [{ rank: 1, name: 'Brian Robinson', position: 'RB', team: 'WAS' }],
    { underdog: underdogBoard(SLATE) }
  );
  // Demarcus Robinson is the only other Robinson left on the slate and he is a
  // WR; a shared last name must not make him a comparison row.
  assert.equal(out.rows[0].ud, null);
  assert.equal(out.underdog.matched, 0);
});

test('expert consensus carries the spread, and a flex list simply has no QB', () => {
  const ecr = ecrBoard([
    { name: 'Jahmyr Gibbs', position: 'RB', team: 'DET', rank: 1, ave: 1.4, std: 0.9, best: 1, worst: 4, tier: 1, pos_rank: 'RB1' },
    { name: "Ja'Marr Chase", position: 'WR', team: 'CIN', rank: 2, ave: 2.6, std: 1.2, best: 1, worst: 6, tier: 1, pos_rank: 'WR1' },
    { name: 'Bijan Robinson', position: 'RB', team: 'ATL', rank: 3, ave: 3.1, std: 1.0, best: 2, worst: 7, tier: 1, pos_rank: 'RB2' },
  ], { total_experts: 24 });
  const out = compare(FP, { ecr });
  const by = Object.fromEntries(out.rows.map((r) => [r.name, r]));

  assert.equal(by['Patrick Mahomes'].ecr, null);
  assert.equal(by["Ja'Marr Chase"].ecr.rank, 2);
  assert.equal(by["Ja'Marr Chase"].ecr.best, 1);
  assert.equal(by["Ja'Marr Chase"].ecr.worst, 6);
  assert.equal(by["Ja'Marr Chase"].ecr.std, 1.2);
  // Shared pool is Gibbs/Bijan/Chase: his order is Gibbs, Bijan, Chase; the
  // experts' is Gibbs, Chase, Bijan. So he is a spot high on Bijan, a spot low
  // on Chase, and they agree on Gibbs.
  assert.equal(by['Jahmyr Gibbs'].ecr.delta, 0);
  assert.equal(by['Bijan Robinson'].ecr.delta, 1);
  assert.equal(by["Ja'Marr Chase"].ecr.delta, -1);
  assert.equal(out.ecr.experts, 24);
});

test('both fields compare at once and stay independent', () => {
  const ecr = ecrBoard([
    { name: 'Patrick Mahomes', position: 'QB', team: 'KC', rank: 1 },
    { name: 'Jahmyr Gibbs', position: 'RB', team: 'DET', rank: 2 },
    { name: 'Bijan Robinson', position: 'RB', team: 'ATL', rank: 3 },
    { name: "Ja'Marr Chase", position: 'WR', team: 'CIN', rank: 4 },
  ]);
  const out = compare(FP, { underdog: underdogBoard(SLATE), ecr });
  const gibbs = out.rows.find((r) => r.name === 'Jahmyr Gibbs');
  assert.equal(gibbs.ud.delta, 0);
  assert.equal(gibbs.ecr.delta, 0);
  // The ECR list carries the QB, so its pool is four deep where Underdog's is three.
  assert.equal(out.ecr.pool, 4);
  assert.equal(out.underdog.pool, 3);
  // Nothing is averaged into a single "field" number.
  assert.equal(out.field, undefined);
});

test('a dead expert source costs the Underdog comparison nothing', () => {
  const out = compare(FP, { underdog: underdogBoard(SLATE) });
  assert.equal(out.ecr, null);
  assert.equal(out.underdog.matched, 3);
  assert.ok(out.rows.every((r) => r.ecr === null));
});

test('reports who the field ranks inside your range that you never listed', () => {
  // He ranks three of the four slate players and skips Chase, who Underdog has
  // third — inside the depth his own list reaches.
  const mine = [
    { rank: 1, name: 'Jahmyr Gibbs', position: 'RB', team: 'DET' },
    { rank: 2, name: 'Bijan Robinson', position: 'RB', team: 'ATL' },
    { rank: 3, name: 'Demarcus Robinson', position: 'WR', team: 'SF' },
  ];
  const out = compare(mine, { underdog: underdogBoard(SLATE) });
  assert.deepEqual(out.underdog.missing.map((m) => m.name), ["Ja'Marr Chase"]);
  // Demarcus sits 4th on Underdog's board but IS on his list, so he is not
  // reported as missing.
  assert.equal(out.underdog.missing.length, 1);
});

test('an empty ranked list is an empty comparison, not a crash', () => {
  const out = compare([], { underdog: underdogBoard(SLATE) });
  assert.equal(out.ranked, 0);
  assert.deepEqual(out.rows, []);
  assert.equal(out.underdog.matched, 0);
  assert.deepEqual(out.underdog.missing, []);
});

test('a downloaded FantasyPros file carries the same spread as the fetched page', () => {
  // csv-import folds the columns it doesn't claim into the row's note, which is
  // where BEST / WORST / AVG / STD.DEV and the tier survive the file path.
  const { parseRankings } = require('./underdog-quick');
  const rows = parseRankings(
    '"RK","TIERS","PLAYER NAME","TEAM","POS","OPP","BEST","WORST","AVG.","STD.DEV"\n' +
    '"1","1","Jahmyr Gibbs","DET","RB1","vs ARI","1","3","1.4","0.6"\n' +
    '"2","2","Bijan Robinson","ATL","RB2","vs CAR","1","9","2.2","1.9"\n'
  );
  const board = ecrBoard(rows, { source: 'file' });
  assert.equal(board.rows[0].best, 1);
  assert.equal(board.rows[0].worst, 3);
  assert.equal(board.rows[0].std, 0.6);
  assert.equal(board.rows[0].tier, 1);
  assert.equal(board.rows[0].ave, 1.4);
  // The printed "RB1" is the positional rank and is worth showing; the position
  // itself was already stripped of its ordinal for matching.
  assert.equal(board.rows[0].pos_rank, 'RB1');
  assert.equal(board.rows[0].position, 'RB');
  assert.equal(board.rows[1].worst, 9);
});

test('a file with no spread columns leaves the spread blank, never zero', () => {
  const board = ecrBoard([
    { name: 'Jahmyr Gibbs', position: 'RB', team: 'DET', rank: 1, notes: 'Opp: vs ARI' },
  ], { source: 'file' });
  assert.equal(board.rows[0].best, null);
  assert.equal(board.rows[0].worst, null);
  assert.equal(board.rows[0].std, null);
  assert.equal(board.rows[0].tier, null);
  assert.equal(board.rows[0].pos_rank, '');
});
