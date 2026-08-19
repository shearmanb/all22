// lib/parsers/rankings.js — turn raw rankings text (from OCR or a paste) into a
// structured, ordered list. Registry-friendly: this is the generic ranking-list
// parser; site-specific parsers can be added as sibling files later.
//
// Output:
//   { players: [{ rank, name, position, team, auction_value, notes }],
//     unparsed: [{ line, reason }],
//     position_blocks: ['QB', 'WR', …] }   // distinct block headers, in order
//
// Design rules (from the spec):
//   - The VISUAL ORDER of the list is the ranking. We assign rank = appearance
//     order (1..N), because OCR'd leading numbers are error-prone but the order
//     of rows is reliable. The preview is editable, so the owner can fix any row.
//   - Lines we cannot turn into a player are returned in `unparsed`, never dropped.
//   - All names go through lib/players.js — no name logic lives here.

const players = require('../../../lib/players');
const csvImport = require('./csv-import');

// Words that only appear in header/label rows, never in a player name.
const HEADER_WORDS = new Set([
  'rank', 'ranks', 'ranking', 'rankings', 'rk', 'no', 'player', 'players',
  'pos', 'position', 'positions', 'team', 'teams', 'tier', 'tiers', 'bye', 'adp',
  'overall', 'name', 'ecr', 'avg', 'best', 'worst', 'proj', 'pts',
  'cost', 'salary', 'price', 'value', 'values', 'pick', 'drafted', 'budget',
  'def', 'dst', 'defense', 'defenses',
]);

// Position-block headers. Positional sources are pasted as blocks — "QB" (or
// "Quarterbacks", "WRs", "D/ST", "RB Rankings"…) on its own line, then that
// position's list. The header names the position of every row beneath it
// until the next header.
const POSITION_HEADERS = {
  QB: 'QB', QBS: 'QB', QUARTERBACK: 'QB', QUARTERBACKS: 'QB',
  RB: 'RB', RBS: 'RB', RUNNINGBACK: 'RB', RUNNINGBACKS: 'RB',
  WR: 'WR', WRS: 'WR', WIDERECEIVER: 'WR', WIDERECEIVERS: 'WR',
  TE: 'TE', TES: 'TE', TIGHTEND: 'TE', TIGHTENDS: 'TE',
  K: 'K', KS: 'K', PK: 'K', KICKER: 'K', KICKERS: 'K',
  DST: 'DST', DEF: 'DST', DEFENSE: 'DST', DEFENSES: 'DST',
  TEAMDEFENSE: 'DST', TEAMDEFENSES: 'DST',
};

// The position a header line announces, or '' when the line isn't one.
function positionHeader(line) {
  const t = String(line || '').trim();
  if (!t) return '';
  const whole = POSITION_HEADERS[t.toUpperCase().replace(/[^A-Z]/g, '')];
  if (whole) return whole;
  // "QB Rankings" / "Tier 1 RBs" style: drop generic label words and retry.
  const words = t.split(/\s+/)
    .map((w) => w.replace(/[^A-Za-z]/g, ''))
    .filter(Boolean)
    .filter((w) => !HEADER_WORDS.has(w.toLowerCase()));
  return POSITION_HEADERS[words.join('').toUpperCase()] || '';
}

