// lib/parsers/rankings.js — turn raw rankings text (from OCR or a paste) into a
// structured, ordered list. Registry-friendly: this is the generic ranking-list
// parser; site-specific parsers can be added as sibling files later.
//
// Output:
//   { players: [{ rank, name, position, team }], unparsed: [{ line, reason }] }
//
// Design rules (from the spec):
//   - The VISUAL ORDER of the list is the ranking. We assign rank = appearance
//     order (1..N), because OCR'd leading numbers are error-prone but the order
//     of rows is reliable. The preview is editable, so the owner can fix any row.
//   - Lines we cannot turn into a player are returned in `unparsed`, never dropped.
//   - All names go through lib/players.js — no name logic lives here.

const players = require('../../../lib/players');

// Words that only appear in header/label rows, never in a player name.
const HEADER_WORDS = new Set([
  'rank', 'ranks', 'ranking', 'rankings', 'rk', 'no', 'player', 'players',
  'pos', 'position', 'positions', 'team', 'teams', 'tier', 'tiers', 'bye', 'adp',
  'overall', 'name', 'ecr', 'avg', 'best', 'worst', 'proj', 'pts',
  'def', 'dst', 'defense', 'defenses',
]);

function looksLikeJunk(line) {
  const t = line.trim();
  if (!t) return true;
  if (/^\W+$/.test(t)) return true; // only punctuation/symbols
  // A line with no letters at all (e.g. a stray "12 14 9") is not a player.
  if (!/[a-z]/i.test(t)) return true;
  // A header row is a line made up ENTIRELY of header/label words (e.g.
  // "Rank Player Pos Team"). Strip a leading separator first.
  const words = t.replace(/^[\W\d]+/, '').split(/\s+/).filter(Boolean);
  if (words.length && words.every((w) => HEADER_WORDS.has(w.toLowerCase().replace(/[.):,]/g, '')))) {
    return true;
  }
  return false;
}

// Strip a leading rank + movement-arrow prefix from the start of a name segment.
// Real rows start with the rank and an ADP-movement badge that OCR renders many
// ways: "1", "2.13", "5v2", "10~8", "1a1", "17+ 11", "20~14". Every one of those
// leading chunks CONTAINS a digit, and no real name word does, so we drop
// leading whitespace-separated tokens that contain a digit until the name begins.
function stripRankPrefix(segment) {
  const tokens = segment.trim().split(/\s+/).filter(Boolean);
  // Drop leading rank/movement-badge tokens: anything containing a digit
  // ("17", "2v1", "10~8") or made of pure symbols (a misread arrow like "+").
  // Stop at the first token that has a letter — the start of the name.
  while (tokens.length > 1 && (/\d/.test(tokens[0]) || !/[a-z0-9]/i.test(tokens[0]))) {
    tokens.shift();
  }
  return tokens.join(' ');
}

// Find an NFL team among comma segments (everything after the name). Cleans OCR
// noise to letters and validates against the canonical team list.
function findTeamInSegments(segments) {
  for (const seg of segments) {
    // A team segment is usually a short token (e.g. "LAR"); try the first token
    // of each segment so a "11 [icon" bye segment doesn't swallow the search.
    for (const token of seg.split(/\s+/)) {
      const team = players.teamFromToken(token);
      if (team) return team;
    }
  }
  return '';
}

