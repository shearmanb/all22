// Canonical player-name normalization.
// Every parser, rankings ingester, and converter MUST use this module.
// Never duplicate name-matching logic elsewhere.
//
// Two groups of helpers live here:
//   - clean(raw) / normalize(raw): used by the draft-board parsers.
//   - display(raw) / key(raw) + position/team detection: used by the rankings
//     converter. key() and normalize() are intentionally compatible matching
//     forms; display() is the human-readable form for showing/exporting.

const SUFFIX_RE = /\s+(Jr\.?|Sr\.?|II|III|IV|V)\s*$/i;

function clean(rawName) {
  if (!rawName || typeof rawName !== 'string') return '';
  return rawName
    .trim()
    .replace(SUFFIX_RE, '')   // "Ja'Marr Chase Jr." → "Ja'Marr Chase"
    .replace(/\./g, '')       // "A.J. Brown" → "AJ Brown"
    .replace(/\s+/g, ' ')
    .trim();
}

// Returns a lowercase key suitable for matching across naming variations.
function normalize(rawName) {
  return clean(rawName).toLowerCase();
}

// ---------------------------------------------------------------------------
// Rankings-converter helpers (positions, teams, OCR-tolerant display/key).
// ---------------------------------------------------------------------------

const POSITIONS = new Set(['QB', 'RB', 'WR', 'TE', 'K', 'PK', 'DST', 'DEF', 'D/ST', 'DT', 'DE', 'LB', 'CB', 'S', 'FLEX']);

// NFL team abbreviations (current + common alternates) used to strip trailing
// team tags like "A.J. Brown PHI".
const NFL_TEAMS = new Set([
  'ARI', 'ATL', 'BAL', 'BUF', 'CAR', 'CHI', 'CIN', 'CLE', 'DAL', 'DEN',
  'DET', 'GB', 'GNB', 'HOU', 'IND', 'JAX', 'JAC', 'KC', 'KAN', 'LAC',
  'LAR', 'LA', 'LV', 'LVR', 'OAK', 'MIA', 'MIN', 'NE', 'NWE', 'NO', 'NOR',
  'NYG', 'NYJ', 'PHI', 'PIT', 'SF', 'SFO', 'SEA', 'TB', 'TAM', 'TEN',
  'WAS', 'WSH', 'STL', 'SD',
]);

const SUFFIXES = new Set(['jr', 'sr', 'ii', 'iii', 'iv', 'v']);

// Common OCR misreads of team abbreviations (keyed on the alphanumeric,
// uppercased token). Kept tiny and unambiguous — only swaps we're confident in.
// "T8" is Tampa Bay's "TB" with the B misread as 8.
const TEAM_OCR_FIXES = { T8: 'TB', T6: 'TB' };

function isPosition(token) {
  if (!token) return false;
  return POSITIONS.has(token.toUpperCase().replace(/\./g, ''));
}

function isTeam(token) {
  if (!token) return false;
  return NFL_TEAMS.has(token.toUpperCase().replace(/\./g, ''));
}

// Remove trailing position/team tokens that often ride along with a name, e.g.
// "Bijan Robinson RB ATL" -> "Bijan Robinson". Only strips from the END so a
// real name word is never removed.
function stripTrailingTags(name) {
  let parts = name.split(/\s+/).filter(Boolean);
  while (parts.length > 1) {
    const last = parts[parts.length - 1];
    if (isPosition(last) || isTeam(last)) {
      parts.pop();
    } else {
      break;
    }
  }
  return parts.join(' ');
}

// A clean, display-ready name: trimmed, single-spaced, trailing POS/TEAM tags
// removed. Casing from the source is largely preserved (names come in mixed),
// but we title-case obviously all-caps input so OCR shouting reads normally.
function display(raw) {
  if (!raw) return '';
  let s = String(raw).replace(/\s+/g, ' ').trim();
  // Drop a leading rank like "12." or "12)" if it slipped through. Require a
  // trailing space so team names that start with digits (e.g. "49ers") survive.
  s = s.replace(/^\s*\d{1,3}[.)]?\s+/, '');
  s = stripTrailingTags(s);
  // OCR routinely confuses capital "I" with lowercase "l": fix a trailing roman
  // numeral suffix like "Ill"/"lll" -> "III" so suffix handling/matching works.
  s = s.replace(/ (Ill|lll)$/, ' III');
  s = s.trim();
  if (s && s === s.toUpperCase()) {
    s = s
      .toLowerCase()
      .replace(/\b([a-z])/g, (m, c) => c.toUpperCase());
  }
  return s;
}

// A normalized matching key. Lowercase, punctuation removed, suffixes dropped,
// trailing POS/TEAM tags removed, whitespace collapsed. This is what we match
// and dedupe on — never show it to the user.
function key(raw) {
  if (!raw) return '';
  let s = display(raw).toLowerCase();
  // Remove punctuation that varies between sources: periods, apostrophes,
  // commas, hyphens (treat hyphen as space so "Amon-Ra" == "Amon Ra").
  s = s.replace(/[.'`,]/g, '').replace(/-/g, ' ');
  let parts = s.split(/\s+/).filter(Boolean);
  // Drop name suffixes (jr/sr/ii/...) so "Odell Beckham Jr" == "Odell Beckham".
  parts = parts.filter((p) => !SUFFIXES.has(p));
  return parts.join(' ');
}

// Detect a position token anywhere in a token list (used by the parser).
function findPosition(tokens) {
  for (const t of tokens) {
    if (isPosition(t)) return t.toUpperCase().replace(/\./g, '').replace('DEF', 'DST').replace('D/ST', 'DST');
  }
  return '';
}

// Detect a team token anywhere in a token list (used by the parser).
function findTeam(tokens) {
  for (const t of tokens) {
    if (isTeam(t)) return t.toUpperCase().replace(/\./g, '');
  }
  return '';
}

// Resolve a single (possibly OCR-noisy) token to a canonical team abbreviation,
// or '' if it isn't a recognizable team. Keeps alphanumerics so OCR fixes like
// "T8" -> "TB" can apply, then falls back to letters-only validation.
function teamFromToken(token) {
  if (!token) return '';
  const alnum = String(token).replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  if (TEAM_OCR_FIXES[alnum]) return TEAM_OCR_FIXES[alnum];
  const letters = alnum.replace(/[0-9]/g, '');
  if (letters && NFL_TEAMS.has(letters)) return letters;
  return '';
}

module.exports = {
  normalize,
  clean,
  display,
  key,
  isPosition,
  isTeam,
  findPosition,
  findTeam,
  teamFromToken,
  POSITIONS,
  NFL_TEAMS,
};
