// Underdog draft-board paste parser.
// Accepted formats (tried in order for each line):
//   1.03 A.J. Brown WR PHI
//   1.03 A.J. Brown, WR, PHI
//   Pick 1.03 A.J. Brown WR PHI
//   Pick 1.03: A.J. Brown WR PHI
//   36 A.J. Brown WR PHI          (overall pick only, no round.slot)

const { clean } = require('../../../../lib/players');

const POSITIONS = 'QB|RB|WR|TE|K|DST|DEF|DL|LB|DB|S|CB|P';

const PAT_ROUND_SLOT = new RegExp(
  `^(\\d+)\\.(\\d+)\\s+(.+?)\\s+(${POSITIONS})\\s+([A-Z]{2,5})\\s*$`, 'i'
);
const PAT_ROUND_SLOT_COMMA = new RegExp(
  `^(\\d+)\\.(\\d+)\\s+(.+?),\\s*(${POSITIONS}),\\s*([A-Z]{2,5})\\s*$`, 'i'
);
const PAT_PICK_PREFIX = new RegExp(
  `^[Pp]ick\\s+(\\d+)\\.(\\d+)[:\\s]+(.+?)\\s+(${POSITIONS})\\s+([A-Z]{2,5})\\s*$`, 'i'
);
const PAT_OVERALL = new RegExp(
  `^(\\d+)\\s+(.+?)\\s+(${POSITIONS})\\s+([A-Z]{2,5})\\s*$`, 'i'
);

const SKIP_RE = /^\s*$|^[Rr]ound\s+\d+|^[-=*]{3,}|^#/;

// For snake drafts: slot is the original draft seat that picked at this
// position in the round.
function draftSlot(round, slotInRound, leagueSize) {
  return round % 2 === 1 ? slotInRound : leagueSize - slotInRound + 1;
}

function makePick(round, slotInRound, rawName, position, nflTeam, leagueSize, mySlot) {
  const overallPick = (round - 1) * leagueSize + slotInRound;
  const slot = draftSlot(round, slotInRound, leagueSize);
  return {
    overallPick,
    round,
    playerName: clean(rawName),
    position: position.toUpperCase(),
    nflTeam: nflTeam.toUpperCase(),
    draftSlot: slot,
    isMyPick: slot === mySlot,
  };
}

function parse(text, { leagueSize = 12, mySlot = 1 } = {}) {
  const picks = [];
  const unparseable = [];
  const lines = text.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();

    if (SKIP_RE.test(line)) continue;

    let m;

    if ((m = PAT_ROUND_SLOT.exec(line)) || (m = PAT_ROUND_SLOT_COMMA.exec(line))) {
      picks.push(makePick(+m[1], +m[2], m[3], m[4], m[5], leagueSize, mySlot));
      continue;
    }

    if ((m = PAT_PICK_PREFIX.exec(line))) {
      picks.push(makePick(+m[1], +m[2], m[3], m[4], m[5], leagueSize, mySlot));
      continue;
    }

    if ((m = PAT_OVERALL.exec(line))) {
      const overallPick = +m[1];
      const round = Math.ceil(overallPick / leagueSize);
      const slotInRound = overallPick - (round - 1) * leagueSize;
      picks.push(makePick(round, slotInRound, m[2], m[3], m[4], leagueSize, mySlot));
      continue;
    }

    unparseable.push({ lineNumber: i + 1, line });
  }

  picks.sort((a, b) => a.overallPick - b.overallPick);
  return { picks, unparseable };
}

module.exports = { parse };