function parseLine(rawLine) {
  let line = rawLine.replace(/\s+/g, ' ').trim();
  if (!line || looksLikeJunk(line)) return null;

  // --- Comma-delimited format (FantasyPros & similar): ----------------------
  //   "<rank><move> Name, TEAM, BYE [icon] | Move"
  // The name is the first comma segment (minus the rank/movement prefix); the
  // team is a later segment; trailing bye/icon/"Move" junk lives past the last
  // comma we care about and is ignored.
  if (line.includes(',')) {
    const segments = line.split(',').map((s) => s.trim());
    const rawName = stripRankPrefix(segments[0]);
    // A row that's just a team (no player) is a defense — e.g.
    // "1 Philadelphia Eagles, PHI, BYE" or "Cowboys DST".
    const dst = players.teamDefenseFromLine(rawName);
    if (dst) return { name: players.teamDefenseName(dst), position: 'DST', team: dst };
    const name = players.display(rawName);
    const team = findTeamInSegments(segments.slice(1));
    if (name && /[a-z]/i.test(name) && players.key(name).length >= 2) {
      // Position isn't present in these per-position lists; left blank here and
      // set in bulk from the UI (the screenshot is all one position).
      return { name, position: '', team };
    }
    return null;
  }

  // --- Space-delimited format: "Rank Name POS TEAM" -------------------------
  // Drop a rank glued to the name by a separator, e.g. "12.Patrick" -> "Patrick"
  // or "3)Bijan" -> "Bijan". The "[.)]" requirement keeps "49ers" intact (no
  // separator after the digits there).
  line = line.replace(/^(\d{1,3})[.)](?=[A-Za-z])/, '');
  // Split a rank glued to a name, e.g. "1Christian" -> "1 Christian". Require an
  // UPPERCASE next letter so team names like "49ers" are left intact.
  line = line.replace(/^(\d{1,3})(?=[A-Z])/, '$1 ');
  // Drop a leading rank token: digits + optional "." / ")" + REQUIRED space.
  line = line.replace(/^\s*\d{1,3}[.)]?\s+/, '');
  if (!line) return null;

  // A row that's just a team name (no player) is a defense, e.g. "49ers",
  // "Dallas Cowboys", "PHI DST".
  const dst = players.teamDefenseFromLine(line);
  if (dst) return { name: players.teamDefenseName(dst), position: 'DST', team: dst };

  const tokens = line.split(/\s+/).filter(Boolean);
  const position = players.findPosition(tokens);
  const team = players.findTeam(tokens);
  const name = players.display(line);
  if (!name || !/[a-z]/i.test(name) || players.key(name).length < 2) {
    return null;
  }
  return { name, position, team };
}

function parse(rawText) {
  const lines = String(rawText || '').split(/\r?\n/);
  const players_out = [];
  const unparsed = [];
  const seen = new Set();

  for (const rawLine of lines) {
    if (!rawLine.trim()) continue; // ignore blank lines silently
    if (looksLikeJunk(rawLine)) {
      // Only report junk that actually had content worth noting.
      if (/[a-z0-9]/i.test(rawLine)) {
        unparsed.push({ line: rawLine.trim(), reason: 'looks like a header or non-player line' });
      }
      continue;
    }

    const parsed = parseLine(rawLine);
    if (!parsed) {
      unparsed.push({ line: rawLine.trim(), reason: 'could not detect a player name' });
      continue;
    }

    // Dedupe on name + team, not name alone: two genuinely different players can
    // normalize to the same name key (there have been two "Michael Carter"s), and
    // they're distinguished by team. Same name with the same team (or both blank,
    // e.g. overlapping screenshots of one list) is a real duplicate; same name on
    // a different team is kept. Team is included only when known on both rows.
    const k = players.key(parsed.name) + (parsed.team ? '|' + parsed.team : '');
    if (seen.has(k)) {
      unparsed.push({ line: rawLine.trim(), reason: `duplicate of "${parsed.name}"` });
      continue;
    }
    seen.add(k);

    players_out.push({
      // Rank is the order players are listed — the first row is rank 1, etc.
      // The OCR'd rank column is unreliable (movement arrows/badges next to it
      // get misread as digits), and rankings are always listed in rank order.
      rank: players_out.length + 1,
      name: parsed.name,
      position: parsed.position,
      team: parsed.team,
    });
  }

  return { players: players_out, unparsed };
}

module.exports = { parse, parseLine };
