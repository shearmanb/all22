// Suggest a draft strategy based on the user's own picks.
function suggest(myPicks) {
  if (!myPicks || myPicks.length === 0) return 'Balanced';

  const pos = (p) => (p.position || '').toUpperCase();
  const earlyBy = (position, maxRound) =>
    myPicks.filter((p) => pos(p) === position && p.round <= maxRound).length;

  const earlyTEs = earlyBy('TE', 3);
  const earlyRBs = earlyBy('RB', 3);
  const allQBs = myPicks.filter((p) => pos(p) === 'QB');
  const firstQBRound = allQBs.length > 0 ? Math.min(...allQBs.map((p) => p.round)) : Infinity;

  if (earlyTEs >= 1) return 'Anchor TE';
  if (earlyRBs >= 2) return 'Robust RB';
  if (earlyRBs === 1) return 'Hero RB';
  if (firstQBRound >= 8) return 'Late-Round QB';
  if (earlyRBs === 0) return 'Zero RB';
  return 'Balanced';
}

module.exports = { suggest };
