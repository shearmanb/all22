// "Will he make it back to me?" — the PRD's headline War Room number.
//
// Treat the pick a player goes at as normally distributed around his ADP with
// spread `stdev`, and the chance he is still on the board when pick N arrives
// is the chance that draw lands after N:  P = 1 - Φ((N - adp) / stdev).
//
// Shared verbatim by the browser (warroom-draft.html) and available to the
// server, same UMD pattern as warroom-snake.js / auction-math.js.
//
// OPEN DECISION (PRD §17 #4): sites publish ADP but not always a spread. When
// stdev is missing we derive one from the published high/low range, and when
// that is missing too we fall back to a flat default. Both fallbacks are
// REPORTED (`basis` on the detailed call) so the UI can say the number is an
// estimate rather than quietly presenting a guess as measured.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.WarRoomAvailability = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // With no spread published at all, assume this many picks of noise. A round
  // in a 12-team league is 12 picks; real ADP spreads run wider than that late
  // and tighter early, so this is deliberately middling — and always labelled.
  var DEFAULT_STDEV = 12;
  // high/low are usually near-extremes of the sample rather than true bounds;
  // treating the range as ~4 standard deviations wide is the usual rule of thumb.
  var RANGE_TO_STDEV = 4;

  function num(v) {
    if (v === null || v === undefined || v === '') return null;
    var n = Number(v);
    return isFinite(n) ? n : null;
  }

  // Abramowitz & Stegun 7.1.26 — max error ~1.5e-7, plenty for a percentage.
  function erf(x) {
    var sign = x < 0 ? -1 : 1;
    x = Math.abs(x);
    var a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741,
        a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
    var t = 1 / (1 + p * x);
    var y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
    return sign * y;
  }

  // Standard normal CDF.
  function normalCdf(z) {
    return 0.5 * (1 + erf(z / Math.SQRT2));
  }

  // Which spread to use, and where it came from. range = { high, low }.
  function spreadFor(stdev, range) {
    var s = num(stdev);
    if (s !== null && s > 0) return { stdev: s, basis: 'published' };
    var hi = num(range && range.high), lo = num(range && range.low);
    if (hi !== null && lo !== null && hi > lo) {
      return { stdev: (hi - lo) / RANGE_TO_STDEV, basis: 'range' };
    }
    return { stdev: DEFAULT_STDEV, basis: 'default' };
  }

  // Percent (0-100) chance the player is still available AT pick `atPick`.
  // Null when there is no ADP to reason from — the caller shows "—", never a
  // made-up number.
  function detail(adp, stdev, atPick, range) {
    var a = num(adp), n = num(atPick);
    if (a === null || n === null) return null;
    var sp = spreadFor(stdev, range);
    // P(drafted at a pick later than this one).
    var pct = (1 - normalCdf((n - a) / sp.stdev)) * 100;
    return {
      pct: Math.max(0, Math.min(100, pct)),
      stdev: sp.stdev,
      basis: sp.basis,
      estimated: sp.basis !== 'published',
    };
  }

  function pctAvailable(adp, stdev, atPick, range) {
    var d = detail(adp, stdev, atPick, range);
    return d ? d.pct : null;
  }

  return {
    pctAvailable: pctAvailable,
    detail: detail,
    spreadFor: spreadFor,
    normalCdf: normalCdf,
    DEFAULT_STDEV: DEFAULT_STDEV,
    RANGE_TO_STDEV: RANGE_TO_STDEV,
  };
});
