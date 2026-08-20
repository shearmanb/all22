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
