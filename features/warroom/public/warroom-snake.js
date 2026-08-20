// War Room snake-draft math — the one place serpentine pick arithmetic lives.
// Shared verbatim by the server (router.js requires it) and the browser
// (warroom-draft.html loads it as /warroom-snake.js), which is why it lives in
// public/ with the UMD-style wrapper — the auction-math.js precedent. No build
// step, one source of truth for the numbers.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.WarRoomSnake = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Overall pick number (1-based) -> { round, slot, pickInRound }. Odd rounds
  // run left-to-right (slot 1..teams), even rounds reverse — the serpentine.
  function overallToSlot(overall, teams) {
    var o = Math.floor(Number(overall)), t = Math.floor(Number(teams));
    if (!(o >= 1) || !(t >= 1)) return null;
    var round = Math.floor((o - 1) / t) + 1;
    var pickInRound = ((o - 1) % t) + 1;
    var slot = (round % 2 === 1) ? pickInRound : (t - pickInRound + 1);
    return { round: round, slot: slot, pickInRound: pickInRound };
  }

  // (round, slot) -> overall pick number, inverse of overallToSlot.
  function slotToOverall(round, slot, teams) {
    var r = Math.floor(Number(round)), s = Math.floor(Number(slot)), t = Math.floor(Number(teams));
    if (!(r >= 1) || !(s >= 1) || !(t >= 1) || s > t) return null;
    var pickInRound = (r % 2 === 1) ? s : (t - s + 1);
    return (r - 1) * t + pickInRound;
  }

  // Every overall pick belonging to draft slot `mySlot`, in order.
  function myPickOveralls(mySlot, teams, rounds) {
    var out = [];
    for (var r = 1; r <= rounds; r++) {
      var o = slotToOverall(r, mySlot, teams);
      if (o) out.push(o);
    }
    return out;
  }

  // The lowest overall not in `taken` (a Set or array of overalls), or null
  // when the board is full. Fills gaps left by deletes — matching the physical
  // board, where a pulled sticker's spot is what gets filled next.
  function nextOpenOverall(taken, teams, rounds) {
    var has = (taken instanceof Set) ? taken : new Set(taken || []);
    var total = Math.floor(teams) * Math.floor(rounds);
    for (var o = 1; o <= total; o++) {
      if (!has.has(o)) return o;
    }
    return null;
  }

  // "Pick 3.07" — the label everyone at a draft speaks in.
  function pickLabel(overall, teams) {
    var p = overallToSlot(overall, teams);
    if (!p) return '';
    return p.round + '.' + (p.pickInRound < 10 ? '0' + p.pickInRound : p.pickInRound);
  }

  // My next pick strictly after `afterOverall` (use the current open pick - 1
  // to include a pick that is on the clock now). Null when I have none left.
  function myNextPick(afterOverall, mySlot, teams, rounds) {
    var mine = myPickOveralls(mySlot, teams, rounds);
    for (var i = 0; i < mine.length; i++) {
      if (mine[i] > afterOverall) return mine[i];
    }
    return null;
  }

  return {
    overallToSlot: overallToSlot,
    slotToOverall: slotToOverall,
    myPickOveralls: myPickOveralls,
    nextOpenOverall: nextOpenOverall,
    pickLabel: pickLabel,
    myNextPick: myNextPick,
  };
});
