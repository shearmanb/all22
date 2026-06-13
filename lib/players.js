// Canonical player-name normalization.
// Every parser, rankings ingester, and converter MUST use this module.
// Never duplicate name-matching logic elsewhere.

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

module.exports = { normalize, clean };
