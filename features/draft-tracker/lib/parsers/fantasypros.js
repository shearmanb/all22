// FantasyPros DraftWizard paste parser — handles two formats:
//
// FULL BOARD (detected by "Rd N" headers):
//   12 team names → Rd 1 → 12 players per round → Rd 2 → …
//   Each player is exactly 3 lines: FirstName / LastName / TEAM - POS
//   Teams are listed in draft-slot column order (slot 1 first) every round.
//   "Redo" appears in the user's column after their pick; used to infer mySlot.
//   Snake-draft overall picks: odd rounds (R-1)*L+slot, even rounds (R-1)*L+(L-slot+1).
//
// TEAM VIEW (detected by "Starters"/"Bench" headers):
//   Shows only the user's own picks.
//   POS / PlayerName / TEAM / (Bye N) / R.SS / ⋮

const { clean } = require('../../../../lib/players');

const POS_ALT = 'QB|RB|WR|TE|K|DST|DEF|FLX|DL|LB|DB|S|CB|P';
// "LAC - RB"  or  "- WR"  (team abbrev may be absent)
const TEAM_POS_RE = new RegExp(`^([A-Z]{2,5}|)\\s*-\\s*(${POS_ALT})\\s*$`, 'i');
const ROUND_HDR_RE = /^Rd (\d+)$/m;

// ─── Full Board ────────────────────────────────────────────────────────────────

function parseFullBoard(text, { leagueSize = 12, mySlot = null } = {}) {
  // Strip blank lines; keep "Redo" markers intact
  const lines = text.split('\n').map(l => l.trim()).filter(l => l !== '');

  const picks = [];
  const unparseable = [];
  let round = 0;
  let posInRound = 0;
  let inferredMySlot = null;
  const buf = [];

  const flush = () => {
    if (buf.length < 2) {
      buf.forEach(l => unparseable.push({ lineNumber: 0, line: l }));
      buf.length = 0;
      return;
    }
    // Last line must be the TEAM - POS line
    const m = TEAM_POS_RE.exec(buf[buf.length - 1]);
    if (!m) {
      buf.forEach(l => unparseable.push({ lineNumber: 0, line: l }));
      buf.length = 0;
      return;
    }
    const nameParts = buf.slice(0, -1);
    buf.length = 0;

    const nflTeam = m[1].toUpperCase();
    const position = m[2].toUpperCase();

    posInRound++;
    const slot = posInRound; // display column = original draft seat
    // Snake draft: even rounds reverse pick order
    const overall = round % 2 === 1
      ? (round - 1) * leagueSize + slot
      : (round - 1) * leagueSize + (leagueSize - slot + 1);

    const playerName = position === 'DST'
      ? nameParts.join(' ') + ' DST'
      : clean(nameParts.join(' '));

    picks.push({
      overallPick: overall,
      round,
      playerName,
      position,
      nflTeam,
      draftSlot: slot,
      isMyPick: false, // resolved after mySlot is known
    });
  };

  // Skip team names before the first "Rd N" header
  let i = 0;
  while (i < lines.length && !ROUND_HDR_RE.test(lines[i])) i++;

  for (; i < lines.length; i++) {
    const line = lines[i];

    const rdm = ROUND_HDR_RE.exec(line);
    if (rdm) {
      flush();
      round = parseInt(rdm[1], 10);
      posInRound = 0;
      continue;
    }

    if (line === 'Redo') {
      flush(); // buf is normally already empty here
      // posInRound was just incremented by the flush of the user's pick
      if (inferredMySlot === null && round === 1) {
        inferredMySlot = posInRound;
      }
      continue;
    }

    if (round === 0) continue; // still in the pre-round header section

    buf.push(line);
    // Flush as soon as the last line is a TEAM-POS line and we have ≥2 lines
    if (buf.length >= 2 && TEAM_POS_RE.test(line)) {
      flush();
    }
  }
  flush();

  const effectiveMySlot = mySlot || inferredMySlot;
  for (const p of picks) {
    p.isMyPick = p.draftSlot === effectiveMySlot;
  }

  picks.sort((a, b) => a.overallPick - b.overallPick);
  return { picks, unparseable, inferredMySlot };
}

// ─── Team View ─────────────────────────────────────────────────────────────────

const TV_POSITIONS = new Set(['QB', 'RB', 'WR', 'TE', 'FLX', 'DST', 'K', 'DEF']);
const TV_SECTIONS = new Set(['Starters', 'Bench', 'Reserves']);
const TV_TEAM_RE = /^[A-Z]{2,5}$/;
const BYE_RE = /^\(Bye \d+\)$/i;
const PICK_NOTATION_RE = /^(\d+)\.(\d+)$/;
const HEADER_RE = /^Round \d|^Pick \d|^\d+ Teams|^Mock Draft/i;

function parseTeamView(text, { leagueSize = 12 } = {}) {
  const lines = text.split('\n').map(l => l.trim()).filter(l => l !== '⋮' && l !== '');
  const picks = [];
  const unparseable = [];
  let inferredMySlot = null;

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (TV_SECTIONS.has(line) || HEADER_RE.test(line)) { i++; continue; }
    if (!TV_POSITIONS.has(line)) { unparseable.push({ lineNumber: i + 1, line }); i++; continue; }

    const position = line;
    i++;
    let playerName = null, nflTeam = null, round = null, slotInRound = null;

    while (i < lines.length) {
      const l = lines[i];
      const pm = PICK_NOTATION_RE.exec(l);
      if (pm) { round = +pm[1]; slotInRound = +pm[2]; i++; break; }
      if (BYE_RE.test(l)) { i++; continue; }
      if (TV_TEAM_RE.test(l)) { if (playerName !== null && nflTeam === null) nflTeam = l; i++; continue; }
      if (playerName === null) { playerName = l; i++; continue; }
      unparseable.push({ lineNumber: i + 1, line: l });
      i++;
    }
    if (round === null || playerName === null) continue;

    const draftSlot = round % 2 === 1 ? slotInRound : leagueSize - slotInRound + 1;
    if (round === 1 && inferredMySlot === null) inferredMySlot = draftSlot;

    picks.push({
      overallPick: (round - 1) * leagueSize + slotInRound,
      round,
      playerName: position === 'DST' ? `${clean(playerName)} DST` : clean(playerName),
      position: position === 'FLX' ? '' : position,
      nflTeam: nflTeam || '',
      draftSlot,
      isMyPick: true, // team view only shows the user's picks
    });
  }

  picks.sort((a, b) => a.overallPick - b.overallPick);
  return { picks, unparseable, inferredMySlot };
}

// ─── Auto-detect & export ──────────────────────────────────────────────────────

function parse(rawText, opts = {}) {
  const text = rawText.replace(/\r\n?/g, '\n');
  if (ROUND_HDR_RE.test(text)) return parseFullBoard(text, opts);
  return parseTeamView(text, opts);
}

module.exports = { parse };
