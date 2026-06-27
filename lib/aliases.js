// Curated + learned name aliases: a name VARIANT a source writes -> the CANONICAL
// full name the NFL roster (Sleeper) and most sites use, which is what the matcher
// resolves against (lib/players.js).
//
// WHY THIS EXISTS
// The fuzzy matcher in players.js already handles, on its own:
//   - punctuation / casing      ("A.J. Brown" == "aj brown")
//   - suffixes                  ("Michael Pittman Jr." == "Michael Pittman")
//   - OCR noise / missing spaces ("].K. Dobbins", "TylerAllgeier")
//   - SHORT-vs-LONG first names that share a prefix ("Josh"/"Joshua",
//     "Chig"/"Chigoziem", "Gabe"/"Gabriel") — these resolve via prefix scoring.
// So you only need an alias for the ONE case it structurally cannot solve:
// a genuinely DIFFERENT first name attached to a COMMON last name, e.g.
// "Hollywood Brown" -> "Marquise Brown". Adding aliases for anything the matcher
// already handles is harmless but unnecessary.
//
// SAFETY
// An alias only fires on an EXACT key match of the variant, then looks the
// canonical up in the roster. An alias is therefore no less safe than typing that
// canonical name yourself: if the canonical is just unknown, the name falls
// through to normal fuzzy matching (no harm). The one caveat — keep canonicals
// spelled exactly — is that a canonical mistyped *close to another real player*
// could fuzzy-resolve to the wrong one. Good-faith, correctly-spelled entries are
// safe to add.
//
// HOW TO ADD MORE  (this is the "plan ahead" part)
//   - League-wide nickname -> add to COMMON.
//   - A specific site spells a player differently -> add to that site's block.
//   - A whole new site -> add a `const NEWSITE = {…}` block and list it in SOURCES.
// Keys are matched loosely through lib/players.key(), so case / periods /
// apostrophes / "Jr." don't matter in either the variant or the canonical.
//
// Aliases the owner saves while fixing an import ("remember this") are loaded
// from the converter_aliases table at runtime via addLearned() and merged into
// the same map, so the list grows automatically from real usage.

const { key } = require('./players');

// League-wide true nicknames (different first name, common last name).
const COMMON = {
  'Hollywood Brown': 'Marquise Brown',
  'Pop Douglas': 'Demario Douglas',
  'Nathaniel Dell': 'Tank Dell',
};

// Per-source spelling quirks. Seeded empty on purpose — fill these in from a real
// list off each site (or let the "remember this alias" flow populate them). The
// block names below are the sites the owner pulls rankings from.
const FANTASYPROS = {}; // FantasyPros (the source BeastDome's rankings come from)
const UNDERDOG = {};
const YAHOO = {};
const FANDUEL = {};
const FANTASY_POINTS = {};
const FANTASY_LABS = {}; // Fantasy Labs (Sean Koerner)

// The registry of every alias block. Add a new site here and it's live.
const SOURCES = {
  common: COMMON,
  fantasypros: FANTASYPROS,
  underdog: UNDERDOG,
  yahoo: YAHOO,
  fanduel: FANDUEL,
  fantasyPoints: FANTASY_POINTS,
  fantasyLabs: FANTASY_LABS,
};

// Build a lookup Map( normalized-variant-key -> canonical display name ) from one
// or more alias blocks.
function buildMap(sources) {
  const map = new Map();
  for (const block of Object.values(sources || {})) {
    for (const [variant, canonical] of Object.entries(block || {})) {
      const k = key(variant);
      if (k && canonical) map.set(k, canonical);
    }
  }
  return map;
}

// The shared, live alias map. Index builders pass this to players.buildNameIndex,
// which holds it BY REFERENCE — so aliases merged in later (learned) are picked up
// even by an already-built index.
const MAP = buildMap(SOURCES);

// Merge additional aliases in place. Accepts rows of { alias, canonical } (the
// shape stored in converter_aliases). Returns the shared MAP.
function addLearned(entries) {
  for (const e of entries || []) {
    const k = key((e && e.alias) || '');
    if (k && e && e.canonical) MAP.set(k, e.canonical);
  }
  return MAP;
}

// Rebuild the shared MAP from the curated seed plus the given learned entries,
// IN PLACE (same Map object, so indexes holding it by reference stay valid). Use
// this instead of addLearned when syncing from the database so that a learned
// alias the owner DELETED actually stops applying, rather than lingering in memory
// until the next restart.
function reload(learned) {
  MAP.clear();
  for (const [k, v] of buildMap(SOURCES)) MAP.set(k, v);
  return addLearned(learned);
}

module.exports = { MAP, SOURCES, buildMap, addLearned, reload };