function looksLikeJunk(line) {
  const t = line.trim();
  if (!t) return true;
  if (/^\W+$/.test(t)) return true; // only punctuation/symbols
  // A line with no letters at all (e.g. a stray "12 14 9") is not a player.
  if (!/[a-z]/i.test(t)) return true;
  // A header row is a line made up ENTIRELY of header/label words (e.g.
  // "Rank Player Pos Team", "Player Avg Cost % Drafted"). Strip a leading
  // separator first; pure-symbol tokens like "%" or "$" don't disqualify it.
  const words = t.replace(/^[\W\d]+/, '').split(/\s+/).filter((w) => /[a-z]/i.test(w));
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

// Pull an auction value off a line: the first "$14" / "$52.7"-style token.
// Only a $-prefixed number counts — bare numbers are ranks/byes/ADP and stay
// ambiguous. Returns { line: <without the token>, value: number|null }.
function extractAuctionValue(line) {
  const m = /\$\s?(\d{1,4}(?:\.\d+)?)\b/.exec(line);
  if (!m) return { line, value: null };
  return {
    line: (line.slice(0, m.index) + ' ' + line.slice(m.index + m[0].length)).replace(/\s+/g, ' ').trim(),
    value: Number(m[1]),
  };
}

function parseLine(rawLine) {
  let line = rawLine.replace(/\s+/g, ' ').trim();
  if (!line || looksLikeJunk(line)) return null;
  const money = extractAuctionValue(line);
  line = money.line;
  if (!line) return null;
  const withValue = (parsed) => (parsed ? Object.assign({ auction_value: money.value }, parsed) : parsed);

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
    if (dst) return withValue({ name: players.teamDefenseName(dst), position: 'DST', team: dst });
    const name = players.display(rawName);
    const team = findTeamInSegments(segments.slice(1));
    if (name && /[a-z]/i.test(name) && players.key(name).length >= 2) {
      // Position isn't printed on these rows; parse() fills it from the
      // enclosing position-block header when the paste has one.
      return withValue({ name, position: '', team });
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
  if (dst) return withValue({ name: players.teamDefenseName(dst), position: 'DST', team: dst });

  const tokens = line.split(/\s+/).filter(Boolean);
  const position = players.findPosition(tokens);
  const team = players.findTeam(tokens);
  const name = players.display(line);
  if (!name || !/[a-z]/i.test(name) || players.key(name).length < 2) {
    return null;
  }
  return withValue({ name, position, team });
}

// A paste copied straight out of a spreadsheet (Excel, Google Sheets, a web
// table) arrives TAB-delimited: "1\tJahmyr Gibbs\tRB\tDET\t6\t$60". Those
// columns are far more reliable than guessing inside one run-on line, so a
// tabular paste is handed to the CSV importer, which detects the columns from
// the header (or, headerless, from what the cells look like) and drops
// everything it isn't asked for — rank, bye, projections, notes.
function looksTabular(text) {
  const lines = String(text || '').split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return false;
  const tabbed = lines.filter((l) => l.includes('\t')).length;
  return tabbed >= 2 && tabbed / lines.length >= 0.6;
}

// Turn CSV-importer rows into parse()'s output shape (rank = list order).
function fromTable(rawText) {
  const { rows } = csvImport.importCsv(rawText);
  const out = [];
  const unparsed = [];
  const seen = new Set();
  for (const r of rows) {
    const rawName = String(r.name || '').trim();
    // A position-block header line ("RB", "Wide Receivers") in a tabular paste
    // is not a player — but it does tag the rows beneath it, same as always.
    if (positionHeader(rawName)) continue;
    const dst = players.teamDefenseFromLine(rawName);
    const name = dst ? players.teamDefenseName(dst) : players.display(rawName);
    if (!name || !/[a-z]/i.test(name) || players.key(name).length < 2) {
      unparsed.push({ line: rawName, reason: 'could not detect a player name' });
      continue;
    }
    const team = dst || players.teamFromToken(r.team || '') || String(r.team || '').trim().toUpperCase();
    const k = players.key(name) + (team ? '|' + team : '');
    if (seen.has(k)) {
      unparsed.push({ line: rawName, reason: `duplicate of "${name}"` });
      continue;
    }
    seen.add(k);
    out.push({
      rank: out.length + 1,
      name,
      position: dst ? 'DST' : players.findPosition([String(r.position || '')]),
      team,
      auction_value: (r.auction_value === undefined || r.auction_value === null) ? null : r.auction_value,
      notes: r.notes ? String(r.notes).trim() : null,
    });
  }
  return { players: out, unparsed, position_blocks: [] };
}

function parse(rawText) {
  if (looksTabular(rawText)) return fromTable(rawText);

  const lines = String(rawText || '').split(/\r?\n/);
  const players_out = [];
  const unparsed = [];
  const seen = new Set();
  // Set by a position-block header; stamped on rows that don't name their own
  // position (per-position lists rarely repeat it on every row).
  let currentPosition = '';
  const blockPositions = [];

  for (const rawLine of lines) {
    if (!rawLine.trim()) continue; // ignore blank lines silently
    const posHeader = positionHeader(rawLine);
    if (posHeader) {
      currentPosition = posHeader;
      if (!blockPositions.includes(posHeader)) blockPositions.push(posHeader);
      continue;
    }
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
      position: parsed.position || currentPosition,
      team: parsed.team,
      // Auction value when the line carried a "$14"-style token (Yahoo /
      // FantasyPros auction-value tables pasted as text), else null.
      auction_value: parsed.auction_value === undefined ? null : parsed.auction_value,
      // Free-text note for this player. Line-based pastes have nowhere to put
      // one; tabular pastes (fromTable) carry a notes column through.
      notes: null,
    });
  }

  return { players: players_out, unparsed, position_blocks: blockPositions };
}

module.exports = { parse, parseLine, looksTabular };
