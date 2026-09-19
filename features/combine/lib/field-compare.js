// field-compare.js — where the owner's rankings sit against the field.
//
// The weekly Underdog build answers "put my list in Underdog's file". This
// answers the next question: where does my source (Fantasy Points) disagree
// with everyone else? Two fields to compare against, deliberately kept apart:
//
//   Underdog's board  — the contest's own numbers, out of the same CSV the
//                       upload is built from. `adp` is where the field actually
//                       drafts him; `projectedPoints` is Underdog's model.
//   Expert consensus  — FantasyPros ECR (fetched by lib/fetch-rankings.js, or
//                       a downloaded FantasyPros file), plus how widely the
//                       experts disagree about him when the page publishes it.
//
// They are NEVER averaged into a single "field" number. An ADP and a consensus
// rank measure different things, and blending them would bury exactly the kind
// of modelling decision the PRD says to leave visible (PRD §17).
//
// **Ranks are compared over the players two lists SHARE.** A weekly Underdog
// slate carries only the teams playing and no kickers or defenses; a weekly ECR
// flex list carries no quarterbacks. Subtracting raw ranks across lists of
// different sizes measures the size difference, not the disagreement — so for
// each pair we re-number BOTH lists 1..N over their shared players and compare
// those. The raw ranks travel alongside, because the owner still wants to read
// "Underdog's ADP has him 6th".
//
// Names resolve through underdog-ids' strict resolver — the one that requires a
// last-name hit to agree on the first name and position — so this view never
// invents a disagreement out of two different players (CLAUDE.md: one name
// engine, never a second copy).
const underdogIds = require('./underdog-ids');
const players = require('../../../lib/players');

// How much of the file a column must fill before it can order the board. A
// share, not a count: three ADPs in a 120-player contest is a stray column, not
// a board, and ranking off it would leave the comparison almost empty. Half the
// file is the line — below it the next basis gets a turn.
const MIN_RANKED_SHARE = 0.5;

// How deep into a source's own order to look when reporting who the field likes
// and the owner's list never mentions.
const MAX_MISSING_REPORTED = 12;

function round1(n) {
  return n === null || n === undefined ? null : Math.round(n * 10) / 10;
}

// Order a list of items by a numeric key, giving 1..N to the ones that HAVE the
// number and null to the ones that don't. `dir` is 'asc' (ADP: low is better)
// or 'desc' (projected points: high is better). File order breaks ties, so the
// result is stable and reproducible.
function rankBy(items, pick, dir) {
  const withNumber = items.filter((it) => {
    const v = pick(it);
    return v !== null && v !== undefined && Number.isFinite(v) && v > 0;
  });
  withNumber.sort((a, b) => {
    const d = dir === 'desc' ? pick(b) - pick(a) : pick(a) - pick(b);
    return d || (a.order - b.order);
  });
  const ranks = new Map();
  withNumber.forEach((it, i) => ranks.set(it.order, i + 1));
  return items.map((it) => Object.assign({}, it, { rank: ranks.has(it.order) ? ranks.get(it.order) : null }));
}

// Underdog's own board out of the contest CSV.
//
// `wanted` is 'adp' | 'projection' | 'file'. ADP is the default because it is
// the field's actual behaviour AND because it survives the owner's own
// uploads: the file he downloads comes back in whatever order he last uploaded,
// so FILE ORDER IS NOT UNDERDOG'S RANKING once he has used this app. File order
// is offered only as the last resort, and the caller is told when it was used
// so the page can say so out loud.
function underdogBoard(csvText, wanted) {
  const parsed = underdogIds.parse(csvText);
  const items = parsed.rows.map((r, i) => ({
    order: i,
    name: r.name,
    position: underdogIds.normPos(r.position),
    team: r.team,
    adp: r.adp,
    projected: r.projected,
    bye: r.bye,
  }));

  const fills = (pick) => {
    if (!items.length) return 0;
    return items.filter((it) => Number.isFinite(pick(it)) && pick(it) > 0).length / items.length;
  };
  const hasAdp = fills((it) => it.adp) >= MIN_RANKED_SHARE;
  const hasProj = fills((it) => it.projected) >= MIN_RANKED_SHARE;

  const requested = ['adp', 'projection', 'file'].includes(wanted) ? wanted : 'adp';
  let basis = requested;
  if (basis === 'adp' && !hasAdp) basis = hasProj ? 'projection' : 'file';
  else if (basis === 'projection' && !hasProj) basis = hasAdp ? 'adp' : 'file';

  let rows;
  if (basis === 'adp') rows = rankBy(items, (it) => it.adp, 'asc');
  else if (basis === 'projection') rows = rankBy(items, (it) => it.projected, 'desc');
  else rows = items.map((it, i) => Object.assign({}, it, { rank: i + 1 }));

  return {
    kind: 'underdog',
    basis,
    requested,
    fell_back: basis !== requested,
    // Said out loud on the page — a board the owner didn't ask for, or one
    // built out of file order, has to announce itself.
    note: basis === 'file'
      ? 'Underdog\'s file publishes no ADP or projections here, so this is the file\'s own row order — which is whatever order you last uploaded, not Underdog\'s ranking.'
      : (basis !== requested ? `Underdog's file publishes no ${requested === 'adp' ? 'ADP' : 'projections'} here, so this uses ${basis === 'adp' ? 'ADP' : 'projections'}.` : ''),
    rows,
    total: rows.length,
    ranked: rows.filter((r) => r.rank !== null).length,
  };
}

