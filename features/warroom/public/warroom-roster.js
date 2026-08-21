// "What do I still need?" — the question that decides which position to take
// next, and the one thing a cheat sheet alone cannot answer.
//
// The slot vocabulary is NOT redefined here: it comes from War Chest's
// auction-math.js, which already models a roster (QB/RB/WR/TE/FLEX/K/DST/BN
// and which positions may fill each slot). Two copies would drift, and the
// owner would see his auction board and his draft board disagree about what a
// roster is. War Room adds exactly one thing that an auction board has no use
// for: SUPERFLEX, a flex that also accepts a QB.
//
// Shared server+browser via the UMD wrapper, same as warroom-snake.js.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../../auction/public/auction-math'));
  } else {
    root.WarRoomRoster = factory(root.AuctionMath);
  }
})(typeof self !== 'undefined' ? self : this, function (AM) {
  'use strict';

  var SUPERFLEX_POSITIONS = ['QB', 'RB', 'WR', 'TE'];

  // Fill order matters: a dedicated slot before a flex before the bench, so a
  // drafted RB counts against RB until RB is full and only then against FLEX.
  // Anything else would report "you still need an RB" while an RB sits in your
  // flex — the exact advice that loses a draft.
  var ORDER = ['QB', 'RB', 'WR', 'TE', 'FLEX', 'SUPERFLEX', 'K', 'DST', 'BN'];

  // Slots that make up the starting lineup — the bench is depth, not a need.
  var STARTERS = ORDER.filter(function (s) { return s !== 'BN'; });

  function positionsFor(slot) {
    if (slot === 'SUPERFLEX') return SUPERFLEX_POSITIONS;
    return AM.SLOT_POSITIONS[slot];
  }

  function num(v) {
    var n = Number(v);
    return isFinite(n) && n >= 0 ? Math.floor(n) : 0;
  }

  // However a source spells a position, one bucket. Mirrors the server's
  // positionKey so a photo-read "D/ST" and a registry "DEF" land together.
  function normalizePos(pos) {
    var p = String(pos || '').toUpperCase().replace(/[^A-Z/]/g, '');
    if (!p) return '';
    if (p === 'DEF' || p === 'D/ST' || p === 'DST' || p === 'D') return 'DST';
    if (p === 'PK') return 'K';
    return p;
  }

  // The roster this league starts. `base` is the owner's default counts
  // (settings warroom.roster); FLEX and SUPERFLEX come from the league profile,
  // because those are exactly the fields league.profiles already carries and a
  // single global assumption about them is a bug.
  function shapeFor(profile, base) {
    var shape = {};
    ORDER.forEach(function (s) { shape[s] = 0; });
    var b = base || AM.DEFAULT_ROSTER;
    Object.keys(b).forEach(function (k) {
      if (shape[k] !== undefined) shape[k] = num(b[k]);
    });
    if (profile) {
      if (profile.flex !== undefined && profile.flex !== null) shape.FLEX = num(profile.flex);
      shape.SUPERFLEX = profile.superflex ? 1 : 0;
    }
    return shape;
  }

  // Place my drafted players into slots. Returns per-slot { need, filled,
  // players } plus the starting slots still empty.
  function fill(myPicks, shape) {
    var slots = {};
    ORDER.forEach(function (s) {
      slots[s] = { slot: s, need: num(shape && shape[s]), filled: 0, players: [] };
    });

    (myPicks || []).forEach(function (p) {
      var pos = normalizePos(p && p.position);
      var placed = false;
      for (var i = 0; i < ORDER.length && !placed; i++) {
        var slot = slots[ORDER[i]];
        if (slot.filled >= slot.need) continue;
        var accepts = positionsFor(ORDER[i]);
        // accepts === null is the bench: it takes anyone, including a player
        // whose position never resolved (a free-typed name).
        if (accepts === null || (pos && accepts.indexOf(pos) >= 0)) {
          slot.filled++;
          slot.players.push(p);
          placed = true;
        }
      }
      // Past every slot including the bench. Still counted — the owner drafted
      // him, and silently dropping him would misreport the roster.
      if (!placed) {
        slots.BN.filled++;
        slots.BN.players.push(p);
      }
    });

    var needs = STARTERS.filter(function (s) { return slots[s].filled < slots[s].need; });
    return { slots: slots, order: ORDER, starters: STARTERS, needs: needs };
  }

  // Does drafting this position fill a starting slot I still have open?
  // Used to mark the positions that actually matter right now.
  function fillsNeed(position, filled) {
    var pos = normalizePos(position);
    if (!pos || !filled) return false;
    return filled.needs.some(function (s) {
      var accepts = positionsFor(s);
      return accepts !== null && accepts.indexOf(pos) >= 0;
    });
  }

  return {
    ORDER: ORDER,
    STARTERS: STARTERS,
    SUPERFLEX_POSITIONS: SUPERFLEX_POSITIONS,
    positionsFor: positionsFor,
    normalizePos: normalizePos,
    shapeFor: shapeFor,
    fill: fill,
    fillsNeed: fillsNeed,
  };
});
