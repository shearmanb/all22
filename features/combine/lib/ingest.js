// ingest.js — the one matching pipeline every Combine input goes through.
// Rows can come from Claude vision, Tesseract-OCR'd text, or a paste; by the
// time they're here they look like
// [{ rank?, name, position?, team?, auction_value?, notes? }].
//
// Pure logic: takes the players_master name index as an argument so it's
// testable without a database. Never guesses silently — every output row
// carries { player_id, confidence, via } and anything below 'high' is the
// review queue's business.
const players = require('../../../lib/players');

// Rank = order in the list. Rankings are always presented in rank order, and a
// printed rank column is the least reliable thing OCR reads (movement badges,
// cut-off digits) — the proven rule from the old converter. Printed ranks, when
// present and sane, agree with list order anyway.
function assignRanks(rows) {
  return rows.map((r, i) => Object.assign({}, r, { rank: i + 1 }));
}

// Match one raw row against the master index. Returns the normalized shape.
function matchRow(raw, index) {
  const rawName = String(raw.name || '').trim();
  const rawPosition = String(raw.position || '').toUpperCase().replace(/\./g, '');
  const rawTeam = String(raw.team || '').toUpperCase().replace(/\./g, '');
  // Optional free-text note captured alongside the player (a source's comment
  // column, or the owner's own). Kept verbatim; NULL when there is none.
  const notes = String(raw.notes == null ? '' : raw.notes).trim() || null;
  // Optional captured auction value (kept verbatim; NULL when the source has none).
  const auctionValue = (raw.auction_value === null || raw.auction_value === undefined ||
    raw.auction_value === '' || !Number.isFinite(Number(raw.auction_value)))
    ? null : Number(raw.auction_value);

  // Team-defense rows resolve by team identity, not fuzzy name matching.
  const dstAbbr = players.teamDefenseFromLine(rawName) ||
    (rawPosition === 'DST' ? players.teamFromToken(rawTeam) : '');
  const lookupName = dstAbbr ? players.teamDefenseName(dstAbbr) : rawName;

  const m = players.findNameDetailed(lookupName, index);
  const hit = m.entry;

  let confidence = m.confidence;
  // Identity guard: when the source printed a position and the matched player
  // plays a different one, the match is suspect — degrade it so it gets eyes.
  if (hit && rawPosition && hit.position && rawPosition !== hit.position && !dstAbbr) {
    confidence = confidence === 'high' ? 'medium' : 'low';
  }

  return {
    raw_name: rawName,
    raw_position: rawPosition,
    raw_team: rawTeam,
    player_id: hit ? hit.player_id : null,
    // Display fields: canonical when matched, cleaned-up raw otherwise.
    name: hit ? hit.name : (dstAbbr ? players.teamDefenseName(dstAbbr) : players.display(rawName)),
    position: (hit && hit.position) || (dstAbbr ? 'DST' : rawPosition),
    team: (hit && hit.team) || (dstAbbr ? dstAbbr : rawTeam),
    auction_value: auctionValue,
    notes,
    confidence: hit ? confidence : 'none',
    via: m.via,
  };
}

// The full pipeline: order -> rank -> match. `startRank` supports appending a
// second screenshot to an existing set (ranks continue where the set left off).
function matchRows(rows, index, startRank = 1) {
  const withNames = (rows || []).filter((r) => r && String(r.name || '').trim());
  return withNames.map((r, i) => {
    const out = matchRow(r, index);
    out.rank = startRank + i;
    return out;
  });
}

// Summarize a matched batch for the UI: how much needs the owner's eyes.
function reviewSummary(matched) {
  let unmatched = 0, uncertain = 0;
  for (const r of matched) {
    if (!r.player_id) unmatched++;
    else if (r.confidence !== 'high') uncertain++;
  }
  return { total: matched.length, unmatched, uncertain };
}

module.exports = { matchRows, matchRow, assignRanks, reviewSummary };