// Pull a labelled number back out of the note csv-import builds for the columns
// it doesn't claim ("Tiers: 1 · Best: 1 · Worst: 3 · Avg.: 1.4 · Std.Dev: 0.6").
// That note is how a FantasyPros DOWNLOAD carries the expert spread, so the
// file path shows the same numbers as the fetched page instead of a blank
// column. Only an explicitly labelled cell counts — nothing is guessed out of a
// stray number.
function labelled(note, re) {
  for (const part of String(note || '').split('·')) {
    const bit = part.trim();
    const at = bit.indexOf(':');
    if (at < 0) continue;
    if (!re.test(bit.slice(0, at).trim())) continue;
    const n = Number(bit.slice(at + 1).trim().replace(/[^0-9.-]/g, ''));
    if (Number.isFinite(n)) return n;
  }
  return null;
}

// Take the row's own field when it has one, else whatever its note labelled.
function fromRow(r, field, re) {
  const own = Number(r[field]);
  if (r[field] !== null && r[field] !== undefined && r[field] !== '' && Number.isFinite(own)) return own;
  return labelled(r.notes, re);
}

// "RB12" is a positional rank; "RB" on its own is just a position and says
// nothing. Only the numbered form is worth showing.
function posRankOf(r) {
  if (r.pos_rank) return String(r.pos_rank);
  const raw = String(r.position_raw || '').trim().toUpperCase();
  return /^[A-Z]{1,3}\d+$/.test(raw) ? raw : '';
}

// Expert consensus as a board. Takes the rows fetch-rankings hands back (which
// carry the published rank and the expert spread) or the plainer rows a parsed
// FantasyPros download yields — whatever is missing stays null rather than
// being filled in.
function ecrBoard(rows, meta) {
  const items = (rows || [])
    .filter((r) => r && String(r.name || '').trim())
    .map((r, i) => ({
      order: i,
      name: players.display(r.name),
      position: underdogIds.normPos(r.position),
      team: players.primaryTeam(r.team || '') || String(r.team || '').toUpperCase(),
      rank: Number.isFinite(Number(r.rank)) && Number(r.rank) > 0 ? Number(r.rank) : i + 1,
      ave: round1(fromRow(r, 'ave', /^avg\.?$|^ave\.?$|^average$/i)),
      std: round1(fromRow(r, 'std', /^std\.?\s*dev\.?$|^std\.?$|^stdev$/i)),
      best: fromRow(r, 'best', /^best$|^high$|^min$/i),
      worst: fromRow(r, 'worst', /^worst$|^low$|^max$/i),
      tier: fromRow(r, 'tier', /^tiers?$/i),
      pos_rank: posRankOf(r),
    }));
  // The published rank is the order; sort by it so a file that arrived shuffled
  // still reads as a consensus list.
  items.sort((a, b) => (a.rank - b.rank) || (a.order - b.order));
  return {
    kind: 'ecr',
    meta: meta || null,
    rows: items,
    total: items.length,
    ranked: items.length,
    // A consensus list only means something with enough experts behind it; the
    // count rides along so the page can show it rather than implying authority.
    experts: (meta && meta.total_experts) || null,
  };
}

// Resolve every ranked player against a board, strictly. Returns an array
// parallel to `ranked` holding the board row index or null, and never lets two
// ranked players claim the same board row (the owner listing a player twice
// must not double-count him).
function matchAgainst(ranked, board) {
  const index = underdogIds.buildIndex(board.rows);
  const used = new Set();
  return (ranked || []).map((p) => {
    const hit = underdogIds.resolveRow(index, board.rows, p);
    if (!hit || used.has(hit.idx)) return null;
    used.add(hit.idx);
    return hit.idx;
  });
}

