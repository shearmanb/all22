// FantasyPros DraftWizard "second screen" paste parser.
//
// Paste format (one player per block):
//   QB              ← position line
//   Justin Herbert  ← player name
//   LAC             ← NFL team abbrev
//   (Bye 7)         ← bye week (ignored)
//   7.03            ← pick notation round.slotInRound
//   ⋮               ← drag handle (skip)
//
// DST blocks have an extra "name" line before the abbrev:
//   DST
//   Eagles          ← display name
//   PHI             ← abbrev
//   (Bye 10)
//   15.03
//
// This format only shows the user's own picks, so isMyPick = true for all.
// mySlot is inferred from the round-1 pick (slot-in-round of the first round-1 pick).

const { clean } = require('../players');

const POSITIONS = new Set(['QB', 'RB', 'WR', 'TE', 'FLX', 'DST', 'K', 'DEF']);
const SECTION_HEADERS = new Set(['Starters', 'Bench', 'Reserves']);
const TEAM_RE = /^[A-Z]{2,5}$/;
const BYE_RE = /^\(Bye \d+\)$/i;
const PICK_RE = /^(\d+)\.(\d+)$/;
// Some headers FantasyPros may prepend, e.g. "Round 1, Pick 3"
const HEADER_RE = /^Round \d|^Pick \d|^\d+ Teams|^Mock Draft/i;

function draftSlot(round, slotInRound, leagueSize) {
  return round % 2 === 1 ? slotInRound : leagueSize - slotInRound + 1;
}

function parse(text, { leagueSize = 12 } = {}) {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '⋮' && l !== ''); // strip ⋮ and blank lines

  const picks = [];
  const unparseable = [];

  // Infer mySlot from the first round-1 pick (slot-in-round of R1 = seat)
  let inferredSlot = null;

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    if (SECTION_HEADERS.has(line) || HEADER_RE.test(line)) { i++; continue; }

    if (!POSITIONS.has(line)) {
      unparseable.push({ lineNumber: i + 1, line });
      i++;
      continue;
    }

    const position = line;
    i++;

    // Collect the next lines until we find the R.SS pick notation.
    // We'll buffer: name, [dst-abbrev or team], [bye], pick
    let playerName = null;
    let nflTeam = null;
    let round = null;
    let slotInRound = null;

    while (i < lines.length) {
      const l = lines[i];

      if (PICK_RE.test(l)) {
        const m = PICK_RE.exec(l);
        round = parseInt(m[1], 10);
        slotInRound = parseInt(m[2], 10);
        i++;
        break;
      }

      if (BYE_RE.test(l)) { i++; continue; }

      if (TEAM_RE.test(l)) {
        // If we already have a playerName and no team yet, this is the team abbrev.
        // If playerName is null, this could be a bare team (unlikely — skip).
        if (playerName !== null && nflTeam === null) {
          nflTeam = l;
        }
        i++;
        continue;
      }

      // Anything else is the player name (first text after the position line).
      if (playerName === null) {
        playerName = l;
      } else {
        // Unexpected extra text — treat as unparseable detail, keep going.
        unparseable.push({ lineNumber: i + 1, line: l });
      }
      i++;
    }

    if (round === null || playerName === null) {
      // Block was incomplete — already consumed, keep going.
      continue;
    }

    // DST: store as "Eagles DST"; use the abbrev (nflTeam) as team.
    const displayName = position === 'DST'
      ? `${clean(playerName)} DST`
      : clean(playerName);

    const overallPick = (round - 1) * leagueSize + slotInRound;
    const slot = draftSlot(round, slotInRound, leagueSize);

    if (round === 1 && inferredSlot === null) inferredSlot = slot;

    picks.push({
      overallPick,
      round,
      playerName: displayName,
      // FLX is a lineup slot, not an actual position — leave blank so later
      // phases can fill it in from player data.
      position: position === 'FLX' ? '' : position,
      nflTeam: nflTeam || '',
      draftSlot: slot,
      isMyPick: true, // DraftWizard only shows the user's own picks
    });
  }

  picks.sort((a, b) => a.overallPick - b.overallPick);
  return { picks, unparseable, inferredMySlot: inferredSlot };
}

module.exports = { parse };
