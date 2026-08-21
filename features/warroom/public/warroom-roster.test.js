const test = require('node:test');
const assert = require('node:assert');
const roster = require('./warroom-roster');

const P = (position, name) => ({ position, player_name: name || position + '1', name: name || position + '1' });

test('shape comes from the shared roster model, with flex from the league', () => {
  const std = roster.shapeFor({ flex: 1, superflex: false });
  assert.equal(std.QB, 1);
  assert.equal(std.RB, 2);
  assert.equal(std.WR, 3);
  assert.equal(std.FLEX, 1, 'the profile overrides the default flex count');
  assert.equal(std.SUPERFLEX, 0);

  const sf = roster.shapeFor({ flex: 2, superflex: true });
  assert.equal(sf.FLEX, 2);
  assert.equal(sf.SUPERFLEX, 1, 'superflex is a league fact, not a global one');
});

test('a superflex league can start a second QB; a standard one cannot', () => {
  const picks = [P('QB', 'Allen'), P('QB', 'Mahomes')];
  const sf = roster.fill(picks, roster.shapeFor({ flex: 1, superflex: true }));
  assert.equal(sf.slots.QB.filled, 1);
  assert.equal(sf.slots.SUPERFLEX.filled, 1, 'QB2 starts in the superflex');
  assert.equal(sf.slots.BN.filled, 0);

  const std = roster.fill(picks, roster.shapeFor({ flex: 1, superflex: false }));
  assert.equal(std.slots.QB.filled, 1);
  assert.equal(std.slots.BN.filled, 1, 'QB2 is bench depth in a 1QB league');
});

test('dedicated slots fill before flex — the bug that would mis-advise a draft', () => {
  // 2 RB slots + 1 FLEX. Three RBs must read RB 2/2, FLEX 1/1 — never
  // "RB 1/2, you still need an RB" while an RB sits in the flex.
  const shape = roster.shapeFor({ flex: 1, superflex: false });
  const f = roster.fill([P('RB', 'A'), P('RB', 'B'), P('RB', 'C')], shape);
  assert.equal(f.slots.RB.filled, 2);
  assert.equal(f.slots.FLEX.filled, 1);
  assert.equal(f.needs.indexOf('RB'), -1, 'RB is no longer a need');
});

test('needs lists only the starting slots still open', () => {
  const shape = roster.shapeFor({ flex: 1, superflex: false });
  const f = roster.fill([P('RB'), P('WR')], shape);
  // QB 0/1, RB 1/2, WR 1/3, TE 0/1, FLEX 0/1, K 0/1, DST 0/1
  assert.deepEqual(f.needs, ['QB', 'RB', 'WR', 'TE', 'FLEX', 'K', 'DST']);
  assert.equal(f.needs.indexOf('BN'), -1, 'the bench is depth, never a need');
});

test('an empty roster needs everything; a full one needs nothing', () => {
  const shape = roster.shapeFor({ flex: 1, superflex: false });
  assert.deepEqual(roster.fill([], shape).needs, ['QB', 'RB', 'WR', 'TE', 'FLEX', 'K', 'DST']);
  const full = [P('QB'), P('RB'), P('RB'), P('WR'), P('WR'), P('WR'), P('TE'), P('RB'), P('K'), P('DST')];
  assert.deepEqual(roster.fill(full, shape).needs, []);
});

test('position spellings all land in one bucket', () => {
  assert.equal(roster.normalizePos('D/ST'), 'DST');
  assert.equal(roster.normalizePos('DEF'), 'DST');
  assert.equal(roster.normalizePos('pk'), 'K');
  assert.equal(roster.normalizePos('RB1'), 'RB');
  assert.equal(roster.normalizePos(''), '');
  const f = roster.fill([P('D/ST'), P('PK')], roster.shapeFor({ flex: 1 }));
  assert.equal(f.slots.DST.filled, 1);
  assert.equal(f.slots.K.filled, 1);
});

test('a player whose position never resolved still counts, on the bench', () => {
  // A free-typed name has no position. Dropping him would misreport the roster.
  const f = roster.fill([P('', 'Mystery Guy')], roster.shapeFor({ flex: 1 }));
  assert.equal(f.slots.BN.filled, 1);
  assert.equal(f.slots.BN.players[0].name, 'Mystery Guy');
});

test('drafting past the last bench slot is still counted, never dropped', () => {
  const tiny = roster.shapeFor({ flex: 0 }, { QB: 1, RB: 0, WR: 0, TE: 0, K: 0, DST: 0, BN: 1 });
  const f = roster.fill([P('QB'), P('RB'), P('WR')], tiny);
  assert.equal(f.slots.QB.filled, 1);
  assert.equal(f.slots.BN.filled, 2, 'the overflow lands on the bench rather than vanishing');
});

test('fillsNeed answers "does this position matter right now"', () => {
  const shape = roster.shapeFor({ flex: 1, superflex: false });
  const noQb = roster.fill([P('RB'), P('RB'), P('WR'), P('WR'), P('WR'), P('TE'), P('RB')], shape);
  assert.equal(roster.fillsNeed('QB', noQb), true, 'QB slot is still open');
  assert.equal(roster.fillsNeed('RB', noQb), false, 'RB and FLEX are both full');
  assert.equal(roster.fillsNeed('', noQb), false);
});

test('a superflex need is met by a QB or a skill player', () => {
  const shape = roster.shapeFor({ flex: 0, superflex: true });
  const f = roster.fill([P('QB')], shape);   // QB slot taken, SUPERFLEX open
  assert.equal(roster.fillsNeed('QB', f), true);
  assert.equal(roster.fillsNeed('WR', f), true);
  assert.equal(roster.fillsNeed('K', f), true, 'K slot is also still open');
});