// Re-number both lists over the players they share. Returns two maps keyed by
// the ranked player's array position: where HE sits in the shared pool, and
// where the board puts him in that same pool.
function poolRanks(ranked, board, hits) {
  const pairs = [];
  hits.forEach((idx, i) => {
    if (idx === null) return;
    if (board.rows[idx].rank === null) return; // the board doesn't rank him
    pairs.push({ i, idx });
  });
  const mine = pairs.slice().sort((a, b) => (ranked[a.i].rank - ranked[b.i].rank) || (a.i - b.i));
  const theirs = pairs.slice().sort((a, b) => (board.rows[a.idx].rank - board.rows[b.idx].rank) || (a.idx - b.idx));
  const minePos = new Map();
  mine.forEach((p, n) => minePos.set(p.i, n + 1));
  const theirPos = new Map();
  theirs.forEach((p, n) => theirPos.set(p.i, n + 1));
  return { minePos, theirPos, pool: pairs.length };
}

// Who does this board rank inside the range the owner's list covers, that his
// list never mentions? Capped at the depth his list actually reaches, because
// a 150-player file is not "missing" the 400th player on a season-long board.
function missingFrom(board, hits, matched) {
  const claimed = new Set(hits.filter((h) => h !== null));
  const depth = matched;
  return board.rows
    .filter((r, i) => !claimed.has(i) && r.rank !== null && r.rank <= depth)
    .sort((a, b) => a.rank - b.rank)
    .slice(0, MAX_MISSING_REPORTED)
    .map((r) => ({ rank: r.rank, name: r.name, position: r.position, team: r.team, adp: r.adp === undefined ? null : r.adp }));
}

// Attach one board to the ranked list. Returns { cells, summary } where `cells`
// is parallel to `ranked`.
function against(ranked, board) {
  const hits = matchAgainst(ranked, board);
  const { minePos, theirPos, pool } = poolRanks(ranked, board, hits);
  const matched = hits.filter((h) => h !== null).length;

  const cells = hits.map((idx, i) => {
    if (idx === null) return null;
    const row = board.rows[idx];
    const mine = minePos.has(i) ? minePos.get(i) : null;
    const theirs = theirPos.has(i) ? theirPos.get(i) : null;
    // Positive = the field has him LATER than the owner's list does, i.e. his
    // source is higher on the player than this board is.
    const delta = (mine !== null && theirs !== null) ? (theirs - mine) : null;
    return {
      name: row.name,
      rank: row.rank,
      pool_rank: theirs,
      my_pool_rank: mine,
      delta,
      adp: row.adp === undefined ? null : row.adp,
      projected: row.projected === undefined ? null : row.projected,
      ave: row.ave === undefined ? null : row.ave,
      std: row.std === undefined ? null : row.std,
      best: row.best === undefined ? null : row.best,
      worst: row.worst === undefined ? null : row.worst,
      tier: row.tier === undefined ? null : row.tier,
      pos_rank: row.pos_rank || '',
    };
  });

  const summary = {
    kind: board.kind,
    basis: board.basis || null,
    note: board.note || '',
    total: board.total,
    ranked: board.ranked,
    matched,
    pool,
    experts: board.experts || null,
    meta: board.meta || null,
    missing: missingFrom(board, hits, matched),
  };
  return { cells, summary };
}

// The whole comparison.
//   ranked    the owner's list, [{ rank, name, position, team }] in his order
//   boards    { underdog?, ecr? } — either may be absent (a dead ECR fetch must
//             not cost the Underdog comparison, same rule the ADP collector
//             follows when one source goes down)
// Returns { ranked, rows, underdog, ecr } where rows follow the owner's order.
function compare(ranked, boards) {
  const list = (ranked || []).filter((p) => p && String(p.name || '').trim());
  const ud = (boards && boards.underdog) ? against(list, boards.underdog) : null;
  const ecr = (boards && boards.ecr) ? against(list, boards.ecr) : null;

  const rows = list.map((p, i) => ({
    rank: p.rank,
    name: p.name,
    position: underdogIds.normPos(p.position),
    team: players.primaryTeam(p.team || '') || String(p.team || '').toUpperCase(),
    ud: ud ? ud.cells[i] : null,
    ecr: ecr ? ecr.cells[i] : null,
  }));

  return {
    ranked: list.length,
    rows,
    underdog: ud ? ud.summary : null,
    ecr: ecr ? ecr.summary : null,
  };
}

module.exports = { underdogBoard, ecrBoard, compare, rankBy, poolRanks, matchAgainst, MIN_RANKED_SHARE };
