// Golden tests for Pay Dirt's "Fill the rest" search. Run with: node --test
const test = require('node:test');
const assert = require('node:assert');
const { fill, expandSlots, describeSlots } = require('./paydirt-fill');

function row(name, position, salary, fpts, extra) {
  return Object.assign({ name, position, team: 'XX', opp: 'YY', salary, fpts, injury: '' }, extra || {});
}

const SLATE = [
  row('Josh Allen', 'QB', 9200, 24.0),
  row('Bo Nix', 'QB', 6800, 17.5),
  row('Jahmyr Gibbs', 'RB', 9000, 24.5),
  row('Derrick Henry', 'RB', 8000, 17.6),
  row('Kenneth Walker', 'RB', 6800, 13.0),
  row('Tony Pollard', 'RB', 5200, 9.9),
  row('Puka Nacua', 'WR', 8400, 21.0),
  row('Hollywood Brown', 'WR', 5500, 11.2, { fd_name: 'Hollywood Brown', name: 'Marquise Brown' }),
  row('Tony Brown', 'WR', 4500, 3.0),
  row('Jalen Coker', 'WR', 4800, 9.1),
  row('Trey McBride', 'TE', 6500, 14.2),
  row('Cade Otton', 'TE', 4400, 7.0),
  row('Baltimore Ravens', 'DST', 4200, 8.0),
  row('Hurt Guy', 'WR', 5000, 15.0, { injury: 'O' }),
];

function names(combo) { return combo.players.map((p) => p.name).sort(); }

test('expandSlots accepts counts or a list and fills dedicated slots before FLEX', () => {
  assert.deepEqual(expandSlots({ FLEX: 1, WR: 2, rb: 1 }), ['RB', 'WR', 'WR', 'FLEX']);
  assert.deepEqual(expandSlots(['flex', 'WR', 'bogus']), ['WR', 'FLEX']);
  assert.equal(describeSlots({ WR: 2, FLEX: 1, DST: 1 }), '2 WR + Flex + DEF');
});

test('two open slots: the most projected points that fit, best first, distinct sets', () => {
  const out = fill(SLATE, { budget: 12000, slots: ['WR', 'FLEX'], limit: 5 });
  assert.equal(out.error, null);
  assert.ok(out.combos.length > 0);
  // Every combo fits, and they come best-first.
  out.combos.forEach((c) => assert.ok(c.salary <= 12000, `${c.salary} over budget`));
  for (let i = 1; i < out.combos.length; i++) assert.ok(out.combos[i - 1].fpts >= out.combos[i].fpts);
  // Nacua ($8,400) leaves nothing for a second player. Brown + McBride is
  // 25.4 for exactly $12,000; the next best is Coker + McBride (23.3).
  assert.deepEqual(names(out.combos[0]), ['Marquise Brown', 'Trey McBride']);
  assert.equal(out.combos[0].fpts, 25.4);
  assert.equal(out.combos[0].left, 0);
  assert.deepEqual(names(out.combos[1]), ['Jalen Coker', 'Trey McBride']);
  // The WR slot took the WR and the flex went to the TE.
  assert.equal(out.combos[0].players.find((p) => p.slot === 'WR').name, 'Marquise Brown');
  assert.equal(out.combos[0].players.find((p) => p.slot === 'FLEX').name, 'Trey McBride');
  // No player set appears twice (WR=A/FLEX=B vs WR=B/FLEX=A).
  const keys = out.combos.map((c) => names(c).join('|'));
  assert.equal(new Set(keys).size, keys.length);
  // Ruled-out players are skipped by default …
  assert.ok(!keys.some((k) => k.includes('Hurt Guy')));
  // … and included on request.
  const withOut = fill(SLATE, { budget: 12000, slots: ['WR', 'FLEX'], skipOut: false });
  assert.deepEqual(names(withOut.combos[0]), ['Hurt Guy', 'Trey McBride']);
});

test('excluded players are matched by either name the slate knows them by', () => {
  const a = fill(SLATE, { budget: 12000, slots: ['WR', 'FLEX'], exclude: ['Kenneth Walker'] });
  assert.ok(!a.combos.some((c) => names(c).includes('Kenneth Walker')));
  const b = fill(SLATE, { budget: 20000, slots: ['WR', 'WR'], exclude: ['hollywood brown'] });
  assert.ok(!b.combos.some((c) => names(c).includes('Marquise Brown')));
});

test('the same player set is never offered twice for two same-type slots', () => {
  const out = fill(SLATE, { budget: 20000, slots: { WR: 2 }, limit: 10 });
  const keys = out.combos.map((c) => names(c).join('|'));
  assert.equal(new Set(keys).size, keys.length);
  assert.deepEqual(names(out.combos[0]), ['Marquise Brown', 'Puka Nacua']);
});

