const test = require('node:test');
const assert = require('node:assert');
const snake = require('./warroom-snake');

test('odd rounds run forward, even rounds reverse (12 teams)', () => {
  assert.deepEqual(snake.overallToSlot(1, 12), { round: 1, slot: 1, pickInRound: 1 });
  assert.deepEqual(snake.overallToSlot(12, 12), { round: 1, slot: 12, pickInRound: 12 });
  // Round 2 reverses: pick 13 belongs to the team that just picked 12th.
  assert.deepEqual(snake.overallToSlot(13, 12), { round: 2, slot: 12, pickInRound: 1 });
  assert.deepEqual(snake.overallToSlot(24, 12), { round: 2, slot: 1, pickInRound: 12 });
  assert.deepEqual(snake.overallToSlot(25, 12), { round: 3, slot: 1, pickInRound: 1 });
});

test('slotToOverall is the exact inverse of overallToSlot', () => {
  for (const teams of [8, 10, 12, 14]) {
    for (let o = 1; o <= teams * 16; o++) {
      const p = snake.overallToSlot(o, teams);
      assert.equal(snake.slotToOverall(p.round, p.slot, teams), o, `teams=${teams} overall=${o}`);
    }
  }
});

test('myPickOveralls: the turn (back-to-back picks) lands right', () => {
  // 12-team slot 12 picks 12 and 13 — the classic turn.
  assert.deepEqual(snake.myPickOveralls(12, 12, 3), [12, 13, 36]);
  // Slot 1 picks 1, 24, 25 in a 12-teamer.
  assert.deepEqual(snake.myPickOveralls(1, 12, 3), [1, 24, 25]);
});

test('nextOpenOverall fills gaps left by deletes, null when full', () => {
  assert.equal(snake.nextOpenOverall(new Set(), 12, 15), 1);
  assert.equal(snake.nextOpenOverall(new Set([1, 2, 3]), 12, 15), 4);
  // Pick 2 was deleted (sticker pulled): it is the next to fill.
  assert.equal(snake.nextOpenOverall(new Set([1, 3, 4]), 12, 15), 2);
  const full = new Set(Array.from({ length: 24 }, (_, i) => i + 1));
  assert.equal(snake.nextOpenOverall(full, 12, 2), null);
  // Accepts a plain array too.
  assert.equal(snake.nextOpenOverall([1, 2], 12, 2), 3);
});

test('pickLabel speaks draft-room ("3.07"), myNextPick looks forward only', () => {
  assert.equal(snake.pickLabel(31, 12), '3.07');
  assert.equal(snake.pickLabel(1, 12), '1.01');
  assert.equal(snake.myNextPick(0, 7, 12, 15), 7);
  assert.equal(snake.myNextPick(7, 7, 12, 15), 18);   // round 2 reversal: slot 7 -> pick 18
  assert.equal(snake.myNextPick(999, 7, 12, 15), null);
});

test('garbage in, null out — never NaN', () => {
  assert.equal(snake.overallToSlot(0, 12), null);
  assert.equal(snake.overallToSlot('x', 12), null);
  assert.equal(snake.slotToOverall(1, 13, 12), null);
});
