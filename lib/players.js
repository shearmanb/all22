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

// ---------------------------------------------------------------------------
// Fuzzy name matching against a known list (e.g. an NFL roster). OCR garbles
// names in small ways — a wrong first letter (J->]), a missing space
// (TylerAllgeier), leading badge junk ("+ 1 ..."). The last name is usually
// intact, so matching anchors on it and tolerates noise elsewhere.
// ---------------------------------------------------------------------------

// key() with spaces removed — tolerant of missing/extra spaces between parts.
function compactKey(raw) {
  return key(raw).replace(/\s+/g, '');
}

// Levenshtein edit distance (iterative, single row). Small strings only.
function editDistance(a, b) {
  a = a || ''; b = b || '';
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  const dp = new Array(n + 1);
  for (let j = 0; j <= n; j++) dp[j] = j;
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[n];
}

function pushMap(map, k, v) {
  const arr = map.get(k);
  if (arr) arr.push(v); else map.set(k, [v]);
}

// Build a reusable index from items that each have a `name` (plus any metadata).
// Used to match noisy OCR names back to canonical ones.
//   opts.aliases  optional Map( variant-key -> canonical name ) consulted by
//                 findName before fuzzy matching. Held by reference, so aliases
//                 merged into that Map later are picked up without rebuilding.
function buildNameIndex(items, opts) {
  const byKey = new Map();      // exact key -> entry
  const byCompact = new Map();  // spaceless key -> [entries]
  const byLast = new Map();     // last-name token -> [entries]
  for (const it of items || []) {
    const k = key(it.name);
    if (!k) continue;
    const entry = Object.assign({}, it, { _key: k });
    if (!byKey.has(k)) byKey.set(k, entry);
    pushMap(byCompact, k.replace(/\s+/g, ''), entry);
    const parts = k.split(' ');
    pushMap(byLast, parts[parts.length - 1], entry);
  }
  return { byKey, byCompact, byLast, aliases: (opts && opts.aliases) || null };
}

// Find the canonical entry that best matches a (possibly OCR-garbled) name AND
// report how confident the match is. Strategy, most-confident first:
//   0. alias            a curated/learned variant -> canonical name (then re-match)
//   1. exact key          2. exact spaceless key (unique)
//   3. last name match (unique, or disambiguated by first name)
//   4. bounded edit-distance on the spaceless key (unique closest)
// Returns { entry, confidence, via } where:
//   entry       the matched index entry, or null if nothing is confident enough
//   confidence  'high' | 'medium' | 'low' | 'none'
//   via         which strategy matched ('exact','compact','lastname',
//               'lastname-fuzzy','lastname-first','editdistance','alias','none')
// 'medium'/'low' are the matches worth asking the owner to confirm.
function matchName(raw, index) {
  if (!index) return { entry: null, confidence: 'none', via: 'none' };
  let k = key(raw);
  if (!k) return { entry: null, confidence: 'none', via: 'none' };

  // Alias layer: a curated/learned variant -> canonical name. The only thing that
  // resolves a genuinely different first name on a common last name. We swap to
  // the canonical key and then match it normally — so an alias is no less safe
  // than typing that canonical yourself: a clean miss just yields no match, though
  // a canonical mistyped *close to another real player* could still fuzzy-resolve
  // wrong, so keep canonicals spelled exactly.
  let viaAlias = false;
  if (index.aliases && index.aliases.has(k)) {
    const canon = key(index.aliases.get(k));
    if (canon) { k = canon; viaAlias = true; }
  }

  if (index.byKey.has(k)) {
    return { entry: index.byKey.get(k), confidence: 'high', via: viaAlias ? 'alias' : 'exact' };
  }

  const compact = k.replace(/\s+/g, '');
  const cExact = index.byCompact.get(compact);
  if (cExact && cExact.length === 1) {
    return { entry: cExact[0], confidence: 'high', via: viaAlias ? 'alias' : 'compact' };
  }

  const parts = k.split(' ');
  const last = parts[parts.length - 1];
  const firstTok = parts[0] || '';
  let cands = (index.byLast.get(last) || []).slice();
  let lastFuzzy = false;
  if (!cands.length) {
    // Last name itself slightly garbled — allow distance 1.
    for (const [ln, arr] of index.byLast) {
      if (Math.abs(ln.length - last.length) <= 1 && editDistance(ln, last) <= 1) {
        cands = cands.concat(arr);
        lastFuzzy = true;
      }
    }
  }
  if (cands.length === 1) {
    return { entry: cands[0], confidence: lastFuzzy ? 'low' : 'high', via: lastFuzzy ? 'lastname-fuzzy' : 'lastname' };
  }
  if (cands.length > 1) {
    const scored = cands.map((e) => {
      const ef = (e._key.split(' ')[0]) || '';
      let s;
      if (ef === firstTok) s = 4;
      else if (ef[0] === firstTok[0] && (ef.startsWith(firstTok) || firstTok.startsWith(ef))) s = 3;
      else if (ef[0] === firstTok[0]) s = 2;
      else s = 1 - editDistance(ef, firstTok);
      return { e, s };
    }).sort((a, b) => b.s - a.s);
    if (scored[0].s >= 2 && (scored.length === 1 || scored[0].s > scored[1].s)) {
      // First name matched exactly on an unambiguous last name is trustworthy;
      // anything weaker (initial-only, or last name was fuzzy) is worth confirming.
      const conf = (scored[0].s >= 4 && !lastFuzzy) ? 'high' : 'medium';
      return { entry: scored[0].e, confidence: conf, via: 'lastname-first' };
    }
    return { entry: null, confidence: 'none', via: 'ambiguous' };
  }

  // No last-name anchor — bounded global edit-distance on the spaceless key.
  let best = null, bestD = Infinity, tie = false;
  for (const [cc, arr] of index.byCompact) {
    if (Math.abs(cc.length - compact.length) > 2) continue;
    const d = editDistance(cc, compact);
    if (d < bestD) { bestD = d; best = arr[0]; tie = false; }
    else if (d === bestD) { tie = true; }
  }
  const thresh = compact.length >= 10 ? 2 : 1;
  if (best && !tie && bestD <= thresh) {
    return { entry: best, confidence: 'low', via: 'editdistance' };
  }
  return { entry: null, confidence: 'none', via: 'none' };
}

