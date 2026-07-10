// Golden tests for the mini-ECR blender. Row shape mirrors store.getSetRows.
const test = require('node:test');
const assert = require('node:assert');
const { buildEcr, compareRankings } = require('./ecr');

function row(playerId, name, position, rank, positionRank) {
  return {
    player_id: playerId, name, position, team: '',
    rank, position_rank: positionRank || null,
  };
}

// Two small overall lists that mostly agree.
function twoSets() {
  return [
    {
      id: 1, name: 'Ranker A', ranking_scope: 'overall', native_scoring_format: 'half', weight: 1,
      rows: [
        row(11, 'Alpha', 'RB', 1, 1),
        row(22, 'Bravo', 'WR', 2, 1),
        row(33, 'Charlie', 'RB', 3, 2),
      ],
    },
    {
      id: 2, name: 'Ranker B', ranking_scope: 'overall', native_scoring_format: 'half', weight: 1,
      rows: [
        row(22, 'Bravo', 'WR', 1, 1),
        row(11, 'Alpha', 'RB', 2, 1),
        row(44, 'Delta', 'TE', 3, 1),
      ],
    },
  ];
}

test('averages ranks across overall sets and sorts by average', () => {
  const { overall } = buildEcr(twoSets(), {});
  const byName = Object.fromEntries(overall.map((p) => [p.name, p]));
  assert.equal(byName.Alpha.avg, 1.5);   // 1 & 2
  assert.equal(byName.Bravo.avg, 1.5);   // 2 & 1
  assert.equal(byName.Charlie.avg, 3);   // only set 1
  assert.equal(byName.Charlie.n, 1);
  // Alpha & Bravo tie on avg and n; min ties too (both 1) -> name breaks it.
  assert.equal(overall[0].name, 'Alpha');
  assert.equal(overall[1].name, 'Bravo');
  assert.equal(overall[0].rank, 1);
  assert.equal(overall[1].rank, 2);
});

test('per-set votes and real-vote stats are reported', () => {
  const { overall } = buildEcr(twoSets(), {});
  const alpha = overall.find((p) => p.name === 'Alpha');
  assert.deepEqual(alpha.votes, { 1: 1, 2: 2 });
  assert.equal(alpha.min, 1);
  assert.equal(alpha.max, 2);
  assert.equal(alpha.stdev, 0.5); // population stdev of [1,2]
});

test('weights tilt the average toward the trusted ranker', () => {
  const sets = twoSets();
  sets[0].weight = 3; // trust Ranker A 3x
  const { overall } = buildEcr(sets, {});
  const alpha = overall.find((p) => p.name === 'Alpha');
  // (3*1 + 1*2) / 4 = 1.25
  assert.equal(alpha.avg, 1.25);
});

test('weight 0 removes a set from the vote entirely', () => {
  const sets = twoSets();
  sets[1].weight = 0;
  const { overall, meta } = buildEcr(sets, {});
  assert.ok(!overall.find((p) => p.name === 'Delta')); // only set 2 had Delta
  assert.deepEqual(meta.overall_sets, [1]);
});

test('unranked=exclude averages only the sets that ranked the player', () => {
  const { overall } = buildEcr(twoSets(), { unranked: 'exclude' });
  const charlie = overall.find((p) => p.name === 'Charlie');
  assert.equal(charlie.avg, 3); // set 2's omission is "no opinion"
});

test('unranked=penalty makes an omitting set vote past its list end', () => {
  const { overall } = buildEcr(twoSets(), { unranked: 'penalty', penalty_extra: 10 });
  const charlie = overall.find((p) => p.name === 'Charlie');
  // set 1 ranks him 3; set 2 (3 rows) omits him -> votes 3+10=13. avg = 8.
  assert.equal(charlie.avg, 8);
  // stats still describe the REAL vote only
  assert.equal(charlie.n, 1);
  assert.equal(charlie.min, 3);
  assert.equal(charlie.max, 3);
});

test('min_sets hides one-ranker specials', () => {
  const { overall } = buildEcr(twoSets(), { min_sets: 2 });
  assert.deepEqual(overall.map((p) => p.name).sort(), ['Alpha', 'Bravo']);
});

