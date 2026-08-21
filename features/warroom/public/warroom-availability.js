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

  // Survival function P(drafted later than z), with a Mills-ratio tail for
  // z > 3.5 where the erf polynomial's absolute error (~1.5e-7) would swamp
  // the true value. Deep tails matter here: a faller taken "for sure" by the
  // model is exactly the player everyone is watching slide.
  function survival(z) {
    if (z > 3.5) {
      return Math.exp(-z * z / 2) / (z * Math.sqrt(2 * Math.PI));
    }
    return 1 - normalCdf(z);
  }

  // Percent (0-100) chance the player is still available AT pick `atPick`.
  //
  // `fromPick` is the pick on the clock right now. When given, the estimate is
  // CONDITIONED on the player having survived to it: the mid-draft question is
  // never "what were his odds of reaching pick 21" (he did — he's on the
  // board), it is "given he's still here at 21, does he last the gap to my
  // pick at 24". Unconditionally a faller shows ~0% forever, which reads as
  // nonsense next to his name on the available list.
  //
  //   P(X > at | X > from) = S((at-adp)/σ) / S((from-adp)/σ)
  //
  // Null when there is no ADP to reason from — the caller shows "—", never a
  // made-up number.
  function detail(adp, stdev, atPick, range, fromPick) {
    var a = num(adp), n = num(atPick);
    if (a === null || n === null) return null;
    var sp = spreadFor(stdev, range);
    var pct;
    var from = num(fromPick);
    if (from !== null && from >= n) {
      // My pick is the one on the clock (or somehow earlier): he's right there.
      pct = 100;
    } else {
      var sAt = survival((n - a) / sp.stdev);
      if (from !== null) {
        var sFrom = survival((from - a) / sp.stdev);
        pct = sFrom > 0 ? (sAt / sFrom) * 100 : 0;
      } else {
        pct = sAt * 100;
      }
    }
    return {
      pct: Math.max(0, Math.min(100, pct)),
      stdev: sp.stdev,
      basis: sp.basis,
      estimated: sp.basis !== 'published',
      conditioned: from !== null,
    };
  }

  function pctAvailable(adp, stdev, atPick, range, fromPick) {
    var d = detail(adp, stdev, atPick, range, fromPick);
    return d ? d.pct : null;
  }

  return {
    pctAvailable: pctAvailable,
    detail: detail,
    spreadFor: spreadFor,
    normalCdf: normalCdf,
    survival: survival,
    DEFAULT_STDEV: DEFAULT_STDEV,
    RANGE_TO_STDEV: RANGE_TO_STDEV,
  };
});