// Back-compat thin wrapper: just the matched entry (or null). Most callers want
// only the player; use matchName/findNameDetailed when you also need confidence.
function findName(raw, index) {
  return matchName(raw, index).entry || null;
}

// Alias for clarity at call sites that care about the confidence metadata.
const findNameDetailed = matchName;

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

// ---------------------------------------------------------------------------
// Team-defense (D/ST) detection.
// A defense ranking row is *just a team* — "Philadelphia Eagles", "49ers",
// "Cowboys DST" — with no player name. We map those to position DST so they
// aren't mistaken for a player named after the team.
// ---------------------------------------------------------------------------

// Canonical identity (primary abbreviation -> city + nickname). Nicknames are
// unique across the league, which makes them a reliable, unambiguous signal.
const TEAM_NAMES = {
  ARI: { city: 'Arizona', nick: 'Cardinals' },
  ATL: { city: 'Atlanta', nick: 'Falcons' },
  BAL: { city: 'Baltimore', nick: 'Ravens' },
  BUF: { city: 'Buffalo', nick: 'Bills' },
  CAR: { city: 'Carolina', nick: 'Panthers' },
  CHI: { city: 'Chicago', nick: 'Bears' },
  CIN: { city: 'Cincinnati', nick: 'Bengals' },
  CLE: { city: 'Cleveland', nick: 'Browns' },
  DAL: { city: 'Dallas', nick: 'Cowboys' },
  DEN: { city: 'Denver', nick: 'Broncos' },
  DET: { city: 'Detroit', nick: 'Lions' },
  GB: { city: 'Green Bay', nick: 'Packers' },
  HOU: { city: 'Houston', nick: 'Texans' },
  IND: { city: 'Indianapolis', nick: 'Colts' },
  JAX: { city: 'Jacksonville', nick: 'Jaguars' },
  KC: { city: 'Kansas City', nick: 'Chiefs' },
  LAC: { city: 'Los Angeles', nick: 'Chargers' },
  LAR: { city: 'Los Angeles', nick: 'Rams' },
  LV: { city: 'Las Vegas', nick: 'Raiders' },
  MIA: { city: 'Miami', nick: 'Dolphins' },
  MIN: { city: 'Minnesota', nick: 'Vikings' },
  NE: { city: 'New England', nick: 'Patriots' },
  NO: { city: 'New Orleans', nick: 'Saints' },
  NYG: { city: 'New York', nick: 'Giants' },
  NYJ: { city: 'New York', nick: 'Jets' },
  PHI: { city: 'Philadelphia', nick: 'Eagles' },
  PIT: { city: 'Pittsburgh', nick: 'Steelers' },
  SEA: { city: 'Seattle', nick: 'Seahawks' },
  SF: { city: 'San Francisco', nick: '49ers' },
  TB: { city: 'Tampa Bay', nick: 'Buccaneers' },
  TEN: { city: 'Tennessee', nick: 'Titans' },
  WAS: { city: 'Washington', nick: 'Commanders' },
};