test('readable errors instead of an empty answer', () => {
  assert.match(fill(SLATE, { budget: 0, slots: ['QB'] }).error, /dollars you have left/);
  assert.match(fill(SLATE, { budget: 5000, slots: [] }).error, /at least one open slot/);
  assert.match(fill(SLATE, { budget: 5000, slots: ['K'] }).error, /at least one open slot/);
  assert.match(fill(SLATE, { budget: 70000, slots: ['QB'] }).error, /cap is \$60,000/);
  const tight = fill(SLATE, { budget: 9000, slots: ['QB', 'DST'] });
  assert.match(tight.error, /Nothing fits.*\$11,000.*\$9,000/);
  assert.equal(tight.cheapest, 11000);
  const none = fill(SLATE.filter((r) => r.position !== 'DST'), { budget: 9000, slots: ['DST'] });
  assert.match(none.error, /No DEF on this slate/);
});

// Cross-check the branch-and-bound against a brute-force enumeration on a
// random slate: the top-5 (points, salary) pairs must agree exactly.
function brute(rows, budget, slots, limit) {
  const SP = { QB: ['QB'], RB: ['RB'], WR: ['WR'], TE: ['TE'], FLEX: ['RB', 'WR', 'TE'], DST: ['DST'] };
  const n = slots.length;
  const found = new Map();
  function canFill(set) {
    // Tiny bipartite check by trying every slot permutation (n <= 5 here).
    const used = new Array(n).fill(false);
    function go(i) {
      if (i === set.length) return true;
      for (let s = 0; s < n; s++) {
        if (!used[s] && SP[slots[s]].includes(set[i].position)) {
          used[s] = true;
          if (go(i + 1)) return true;
          used[s] = false;
        }
      }
      return false;
    }
    return go(0);
  }
  function combos(start, set) {
    if (set.length === n) {
      const salary = set.reduce((a, r) => a + r.salary, 0);
      if (salary > budget || !canFill(set)) return;
      const fpts = Math.round(set.reduce((a, r) => a + r.fpts, 0) * 100) / 100;
      found.set(set.map((r) => r.name).sort().join('|'), { fpts, salary });
      return;
    }
    for (let i = start; i < rows.length; i++) combos(i + 1, set.concat(rows[i]));
  }
  combos(0, []);
  return [...found.values()].sort((a, b) => (b.fpts - a.fpts) || (a.salary - b.salary)).slice(0, limit);
}

test('matches a brute-force enumeration on a random slate', () => {
  let seed = 7;
  const rnd = () => { seed = (seed * 48271) % 2147483647; return seed / 2147483647; };
  const positions = ['QB', 'RB', 'RB', 'WR', 'WR', 'WR', 'TE', 'DST'];
  for (let trial = 0; trial < 6; trial++) {
    const rows = [];
    for (let i = 0; i < 26; i++) {
      const pos = positions[Math.floor(rnd() * positions.length)];
      rows.push(row('P' + trial + '_' + i, pos, 3000 + Math.round(rnd() * 70) * 100, Math.round(rnd() * 250) / 10));
    }
    const slots = [['RB', 'WR', 'WR', 'FLEX'], ['TE', 'FLEX', 'DST'], ['QB', 'RB', 'RB'], ['WR', 'WR', 'WR']][trial % 4];
    const budget = 12000 + Math.round(rnd() * 120) * 100;
    const mine = fill(rows, { budget, slots, limit: 5 });
    const ref = brute(rows, budget, slots, 5);
    assert.equal(mine.truncated, false);
    if (!ref.length) { assert.ok(mine.error || mine.combos.length === 0); continue; }
    assert.deepEqual(mine.combos.map((c) => [c.fpts, c.salary]), ref.map((c) => [c.fpts, c.salary]), `trial ${trial}`);
    mine.combos.forEach((c) => {
      const set = new Set(c.players.map((p) => p.name));
      assert.equal(set.size, c.players.length, 'a player used twice');
      c.players.forEach((p) => assert.ok({ QB: ['QB'], RB: ['RB'], WR: ['WR'], TE: ['TE'], FLEX: ['RB', 'WR', 'TE'], DST: ['DST'] }[p.slot].includes(p.position)));
    });
  }
});

test('a whole lineup on a full-size slate finishes exactly and fast', () => {
  let seed = 11;
  const rnd = () => { seed = (seed * 48271) % 2147483647; return seed / 2147483647; };
  const rows = [];
  const make = (pos, count, lo, hi) => {
    for (let i = 0; i < count; i++) {
      const sal = lo + Math.round(rnd() * (hi - lo) / 100) * 100;
      // Projection loosely tracks salary, with noise — like a real slate.
      rows.push(row(pos + i, pos, sal, Math.round((sal / 400 + rnd() * 8) * 10) / 10));
    }
  };
  make('QB', 28, 6000, 9500); make('RB', 70, 4000, 10000); make('WR', 110, 4000, 9500); make('TE', 40, 4000, 8000); make('DST', 28, 3000, 5000);
  const t0 = Date.now();
  const out = fill(rows, { budget: 60000, slots: { QB: 1, RB: 2, WR: 3, TE: 1, FLEX: 1, DST: 1 }, limit: 5 });
  const ms = Date.now() - t0;
  assert.equal(out.error, null);
  assert.equal(out.truncated, false);
  assert.equal(out.combos.length, 5);
  assert.equal(out.combos[0].players.length, 9);
  assert.ok(ms < 5000, `took ${ms}ms`);
});
