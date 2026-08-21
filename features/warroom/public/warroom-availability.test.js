const test = require('node:test');
const assert = require('node:assert');
const av = require('./warroom-availability');

test('normalCdf matches the textbook values', () => {
  assert.ok(Math.abs(av.normalCdf(0) - 0.5) < 1e-6);
  assert.ok(Math.abs(av.normalCdf(1) - 0.8413) < 1e-3);
  assert.ok(Math.abs(av.normalCdf(-1) - 0.1587) < 1e-3);
  assert.ok(Math.abs(av.normalCdf(1.96) - 0.975) < 1e-3);
});

test('at his own ADP a player is a coin flip', () => {
  assert.ok(Math.abs(av.pctAvailable(24, 6, 24) - 50) < 0.01);
});

test('further past his ADP, less likely to last; before it, more likely', () => {
  const early = av.pctAvailable(24, 6, 12);   // asking 12 picks early
  const late = av.pctAvailable(24, 6, 36);    // asking 12 picks late
  assert.ok(early > 95, `early=${early}`);
  assert.ok(late < 5, `late=${late}`);
  // Monotonic: the later the pick, the worse the odds.
  const seq = [12, 18, 24, 30, 36].map((p) => av.pctAvailable(24, 6, p));
  for (let i = 1; i < seq.length; i++) assert.ok(seq[i] < seq[i - 1]);
});

test('a wider spread pulls the odds toward the middle', () => {
  // Asking 10 picks past ADP: a tight distribution says no, a loose one says maybe.
  const tight = av.pctAvailable(24, 3, 34);
  const loose = av.pctAvailable(24, 20, 34);
  assert.ok(tight < 1, `tight=${tight}`);
  assert.ok(loose > 25 && loose < 50, `loose=${loose}`);
});

test('missing stdev falls back to the published range, and says so', () => {
  const d = av.detail(24, null, 24, { high: 40, low: 8 });
  assert.equal(d.basis, 'range');
  assert.equal(d.estimated, true);
  assert.equal(d.stdev, 8);              // (40 - 8) / 4
  assert.ok(Math.abs(d.pct - 50) < 0.01);
});

test('no spread at all falls back to the flat default, and says so', () => {
  const d = av.detail(24, null, 24, null);
  assert.equal(d.basis, 'default');
  assert.equal(d.estimated, true);
  assert.equal(d.stdev, av.DEFAULT_STDEV);
});

test('a published stdev is used as-is and is not flagged as an estimate', () => {
  const d = av.detail(24, 7, 30, { high: 99, low: 1 });
  assert.equal(d.basis, 'published');
  assert.equal(d.estimated, false);
  assert.equal(d.stdev, 7);
});

test('no ADP means no number — never a made-up one', () => {
  assert.equal(av.pctAvailable(null, 6, 24), null);
  assert.equal(av.pctAvailable(24, 6, null), null);
  assert.equal(av.detail('', 6, 24), null);
});

test('the percentage is always a real percentage', () => {
  for (const at of [1, 50, 300]) {
    for (const adp of [1, 24, 200]) {
      const pct = av.pctAvailable(adp, 5, at);
      assert.ok(pct >= 0 && pct <= 100, `adp=${adp} at=${at} -> ${pct}`);
    }
  }
});

test('a zero or negative published stdev is ignored, not divided by', () => {
  assert.equal(av.spreadFor(0, null).basis, 'default');
  assert.equal(av.spreadFor(-3, { high: 30, low: 10 }).basis, 'range');
});

// --- conditioning on "he's still on the board" ------------------------------
// The mid-draft question is never "what were his odds of reaching the current
// pick" — he did. It's "given that, does he last the gap to mine".
test('a faller shows real odds, not the 0% the unconditional model gives', () => {
  // ADP 7, tight spread, still available at pick 21, my pick is 24.
  const uncond = av.pctAvailable(7, 3, 24);
  const cond = av.pctAvailable(7, 3, 24, null, 21);
  assert.ok(uncond < 0.001, `unconditional=${uncond} (the nonsense reading)`);
  assert.ok(cond > 0 && cond < 20, `conditional=${cond} (small but real)`);
});

test('conditioning never lowers the odds', () => {
  for (const at of [10, 20, 30, 50]) {
    const uncond = av.pctAvailable(24, 6, at);
    const cond = av.pctAvailable(24, 6, at, null, 8);
    assert.ok(cond >= uncond - 1e-9, `at=${at}: cond=${cond} uncond=${uncond}`);
  }
});

test('when my pick IS the pick on the clock, he is simply there: 100%', () => {
  assert.equal(av.pctAvailable(24, 6, 15, null, 15), 100);
  assert.equal(av.pctAvailable(3, 2, 15, null, 15), 100, 'even a long-gone ADP');
});

test('the shorter the gap to my pick, the better the odds', () => {
  const seq = [16, 20, 24, 30].map((at) => av.pctAvailable(24, 6, at, null, 15));
  for (let i = 1; i < seq.length; i++) assert.ok(seq[i] < seq[i - 1], seq.join(','));
});

test('omitting fromPick keeps the old unconditional behaviour exactly', () => {
  assert.ok(Math.abs(av.pctAvailable(24, 6, 24) - 50) < 0.01);
  assert.equal(av.detail(24, 6, 30).conditioned, false);
  assert.equal(av.detail(24, 6, 30, null, 20).conditioned, true);
});

test('deep-tail survival is finite and sane, not erf-polynomial noise', () => {
  // z = 4 and z = 6 are far beyond the erf approximation's usable range.
  const s4 = av.survival(4), s6 = av.survival(6);
  assert.ok(s4 > 1e-6 && s4 < 1e-4, `S(4)=${s4}`);
  assert.ok(s6 > 0 && s6 < s4, `S(6)=${s6}`);
  // Continuity across the switchover: no cliff at z=3.5.
  const below = av.survival(3.49), above = av.survival(3.51);
  assert.ok(below > above && below / above < 1.35, `${below} vs ${above}`);
});
