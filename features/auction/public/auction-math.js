// War Chest budget math — the one place the auction formulas live. This file is
// shared verbatim by the server (router.js requires it) and the browser
// (auction.html loads it as /auction-math.js), which is why it lives in public/
// and uses the UMD-style wrapper instead of a bare module.exports. No build
// step, one source of truth for the numbers.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AuctionMath = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Canonical slot-type order — the budget board always renders in this order.
  var SLOT_ORDER = ['QB', 'RB', 'WR', 'TE', 'FLEX', 'K', 'DST', 'BN'];
  var SLOT_LABELS = { QB: 'QB', RB: 'RB', WR: 'WR', TE: 'TE', FLEX: 'Flex', K: 'K', DST: 'DST', BN: 'Bench' };
  // Which master-list positions can fill each slot type (null = anyone).
  var SLOT_POSITIONS = {
    QB: ['QB'], RB: ['RB'], WR: ['WR'], TE: ['TE'],
    FLEX: ['RB', 'WR', 'TE'], K: ['K', 'PK'], DST: ['DST'], BN: null,
  };
  var DEFAULT_ROSTER = { QB: 1, RB: 2, WR: 3, TE: 1, FLEX: 2, K: 1, DST: 1, BN: 6 };

  // Parse a $ field: '' / null / undefined mean "not set" (null); anything else
  // must be a finite non-negative number or the whole value is rejected (null).
  function money(value) {
    if (value === null || value === undefined || value === '') return null;
    var n = Number(value);
    if (!isFinite(n) || n < 0) return null;
    return n;
  }

  // Coerce a roster config to sane integer counts on the known slot types only.
  function cleanRoster(input) {
    var out = {};
    var src = input && typeof input === 'object' ? input : {};
    SLOT_ORDER.forEach(function (slot) {
      var n = Math.round(Number(src[slot]));
      out[slot] = isFinite(n) && n > 0 ? Math.min(n, 30) : 0;
    });
    return out;
  }

  function totalSlots(roster) {
    return SLOT_ORDER.reduce(function (sum, slot) { return sum + (roster[slot] || 0); }, 0);
  }

  // A roster config -> the ordered list of slot rows it implies.
  function expandRoster(roster) {
    var rows = [];
    SLOT_ORDER.forEach(function (slot) {
      for (var i = 1; i <= (roster[slot] || 0); i++) rows.push({ slot: slot, slot_num: i });
    });
    return rows;
  }

  // A slot with nothing typed into it — safe to delete when the roster shrinks.
  // A plan $ alone doesn't count as content; the plan belongs to the slot, not a player.
  function isEmptySlot(s) {
    return !s.player_id && !(s.player_name && String(s.player_name).trim()) && money(s.paid) === null;
  }

  // Diff existing slot rows against a new roster config.
  // Returns { add: [{slot, slot_num}], removeIds: [id], blocked: ['RB3', ...] } —
  // blocked slots have a player or price on them and must be cleared by hand first.
  function reconcileSlots(existing, roster) {
    var add = [], removeIds = [], blocked = [];
    SLOT_ORDER.forEach(function (slot) {
      var want = roster[slot] || 0;
      var have = existing.filter(function (s) { return s.slot === slot; });
      var nums = {};
      have.forEach(function (s) { nums[s.slot_num] = true; });
      for (var i = 1; i <= want; i++) if (!nums[i]) add.push({ slot: slot, slot_num: i });
      have.forEach(function (s) {
        if (s.slot_num <= want) return;
        if (isEmptySlot(s)) removeIds.push(s.id);
        else blocked.push(SLOT_LABELS[slot] + s.slot_num);
      });
    });
    return { add: add, removeIds: removeIds, blocked: blocked };
  }

  // The heart of the calculator — the spreadsheet's bottom rows.
  //   spent      = sum of paid (ACT)
  //   committed  = paid where filled, else plan (the sheet's AMOUNT column)
  //   remaining  = budget - spent (real cash in hand)
  //   maxBid     = remaining minus $1 held back for every OTHER open slot
  //   planOpen   = planned $ still earmarked for open slots
  //   slack      = budget - committed (negative = your plan is over budget, the sheet's o/u)
  //   avgPerOpen = remaining spread evenly over open slots
  function summarize(budget, slots) {
    var b = money(budget) || 0;
    var spent = 0, committed = 0, open = 0, filled = 0, planOpen = 0;
    (slots || []).forEach(function (s) {
      var paid = money(s.paid);
      var plan = money(s.plan);
      if (paid !== null) {
        filled++;
        spent += paid;
        committed += paid;
      } else {
        open++;
        committed += plan || 0;
        planOpen += plan || 0;
      }
    });
    var remaining = b - spent;
    return {
      budget: b,
      spent: spent,
      committed: committed,
      remaining: remaining,
      openSlots: open,
      filledSlots: filled,
      planOpen: planOpen,
      slack: b - committed,
      maxBid: open > 0 ? Math.max(0, remaining - (open - 1)) : 0,
      avgPerOpen: open > 0 ? remaining / open : null,
    };
  }

  return {
    SLOT_ORDER: SLOT_ORDER,
    SLOT_LABELS: SLOT_LABELS,
    SLOT_POSITIONS: SLOT_POSITIONS,
    DEFAULT_ROSTER: DEFAULT_ROSTER,
    money: money,
    cleanRoster: cleanRoster,
    totalSlots: totalSlots,
    expandRoster: expandRoster,
    isEmptySlot: isEmptySlot,
    reconcileSlots: reconcileSlots,
    summarize: summarize,
  };
});
