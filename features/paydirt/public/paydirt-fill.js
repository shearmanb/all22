// Pay Dirt "Fill the rest" — given the dollars left under FanDuel's cap and
// the lineup slots still open, the combinations of slate players that fit
// the budget with the most projected points. Pure math, no DOM, no DB: the
// browser runs it on the table it already holds (paydirt.html loads it as
// /paydirt-fill.js) and node --test runs it against golden cases, which is why
// it lives in public/ with the same UMD wrapper as auction-math.js.
//
// "Best" is the most projected points that fits — once the budget is fixed,
// points per dollar is a tool, not the goal. Combos are distinct player SETS:
// WR=A/FLEX=B and WR=B/FLEX=A are the same lineup and appear once.
//
// The search is an exact branch-and-bound, not a heuristic: slots are filled
// in order from candidate lists sorted by projection, a branch dies the moment
// its best possible finish can't beat the Nth combo already found or its
// cheapest possible finish can't fit the budget. Dedicated slots (RB, WR, TE)
// fill before FLEX, and every slot must draw a LATER player from its position's
// list than the last slot that drew from that position — that one rule removes
// both permutations of a same-type pair and the WR/FLEX double-count above. A
// node cap guards the pathological case (every slot open on a huge slate);
// when it trips the result says so rather than passing itself off as exact.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PaydirtFill = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // FanDuel's NFL lineup: QB, RB, RB, WR, WR, WR, TE, FLEX, DEF under $60,000.
  var SLOT_ORDER = ['QB', 'RB', 'WR', 'TE', 'FLEX', 'DST'];
  var SLOT_LABELS = { QB: 'QB', RB: 'RB', WR: 'WR', TE: 'TE', FLEX: 'Flex', DST: 'DEF' };
  var SLOT_POSITIONS = { QB: ['QB'], RB: ['RB'], WR: ['WR'], TE: ['TE'], FLEX: ['RB', 'WR', 'TE'], DST: ['DST'] };
  var LINEUP = { QB: 1, RB: 2, WR: 3, TE: 1, FLEX: 1, DST: 1 };
  var SALARY_CAP = 60000;
  var DEFAULT_LIMIT = 5;
  var NODE_CAP = 2000000;

  function nameKey(s) {
    return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  }

  // { WR: 2, FLEX: 1 } or ['WR', 'WR', 'FLEX'] -> ['WR', 'WR', 'FLEX'] in
  // fill order (dedicated before FLEX). Unknown slot names are dropped.
  function expandSlots(input) {
    var counts = {};
    if (Array.isArray(input)) {
      input.forEach(function (s) { s = String(s || '').toUpperCase(); if (SLOT_POSITIONS[s]) counts[s] = (counts[s] || 0) + 1; });
    } else if (input && typeof input === 'object') {
      Object.keys(input).forEach(function (s) {
        var k = String(s).toUpperCase();
        var n = Math.round(Number(input[s]));
        if (SLOT_POSITIONS[k] && isFinite(n) && n > 0) counts[k] = Math.min(n, 9);
      });
    }
    var out = [];
    SLOT_ORDER.forEach(function (s) { for (var i = 0; i < (counts[s] || 0); i++) out.push(s); });
    return out;
  }

  function isOut(row) {
    var inj = String(row.injury || '').toUpperCase();
    return inj === 'O' || inj === 'IR';
  }

  // rows: Pay Dirt's table rows [{ name, fd_name, position, team, opp, salary, fpts, injury }]
  // opts: { budget, slots, exclude: [names], limit, skipOut (default true) }
  // Returns { combos: [{ players: [{ slot, ...row }], salary, fpts, left }],
  //           slots, budget, truncated, cheapest, error }
  function fill(rows, opts) {
    opts = opts || {};
    var budget = Number(opts.budget);
    var slots = expandSlots(opts.slots);
    var limit = Math.max(1, Math.round(Number(opts.limit)) || DEFAULT_LIMIT);
    var skipOut = opts.skipOut !== false;
    var result = { combos: [], slots: slots, budget: budget, truncated: false, cheapest: null, error: null };

    if (!isFinite(budget) || budget <= 0) { result.error = 'Enter the dollars you have left.'; return result; }
    if (!slots.length) { result.error = 'Pick at least one open slot.'; return result; }
    if (budget > SALARY_CAP) { result.error = 'FanDuel\'s cap is $' + SALARY_CAP.toLocaleString() + ' — you can\'t have more than that left.'; return result; }

    var excluded = {};
    (opts.exclude || []).forEach(function (n) { var k = nameKey(n); if (k) excluded[k] = true; });

    // Candidate lists per position, best projection first (cheaper breaks ties).
    var byPos = {};
    (rows || []).forEach(function (r) {
      if (!r || !isFinite(Number(r.salary)) || !isFinite(Number(r.fpts))) return;
      if (skipOut && isOut(r)) return;
      if (excluded[nameKey(r.name)] || (r.fd_name && excluded[nameKey(r.fd_name)])) return;
      (byPos[r.position] = byPos[r.position] || []).push(r);
    });
    Object.keys(byPos).forEach(function (p) {
      byPos[p].sort(function (a, b) { return (b.fpts - a.fpts) || (a.salary - b.salary) || String(a.name).localeCompare(String(b.name)); });
    });

    // Each slot's candidates: [{ row, pos, idx }] merged across its positions,
    // still sorted by projection so the bound break below is valid.
    var cands = slots.map(function (slot) {
      var list = [];
      SLOT_POSITIONS[slot].forEach(function (p) {
        (byPos[p] || []).forEach(function (r, i) { list.push({ row: r, pos: p, idx: i }); });
      });
      list.sort(function (a, b) { return (b.row.fpts - a.row.fpts) || (a.row.salary - b.row.salary); });
      return list;
    });
    for (var s = 0; s < slots.length; s++) {
      if (!cands[s].length) {
        result.error = 'No ' + SLOT_LABELS[slots[s]] + ' on this slate is left to choose from.';
        return result;
      }
    }

    // Suffix bounds for the slots still ahead of slot i: the best projection
    // ignoring money (bestAhead), the lowest salary (minAhead), and the lowest
    // salary per slot (minSal).
    var n = slots.length;
    var bestAhead = new Array(n + 1), minAhead = new Array(n + 1), minSal = new Array(n);
    bestAhead[n] = 0; minAhead[n] = 0;
    for (var i = n - 1; i >= 0; i--) {
      var best = 0, cheap = Infinity;
      cands[i].forEach(function (c) { if (c.row.fpts > best) best = c.row.fpts; if (c.row.salary < cheap) cheap = c.row.salary; });
      bestAhead[i] = bestAhead[i + 1] + best;
      minSal[i] = cheap;
      minAhead[i] = minAhead[i + 1] + cheap;
    }
    result.cheapest = minAhead[0];
    if (minAhead[0] > budget) {
      result.error = 'Nothing fits: the cheapest way to fill ' + describeSlots(slots) + ' costs about $' + minAhead[0].toLocaleString() + ' and you have $' + budget.toLocaleString() + '.';
      return result;
    }

    // Budget-aware bound. Per slot, candidates by salary with a running best
    // projection, so "the most a slot can project for at most $s" is a binary
    // search. The projection bound alone is useless on a real slate (the best
    // players are the expensive ones), and without this the search walks every
    // unaffordable branch to its end.
    var bySal = cands.map(function (list) {
      var sorted = list.slice().sort(function (a, b) { return a.row.salary - b.row.salary; });
      var salaries = [], bestAt = [], run = -Infinity;
      sorted.forEach(function (c) { run = Math.max(run, c.row.fpts); salaries.push(c.row.salary); bestAt.push(run); });
      return { salaries: salaries, bestAt: bestAt };
    });
    function bestUnder(i, s) {
      var t = bySal[i], lo = 0, hi = t.salaries.length - 1, at = -1;
      while (lo <= hi) { var mid = (lo + hi) >> 1; if (t.salaries[mid] <= s) { at = mid; lo = mid + 1; } else hi = mid - 1; }
      return at < 0 ? -Infinity : t.bestAt[at];
    }
    // Second bound: the LP relaxation. Each slot's (salary, projection) pairs
    // are replaced by their concave upper hull above the slot's cheapest
    // option, every hull segment across the remaining slots is taken in order
    // of points per extra dollar until the spare budget runs out (the last one
    // fractionally). That is the most the remaining slots can project for
    // the money under any assignment, so it never cuts a real answer.
    var cheapPtsAhead = new Array(n + 1);
    cheapPtsAhead[n] = 0;
    var segsOf = cands.map(function (list, j) {
      var byS = list.slice().sort(function (a, b) { return (a.row.salary - b.row.salary) || (b.row.fpts - a.row.fpts); });
      var pts = [];
      byS.forEach(function (c) {
        var last = pts[pts.length - 1];
        if (last && last[0] === c.row.salary) return;             // same salary: the best was first
        if (last && c.row.fpts <= last[1]) return;                 // dominated: dearer and no better
        pts.push([c.row.salary, c.row.fpts]);
      });
      var hull = [];                                               // upper concave hull, rising only
      pts.forEach(function (pt) {
        while (hull.length >= 2) {
          var a = hull[hull.length - 2], b = hull[hull.length - 1];
          if ((b[1] - a[1]) * (pt[0] - b[0]) <= (pt[1] - b[1]) * (b[0] - a[0])) hull.pop(); else break;
        }
        hull.push(pt);
      });
      var segs = [];
      for (var q = 1; q < hull.length; q++) {
        var cost = hull[q][0] - hull[q - 1][0], gain = hull[q][1] - hull[q - 1][1];
        if (cost > 0 && gain > 0) segs.push({ cost: cost, gain: gain, slope: gain / cost });
      }
      return { cheapPts: pts[0][1], segs: segs };
    });
    for (var j = n - 1; j >= 0; j--) cheapPtsAhead[j] = cheapPtsAhead[j + 1] + segsOf[j].cheapPts;
    // For each suffix, its segments by slope with running cost/gain.
    var lp = [];
    for (var i2 = 0; i2 <= n; i2++) {
      var segs = [];
      for (var j2 = i2; j2 < n; j2++) segs = segs.concat(segsOf[j2].segs);
      segs.sort(function (a, b) { return b.slope - a.slope; });
      var cost = [0], gain = [0];
      segs.forEach(function (sg) { cost.push(cost[cost.length - 1] + sg.cost); gain.push(gain[gain.length - 1] + sg.gain); });
      lp.push({ segs: segs, cost: cost, gain: gain });
    }
    function lpBound(i, spare) {
      var t = lp[i], lo = 0, hi = t.cost.length - 1, at = 0;
      while (lo <= hi) { var mid = (lo + hi) >> 1; if (t.cost[mid] <= spare) { at = mid; lo = mid + 1; } else hi = mid - 1; }
      var out = cheapPtsAhead[i] + t.gain[at];
      if (at < t.segs.length) out += (spare - t.cost[at]) * t.segs[at].slope;
      return out;
    }
    // Most the slots from i on can project with $remaining to spend.
    function boundAhead(i, remaining) {
      if (i >= n) return 0;
      var spare = remaining - minAhead[i];
      if (spare < 0) return -Infinity;
      var a = lpBound(i, spare);
      var b = 0;
      for (var j = i; j < n; j++) {
        b += bestUnder(j, minSal[j] + spare);
        if (b >= a) return a;
      }
      return Math.min(a, b);
    }

    var found = [];          // top combos, best first
    var nodes = 0;
    var chosen = new Array(n);
    var lastIdx = {};        // position -> index of the last player drawn from it

    function threshold() { return found.length >= limit ? found[found.length - 1].fpts : -Infinity; }
    function record(fpts, salary) {
      var players = chosen.map(function (c, k) {
        var p = {};
        Object.keys(c.row).forEach(function (key) { p[key] = c.row[key]; });
        p.slot = slots[k];
        return p;
      });
      var combo = { players: players, fpts: Math.round(fpts * 100) / 100, salary: salary, left: budget - salary };
      var at = found.length;
      while (at > 0 && (found[at - 1].fpts < combo.fpts || (found[at - 1].fpts === combo.fpts && found[at - 1].salary > combo.salary))) at--;
      found.splice(at, 0, combo);
      if (found.length > limit) found.pop();
    }

    var pickedK = new Array(n);  // position in its list of the pick for slot i

    function dfs(i, fpts, salary) {
      if (result.truncated) return;
      if (i === n) { record(fpts, salary); return; }
      var list = cands[i];
      // A slot of the same type as the one before it shares its list: drawing
      // strictly later in it is what keeps {A, B} from also appearing as {B, A}.
      var start = i > 0 && slots[i] === slots[i - 1] ? pickedK[i - 1] + 1 : 0;
      for (var k = start; k < list.length; k++) {
        if (++nodes > NODE_CAP) { result.truncated = true; return; }
        var c = list[k];
        // Sorted by projection: nothing after this can beat the Nth found.
        if (fpts + c.row.fpts + bestAhead[i + 1] < threshold()) break;
        // Cheaper candidates may still follow, so a budget miss only skips —
        // as does a branch whose affordable finish can't beat the Nth found.
        var spent = salary + c.row.salary;
        if (spent + minAhead[i + 1] > budget) continue;
        if (i + 1 < n && fpts + c.row.fpts + boundAhead(i + 1, budget - spent) < threshold()) continue;
        // FLEX after a dedicated slot of the same position takes the later
        // player, so WR=A/FLEX=B and WR=B/FLEX=A are one lineup, found once.
        var prev = lastIdx.hasOwnProperty(c.pos) ? lastIdx[c.pos] : -1;
        if (c.idx <= prev) continue;
        chosen[i] = c;
        pickedK[i] = k;
        lastIdx[c.pos] = c.idx;
        dfs(i + 1, fpts + c.row.fpts, salary + c.row.salary);
        if (prev < 0) delete lastIdx[c.pos]; else lastIdx[c.pos] = prev;
        if (result.truncated) return;
      }
    }
    dfs(0, 0, 0);
    result.combos = found;
    return result;
  }

  function describeSlots(slots) {
    var counts = {};
    expandSlots(slots).forEach(function (s) { counts[s] = (counts[s] || 0) + 1; });
    return SLOT_ORDER.filter(function (s) { return counts[s]; })
      .map(function (s) { return (counts[s] > 1 ? counts[s] + ' ' : '') + SLOT_LABELS[s]; }).join(' + ');
  }

  return {
    SLOT_ORDER: SLOT_ORDER,
    SLOT_LABELS: SLOT_LABELS,
    SLOT_POSITIONS: SLOT_POSITIONS,
    LINEUP: LINEUP,
    SALARY_CAP: SALARY_CAP,
    DEFAULT_LIMIT: DEFAULT_LIMIT,
    expandSlots: expandSlots,
    describeSlots: describeSlots,
    fill: fill,
  };
});