test('outlier=trim drops the single best and worst vote when 4+ sets rank a player', () => {
  const mk = (id, rank) => ({
    id, name: `S${id}`, ranking_scope: 'overall', native_scoring_format: 'ppr', weight: 1,
    rows: [row(11, 'Alpha', 'RB', rank, 1)],
  });
  // Ranks 1, 2, 3, 100 -> trimmed to 2, 3 -> avg 2.5 (plain avg would be 26.5)
  const { overall } = buildEcr([mk(1, 1), mk(2, 2), mk(3, 3), mk(4, 100)], { outlier: 'trim' });
  assert.equal(overall[0].avg, 2.5);
  // But with only 3 votes, no trimming happens.
  const three = buildEcr([mk(1, 1), mk(2, 2), mk(3, 100)], { outlier: 'trim' });
  assert.equal(three.overall[0].avg, Math.round((103 / 3) * 100) / 100);
});

test('positional sets vote per-position but never overall', () => {
  const sets = twoSets();
  sets.push({
    id: 3, name: 'Pos-only guy', ranking_scope: 'positional', native_scoring_format: 'half', weight: 1,
    rows: [
      row(33, 'Charlie', 'RB', 1, 1), // paste order rank means nothing overall
      row(11, 'Alpha', 'RB', 2, 2),
    ],
  });
  const { overall, positions, meta } = buildEcr(sets, {});
  const alpha = overall.find((p) => p.name === 'Alpha');
  assert.equal(alpha.avg, 1.5); // unchanged — set 3 didn't vote overall
  assert.deepEqual(meta.positional_only_sets, [3]);
  // RB position consensus: set1 has Alpha RB1, Charlie RB2; set2 Alpha RB1;
  // set3 Charlie RB1, Alpha RB2.
  const rb = positions.RB;
  const alphaRb = rb.find((p) => p.name === 'Alpha');
  const charlieRb = rb.find((p) => p.name === 'Charlie');
  assert.equal(alphaRb.avg, Math.round((1 + 1 + 2) / 3 * 100) / 100);
  assert.equal(charlieRb.avg, 1.5);
  assert.equal(rb[0].name, 'Alpha'); // 1.33 < 1.5
});

test('unmatched rows are skipped but counted, and duplicate votes keep the best rank', () => {
  const sets = [{
    id: 9, name: 'Messy', ranking_scope: 'overall', native_scoring_format: 'unknown', weight: 1,
    rows: [
      row(11, 'Alpha', 'RB', 1, 1),
      { player_id: null, name: 'Unknown Guy', position: '', team: '', rank: 2, position_rank: null },
      row(11, 'Alpha', 'RB', 3, 2), // OCR dupe — worse rank ignored
    ],
  }];
  const { overall, meta } = buildEcr(sets, {});
  assert.equal(overall.length, 1);
  assert.equal(overall[0].avg, 1);
  assert.equal(meta.unmatched_skipped[9], 1);
});

test('meta flags mixed native formats', () => {
  const sets = twoSets();
  sets[1].native_scoring_format = 'ppr';
  const { meta } = buildEcr(sets, {});
  assert.equal(meta.mixed_formats, true);
  assert.deepEqual(meta.formats.sort(), ['half', 'ppr']);
});

test('compareRankings pairs players and sorts by absolute movement', () => {
  const a = [
    { player_id: 11, name: 'Alpha', position: 'RB', team: '', rank: 1 },
    { player_id: 22, name: 'Bravo', position: 'WR', team: '', rank: 2 },
    { player_id: 33, name: 'Charlie', position: 'RB', team: '', rank: 3 },
  ];
  const b = [
    { player_id: 22, name: 'Bravo', position: 'WR', team: '', rank: 9 },
    { player_id: 11, name: 'Alpha', position: 'RB', team: '', rank: 2 },
    { player_id: 44, name: 'Delta', position: 'TE', team: '', rank: 3 },
  ];
  const { pairs, onlyA, onlyB } = compareRankings(a, b);
  assert.equal(pairs[0].name, 'Bravo'); // |2-9| = 7 is the biggest move
  assert.equal(pairs[0].delta, -7);
  assert.equal(onlyA[0].name, 'Charlie');
  assert.equal(onlyB[0].name, 'Delta');
});