// Alternate abbreviations OCR/sites use, mapped to the primary key above.
const TEAM_ABBR_ALIASES = {
  GB: ['GNB'], KC: ['KAN'], NE: ['NWE'], NO: ['NOR'], TB: ['TAM'],
  SF: ['SFO'], LV: ['LVR', 'OAK'], LAR: ['LA', 'STL'], LAC: ['SD'],
  WAS: ['WSH'], JAX: ['JAC'],
};

// Tokens that mark a row as a defense rather than identifying the team.
const DST_MARKERS = new Set(['dst', 'def', 'defense', 'defenses', 'dest', 'd', 'st', 'ds', 'sts']);

// Built once from TEAM_NAMES:
//   NICK_TO_ABBR        nickname -> primary abbr (unique)
//   TEAM_NAMEWORDS      abbr -> Set of city words + nickname (the "name" signal)
//   TEAM_TOKENS         abbr -> Set of every token that belongs to the team
//   ALT_ABBR_TO_PRIMARY any abbreviation (upper) -> primary abbr
const NICK_TO_ABBR = {};
const TEAM_NAMEWORDS = {};
const TEAM_TOKENS = {};
const ALT_ABBR_TO_PRIMARY = {};
for (const [abbr, info] of Object.entries(TEAM_NAMES)) {
  const nick = info.nick.toLowerCase();
  const cityWords = info.city.toLowerCase().split(/\s+/).filter(Boolean);
  NICK_TO_ABBR[nick] = abbr;
  const nameWords = new Set([nick, ...cityWords]);
  TEAM_NAMEWORDS[abbr] = nameWords;
  const all = new Set([...nameWords, abbr.toLowerCase()]);
  ALT_ABBR_TO_PRIMARY[abbr] = abbr;
  for (const alias of (TEAM_ABBR_ALIASES[abbr] || [])) {
    all.add(alias.toLowerCase());
    if (!ALT_ABBR_TO_PRIMARY[alias]) ALT_ABBR_TO_PRIMARY[alias] = abbr;
  }
  TEAM_TOKENS[abbr] = all;
}

// If `text` is just a team (a defense row), return that team's primary
// abbreviation; otherwise ''. Requires either a team NAME word (city/nickname)
// or an explicit D/ST marker, and that EVERY remaining word belongs to the same
// team — so a real player line (which has an unexplained name word) never matches.
function teamDefenseFromLine(text) {
  if (!text) return '';
  const cleaned = String(text).toLowerCase().replace(/[^a-z0-9\s]/g, ' ');
  const raw = cleaned.split(/\s+/).filter(Boolean);
  if (!raw.length) return '';

  let hasMarker = false;
  const core = [];
  for (const t of raw) {
    if (DST_MARKERS.has(t)) hasMarker = true;
    else core.push(t);
  }
  if (!core.length) return '';

  // Identify the team by nickname first (unique), then by an abbreviation token.
  let abbr = '';
  for (const t of core) {
    if (NICK_TO_ABBR[t]) { abbr = NICK_TO_ABBR[t]; break; }
  }
  if (!abbr) {
    for (const t of core) {
      const a = teamFromToken(t);
      if (a) { abbr = ALT_ABBR_TO_PRIMARY[a] || a; break; }
    }
  }
  if (!abbr || !TEAM_TOKENS[abbr]) return '';

  // Every remaining word must belong to this team — otherwise it's a real
  // player (with a name word we don't recognize as part of the team).
  const allowed = TEAM_TOKENS[abbr];
  for (const t of core) {
    if (!allowed.has(t)) return '';
  }

  const hasNameWord = core.some((t) => TEAM_NAMEWORDS[abbr].has(t));
  if (!hasNameWord && !hasMarker) return '';
  return abbr;
}

// Display name for a detected team defense, e.g. "Philadelphia Eagles".
function teamDefenseName(abbr) {
  const info = TEAM_NAMES[abbr];
  return info ? `${info.city} ${info.nick}` : '';
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
  teamDefenseFromLine,
  teamDefenseName,
  compactKey,
  editDistance,
  buildNameIndex,
  findName,
  matchName,
  findNameDetailed,
  POSITIONS,
  NFL_TEAMS,
};
