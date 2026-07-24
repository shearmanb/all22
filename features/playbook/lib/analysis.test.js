const test = require('node:test');
const assert = require('node:assert');
const { analyze, tagFor, cleanOptions, DEFAULTS } = require('./analysis');

// A tiny 4-team draft: slots 1-4, my slot 2. Player ids are arbitrary.
// Sign convention under test: value = overall_pick - adp (positive = the
// player fell past his ADP = discount/steal; negative = reach).
const picks = [
  { overall_pick: 1, round: 1, player_name: 'Alpha RB',  position: 'RB', draft_slot: 1, is_my_pick: false, player_id: 11 },
  { overall_pick: 2, round: 1, player_name: 'Bravo WR',  position: 'WR', draft_slot: 2, is_my_pick: true,  player_id: 12 },
  { overall_pick: 3, round: 1, player_name: 'Chad QB',   position: 'QB', draft_slot: 3, is_my_pick: false, player_id: 13 },
  { overall_pick: 4, round: 1, player_name: 'Delta TE',  position: 'TE', draft_slot: 4, is_my_pick: false, player_id: 14 },
  { overall_pick: 5, round: 2, player_name: 'Echo WR',   position: 'WR', draft_slot: 4, is_my_pick: false, player_id: 15 },
  { overall_pick: 6, round: 2, player_name: 'Fox RB',    position: 'RB', draft_slot: 3, is_my_pick: false, player_id: 16 },
  { overall_pick: 7, round: 2, player_name: 'Golf WR',   position: 'WR', draft_slot: 2, is_my_pick: true,  player_id: 17 },
  { overall_pick: 8, round: 2, player_name: 'Mystery Man', position: 'RB', draft_slot: 1, is_my_pick: false, player_id: null },
];

const adp = [
  { player_id: 11, adp: 1.2 },
  { player_id: 12, adp: 8.0 },  // I took him at 2 → value -6 → reach
  { player_id: 13, adp: 2.5 },
  { player_id: 14, adp: 4.0 },
  { player_id: 15, adp: 5.5 },
  { player_id: 17, adp: 2.0 },  // fell to me at 7 → value +5 → steal
  // 16 intentionally missing from the board (no ADP)
];

const myRanks = [
  { player_id: 12, rank: 4 },
  { player_id: 17, rank: 10 },
];

test('analyze: per-pick value, tags, my-rank deltas', () => {
  const out = analyze({ picks, adp, myRanks, mySlot: 2 });

  const bravo = out.rows.find((r) => r.player_id === 12);
  assert.strictEqual(bravo.adp, 8);
  assert.strictEqual(bravo.value, -6);
  assert.strictEqual(bravo.tag, 'reach'); // 6 ahead of ADP 8: >= max(5, 0.8)
  assert.strictEqual(bravo.my_rank, 4);
  assert.strictEqual(bravo.my_value, -2);

  const golf = out.rows.find((r) => r.player_id === 17);
  assert.strictEqual(golf.value, 5);
  assert.strictEqual(golf.tag, 'steal'); // 5 >= max(5, 0.2)
  assert.strictEqual(golf.my_value, -3);

  const alpha = out.rows.find((r) => r.player_id === 11);
  assert.strictEqual(alpha.value, -0.2);
  assert.strictEqual(alpha.tag, null); // tiny drift, no tag
  assert.strictEqual(alpha.my_rank, null); // not in my rankings
});

test('analyze: unmatched and no-ADP picks stay visible, never guessed', () => {
  const out = analyze({ picks, adp, myRanks, mySlot: 2 });
  const mystery = out.rows.find((r) => r.player_name === 'Mystery Man');
  assert.strictEqual(mystery.matched, false);
  assert.strictEqual(mystery.adp, null);
  assert.strictEqual(mystery.value, null);
  assert.strictEqual(mystery.tag, null);
  const fox = out.rows.find((r) => r.player_id === 16);
  assert.strictEqual(fox.matched, true);
  assert.strictEqual(fox.value, null); // matched but not on the ADP board
});

test('analyze: my-picks summary and positional balance', () => {
  const out = analyze({ picks, adp, myRanks, mySlot: 2 });
  assert.strictEqual(out.summary.my_picks, 2);
  assert.strictEqual(out.summary.unmatched, 0);
  assert.strictEqual(out.summary.no_adp, 0);
  assert.strictEqual(out.summary.total_value, -1); // -6 + 5
  assert.strictEqual(out.summary.steals, 1);
  assert.strictEqual(out.summary.reaches, 1);
  assert.strictEqual(out.summary.best_pick.player_name, 'Golf WR');
  assert.strictEqual(out.summary.best_pick.value, 5);
  assert.strictEqual(out.summary.worst_pick.player_name, 'Bravo WR');
  assert.strictEqual(out.summary.worst_pick.value, -6);
  assert.deepStrictEqual(out.positions.WR, { count: 2, rounds: [1, 2], value: -1 });
});

test('analyze: team leaderboard ranks every slot with valued picks', () => {
  const out = analyze({ picks, adp, myRanks, mySlot: 2 });
  const bySlot = Object.fromEntries(out.teams.map((t) => [t.slot, t]));
  assert.strictEqual(bySlot[1].value, -0.2); // Mystery unmatched → only Alpha counts
  assert.strictEqual(bySlot[1].picks, 1);
  assert.strictEqual(bySlot[3].value, 0.5);  // Fox has no ADP → only Chad counts
  assert.strictEqual(bySlot[3].picks, 1);
  assert.strictEqual(bySlot[4].value, -0.5);
  assert.strictEqual(bySlot[2].value, -1);
  assert.strictEqual(bySlot[2].is_me, true);
  assert.strictEqual(out.teams[0].slot, 3);  // highest total value leads
  assert.strictEqual(out.teams[0].rank, 1);
});

test('tagFor: relative floor governs late picks, absolute floor early ones', () => {
  const opts = cleanOptions({});
  // Early: ADP 8, taken at 2 (value -6): 6 >= max(5, 0.8) → reach.
  assert.strictEqual(tagFor(-6, 8, opts), 'reach');
  // Early small drift: ADP 8, taken at 5 (value -3): 3 < 5 → no tag.
  assert.strictEqual(tagFor(-3, 8, opts), null);
  // Late: ADP 150, fell 12 picks: 12 < max(5, 15) → NOT a steal (10% of 150).
  assert.strictEqual(tagFor(12, 150, opts), null);
  // Late: fell 20 picks: 20 >= 15 → steal.
  assert.strictEqual(tagFor(20, 150, opts), 'steal');
});

test('cleanOptions: bad dial values fall back to defaults', () => {
  assert.deepStrictEqual(cleanOptions({ steal_picks: 'x', reach_pct: -3 }), DEFAULTS);
  assert.strictEqual(cleanOptions({ steal_picks: 3 }).steal_picks, 3);
  assert.strictEqual(cleanOptions({ steal_picks: 0 }).steal_picks, 0);
});
