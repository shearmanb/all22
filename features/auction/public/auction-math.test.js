// Golden tests for the War Chest budget math (features/auction/public/auction-math.js).
// The scenarios mirror the owner's Auction_2021_calc spreadsheet: EST/ACT columns,
// the AMOUNT (= ACT if set, else EST) rollup, and the over/under against $200.
const test = require('node:test');
const assert = require('node:assert');
const math = require('./auction-math');

test('money: blank means unset, bad input is rejected, zero is a value', () => {
  assert.strictEqual(math.money(''), null);
  assert.strictEqual(math.money(null), null);
  assert.strictEqual(math.money(undefined), null);
  assert.strictEqual(math.money('abc'), null);
  assert.strictEqual(math.money(-3), null);
  assert.strictEqual(math.money('12'), 12);
  assert.strictEqual(math.money(0), 0);
  assert.strictEqual(math.money(1.5), 1.5);
});

test('cleanRoster: coerces counts, drops junk, caps at 30', () => {
  assert.deepStrictEqual(
    math.cleanRoster({ QB: '1', RB: 2.4, WR: -5, TE: 'x', FLEX: 99, IDP: 3 }),
    { QB: 1, RB: 2, WR: 0, TE: 0, FLEX: 30, K: 0, DST: 0, BN: 0 }
  );
  assert.strictEqual(math.totalSlots(math.DEFAULT_ROSTER), 17);
});

test('expandRoster: canonical order, numbered within each slot type', () => {
  const rows = math.expandRoster({ QB: 1, RB: 2, WR: 0, TE: 0, FLEX: 1, K: 0, DST: 0, BN: 2 });
  assert.deepStrictEqual(rows, [
    { slot: 'QB', slot_num: 1 },
    { slot: 'RB', slot_num: 1 },
    { slot: 'RB', slot_num: 2 },
    { slot: 'FLEX', slot_num: 1 },
    { slot: 'BN', slot_num: 1 },
    { slot: 'BN', slot_num: 2 },
  ]);
});

test('summarize: untouched default auction', () => {
  const slots = math.expandRoster(math.DEFAULT_ROSTER);
  const s = math.summarize(200, slots);
  assert.strictEqual(s.spent, 0);
  assert.strictEqual(s.committed, 0);
  assert.strictEqual(s.remaining, 200);
  assert.strictEqual(s.openSlots, 17);
  assert.strictEqual(s.filledSlots, 0);
  // $1 held back for each of the 16 other open slots.
  assert.strictEqual(s.maxBid, 184);
  assert.strictEqual(s.slack, 200);
});

test('summarize: mid-auction, the spreadsheet rollup', () => {
  // Plans total 105; two slots won (67 + 16 = 83 spent), one open slot has no plan.
  const slots = [
    { plan: 50, paid: 67 },   // won over plan (+17, like the sheet's Top-2 row)
    { plan: 20, paid: 16 },   // won under plan (-4)
    { plan: 15, paid: null }, // still open, planned
    { plan: 20, paid: '' },   // still open, planned ('' from a form is unset)
    { plan: null, paid: null }, // open, no plan yet
  ];
  const s = math.summarize(200, slots);
  assert.strictEqual(s.spent, 83);
  // committed = paid where filled else plan: 67 + 16 + 15 + 20 + 0
  assert.strictEqual(s.committed, 118);
  assert.strictEqual(s.remaining, 117);
  assert.strictEqual(s.openSlots, 3);
  assert.strictEqual(s.filledSlots, 2);
  assert.strictEqual(s.planOpen, 35);
  assert.strictEqual(s.slack, 82);
  assert.strictEqual(s.maxBid, 117 - 2);
  assert.ok(Math.abs(s.avgPerOpen - 39) < 1e-9);
});

test('summarize: plan over budget shows negative slack (the sheet o/u)', () => {
  const slots = [
    { plan: 100, paid: null },
    { plan: 80, paid: null },
    { plan: 33, paid: null },
  ];
  const s = math.summarize(200, slots);
  assert.strictEqual(s.committed, 213);
  assert.strictEqual(s.slack, -13);
});

test('summarize: overspent clamps maxBid at 0, all-filled means no bidding', () => {
  const over = math.summarize(200, [{ paid: 195 }, { paid: 10 }, { plan: 5, paid: null }]);
  assert.strictEqual(over.remaining, -5);
  assert.strictEqual(over.maxBid, 0);
  const done = math.summarize(200, [{ paid: 100 }, { paid: 50 }]);
  assert.strictEqual(done.openSlots, 0);
  assert.strictEqual(done.maxBid, 0);
  assert.strictEqual(done.avgPerOpen, null);
});

test('summarize: a $0 (or $1 dart-throw) win still fills the slot', () => {
  const s = math.summarize(200, [{ plan: 5, paid: 0 }, { plan: 5, paid: null }]);
  assert.strictEqual(s.filledSlots, 1);
  assert.strictEqual(s.committed, 5);
});

test('isEmptySlot: plan alone is still empty; a player or price is content', () => {
  assert.ok(math.isEmptySlot({ plan: 25, player_id: null, player_name: '', paid: null }));
  assert.ok(!math.isEmptySlot({ player_id: 7, player_name: 'Derrick Henry', paid: null }));
  assert.ok(!math.isEmptySlot({ player_id: null, player_name: 'some guy', paid: null }));
  assert.ok(!math.isEmptySlot({ player_id: null, player_name: '', paid: 0 }));
});

test('reconcileSlots: grows, fills numbering gaps, shrinks only empty slots', () => {
  const existing = [
    { id: 1, slot: 'RB', slot_num: 1, player_name: 'CMC', player_id: 5, paid: 60 },
    { id: 2, slot: 'RB', slot_num: 3, player_name: '', player_id: null, paid: null }, // gap: no RB2
    { id: 3, slot: 'BN', slot_num: 1, player_name: '', player_id: null, paid: null, plan: 2 },
    { id: 4, slot: 'BN', slot_num: 2, player_name: 'Sleeper Guy', player_id: null, paid: null },
  ];
  // Want RB x3 (adds the missing RB2), BN x1 (drops BN2... but it's filled -> blocked; BN1 stays).
  const r1 = math.reconcileSlots(existing, math.cleanRoster({ RB: 3, BN: 1 }));
  assert.deepStrictEqual(r1.add, [{ slot: 'RB', slot_num: 2 }]);
  assert.deepStrictEqual(r1.removeIds, []);
  assert.deepStrictEqual(r1.blocked, ['Bench2']);
  // Want RB x1: RB3 is empty -> removable. RB1 is filled but within the count -> kept.
  const r2 = math.reconcileSlots(existing, math.cleanRoster({ RB: 1, BN: 2 }));
  assert.deepStrictEqual(r2.add, []);
  assert.deepStrictEqual(r2.removeIds, [2]);
  assert.deepStrictEqual(r2.blocked, []);
});
