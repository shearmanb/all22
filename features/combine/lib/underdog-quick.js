// Underdog quick upload — the one-shot weekly path.
//
// Every Underdog contest (and every week of a weekly contest) hands out fresh
// player IDs, so the owner cannot keep a saved Underdog file around the way
// the season-long export does. This path is deliberately STATELESS: give it
// the CSV downloaded from Underdog's rankings page plus any rankings file
// (FantasyPros weekly CSV, Scott Barrett's sheet, a pasted list), and it hands
// back Underdog's own file reordered — ranked players on top in the owner's
// order, everyone else after in Underdog's order, rows untouched. Nothing is
// saved; nothing needs the database.
//
// Rankings parsing reuses Combine's own readers: csv-import for anything with a
// header (columns auto-detected: FantasyPros "PLAYER NAME"/"POS", Scott's
// "NAME"/"Position"), and the text parser for a bare pasted list. Matching is
// underdog-ids' strict resolver — full-name hits stand, last-name hits must
// also agree on first name and position — so a miss is visible in the report
// instead of the wrong player landing at the top of the upload.
const csvImport = require('./csv-import');
const rankings = require('./rankings');
const underdogIds = require('./underdog-ids');
const players = require('../../../lib/players');

// Turn the owner's rankings input into [{ rank, name, position, team }] in
// rank order. A CSV with a recognised header goes through the column detector;
// anything else is treated as pasted text. Rows keep their explicit rank when
// the file publishes one (sorted, stable), otherwise file order is the rank.
function parseRankings(text) {
  const raw = String(text || '');
  if (!raw.trim()) throw new Error('The rankings file is empty.');

  const table = csvImport.importCsv(raw);
  let rows;
  if (table.headerFound && table.rows.length) {
    rows = table.rows.map((r, i) => ({
      order: i,
      rank: Number.isFinite(r.rank) ? r.rank : null,
      name: players.display(r.name),
      // FantasyPros publishes "RB12": drop the ordinal before recognising it.
      position: players.findPosition([String(r.position || '').trim().replace(/\d+$/, '')]) || '',
      team: players.teamFromToken(r.team || '') || String(r.team || '').trim().toUpperCase(),
    })).filter((r) => r.name);
    if (rows.length && rows.every((r) => r.rank !== null)) {
      rows.sort((a, b) => (a.rank - b.rank) || (a.order - b.order));
    }
  } else {
    rows = rankings.parse(raw).players.map((p, i) => ({
      order: i, rank: p.rank, name: p.name, position: p.position || '', team: p.team || '',
    }));
  }
  if (!rows.length) throw new Error('No player rows were found in the rankings file. It needs a player-name column (or one player per line).');
  return rows.map((r, i) => ({ rank: i + 1, name: r.name, position: r.position, team: r.team }));
}

// Build the upload. Returns
//   { csv, total, ranked, matched, unmatched: [{ rank, name, position, team, suggestion }] }
// `unmatched` is every ranked player with no trustworthy Underdog row, with the
// nearest Underdog name when there is a close one (so a spelling gap is a
// one-glance fix rather than a mystery).
function build(underdogCsv, rankingsText) {
  const ranked = parseRankings(rankingsText);
  const exp = underdogIds.buildExport(underdogCsv, ranked);
  const report = underdogIds.matchReport(underdogCsv, ranked);
  const suggestions = new Map(report.unmatched.map((u) => [players.key(u.name), u.suggestion]));
  const missing = new Set(exp.unmatched.map((n) => players.key(n)));
  const unmatched = ranked
    .filter((r) => missing.has(players.key(r.name)))
    .map((r) => ({ rank: r.rank, name: r.name, position: r.position, team: r.team, suggestion: suggestions.get(players.key(r.name)) || null }));
  return { csv: exp.csv, total: exp.total, ranked: ranked.length, matched: exp.matched, unmatched };
}

module.exports = { parseRankings, build };
