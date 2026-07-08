// FantasyPros second-screen BOARD copy — what you get selecting the whole
// draft board on /d/secondscreen.jsp and copying. Shape per player cell:
//
//   Jahmyr            <- first name (one line)
//   Gibbs             <- last name (one line)
//   RB-DET1.01Headshot of Jahmyr Gibbs   <- POS-TEAM + round.pickInRound + alt junk
//
// DST cells are the same minus the Headshot suffix ("Denver / Broncos /
// DST-DEN12.11"). Every cell carries its own round.pick, so paste order does
// not matter (the visual board lists even rounds right-to-left). Above the
// first cell sit the 12 team names in column order, interleaved with
// single-letter avatar lines — "Your Team"'s position IS the owner's slot.
const { clean } = require('../../../../lib/players');

const CELL_RE = /^(QB|RB|WR|TE|K|PK|DST|DEF)-([A-Z]{2,4})(\d{1,2})\.(\d{2})/;

// Does a paste look like this format? Used by the fantasypros dispatcher.
function detect(text) {
  return /^(QB|RB|WR|TE|K|PK|DST|DEF)-[A-Z]{2,4}\d{1,2}\.\d{2}/m.test(text);
}

function parse(rawText, opts = {}) {
  const lines = String(rawText || '').replace(/\r\n?/g, '\n').split('\n').map((l) => l.trim());
  const picks = [];
  const unparseable = [];
  let teamNames = [];
  let sawFirstCell = false;
  let pre = []; // header lines before the first cell
  let nameBuf = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    if (/^Headshot of /i.test(line)) continue;

    const m = CELL_RE.exec(line);
    if (m) {
      if (!sawFirstCell) {
        // The last two header lines are the FIRST player's name, not teams.
        sawFirstCell = true;
        nameBuf = pre.slice(-2);
        teamNames = pre.slice(0, -2).filter((l) => l.length > 1); // drop avatar letters
      }
      const position = m[1] === 'DEF' ? 'DST' : m[1] === 'PK' ? 'K' : m[1];
      const nflTeam = m[2];
      const round = parseInt(m[3], 10);
      const pickInRound = parseInt(m[4], 10);
      const nameParts = nameBuf.slice(-2); // first + last name lines
      nameBuf = [];
      if (!nameParts.length) {
        unparseable.push({ lineNumber: i + 1, line });
        continue;
      }
      const joined = nameParts.join(' ');
      picks.push({
        playerName: position === 'DST' ? clean(joined) + ' DST' : clean(joined),
        position,
        nflTeam,
        round,
        pickInRound,
      });
      continue;
    }

    if (!sawFirstCell) {
      // Header region: team names in column order (with single-letter avatar
      // lines between) — split from the first player's name once a cell shows.
      pre.push(line);
    } else if (nameBuf.length >= 2) {
      // A third non-cell line means the oldest buffered line was junk.
      unparseable.push({ lineNumber: i + 1, line: nameBuf.shift() });
      nameBuf.push(line);
    } else {
      nameBuf.push(line);
    }
  }
  nameBuf.forEach((l) => unparseable.push({ lineNumber: 0, line: l }));

  const leagueSize = (opts.leagueSize && parseInt(opts.leagueSize, 10)) ||
    (teamNames.length >= 4 && teamNames.length <= 24 ? teamNames.length : null) ||
    Math.max(12, ...picks.map((p) => p.pickInRound));
  const yourIdx = teamNames.findIndex((n) => /^your team$/i.test(n));
  const inferredMySlot = yourIdx >= 0 ? yourIdx + 1 : null;
  const mySlot = inferredMySlot || parseInt(opts.mySlot, 10) || null;

  const out = picks.map((p) => {
    const overall = (p.round - 1) * leagueSize + p.pickInRound;
    // Snake: even rounds run backwards, so the column (seat) flips.
    const draftSlot = p.round % 2 === 1 ? p.pickInRound : leagueSize - p.pickInRound + 1;
    return {
      overallPick: overall,
      round: p.round,
      playerName: p.playerName,
      position: p.position,
      nflTeam: p.nflTeam,
      draftSlot,
      isMyPick: mySlot !== null && draftSlot === mySlot,
    };
  });
  out.sort((a, b) => a.overallPick - b.overallPick);

  return { picks: out, unparseable, inferredMySlot, inferredLeagueSize: teamNames.length >= 4 && teamNames.length <= 24 ? teamNames.length : null };
}

module.exports = { parse, detect };
