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

// Read what a rankings file says about WHICH week it covers. Fantasy Points
// publishes WEEK and SEASON columns; most sources publish neither, and then
// there is simply no week — never a guessed one. Returns { week, season, rows }
// with week/season null when the file doesn't say.
function detectMeta(text) {
  const out = { week: null, season: null, rows: 0 };
  let table;
  try { table = csvImport.importCsv(String(text || '')); } catch (e) { return out; }
  out.rows = table.rows.length;
  if (!table.headerFound) return out;
  const labels = (table.mapping.labels || []).map((l) => String(l || '').trim().toLowerCase());
  const readColumn = (re) => {
    const col = labels.findIndex((l) => re.test(l));
    if (col < 0) return null;
    // The most common value in the column — a weekly file repeats one week on
    // every row, and one odd cell shouldn't decide it.
    const tally = new Map();
    for (const r of (table.dataRows || [])) {
      const v = parseInt(String(r[col] == null ? '' : r[col]).replace(/[^0-9]/g, ''), 10);
      if (!Number.isFinite(v)) continue;
      tally.set(v, (tally.get(v) || 0) + 1);
    }
    let best = null, bestN = 0;
    for (const [v, n] of tally) if (n > bestN) { best = v; bestN = n; }
    return best;
  };
  const week = readColumn(/^week$/);
  const season = readColumn(/^season$|^year$/);
  if (week !== null && week >= 1 && week <= 23) out.week = week;
  if (season !== null && season >= 2000 && season <= 2100) out.season = season;
  return out;
}

// Two digits, for a timestamp that has to survive being a file name.
function pad(n) { return String(n).padStart(2, '0'); }

// The default name for a build: what it is, which week, and WHEN the rankings
// were published — because the same week gets re-ranked as news breaks, and the
// only thing separating two files for week 2 is their timestamp.
//   "UD RANKINGS - Week 2 FP 2026-09-12 0930"
// `modified` is the rankings file's own last-modified time (the browser reads
// it off the file); without one, the moment the build ran is the honest stamp.
function suggestLabel(meta, modified) {
  const d = modified ? new Date(modified) : new Date();
  const when = Number.isFinite(d.getTime()) ? d : new Date();
  const stamp = `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())} ` +
    `${pad(when.getHours())}${pad(when.getMinutes())}`;
  const week = (meta && meta.week) ? `Week ${meta.week}` : 'Week ?';
  return `UD RANKINGS - ${week} FP ${stamp}`;
}

// Build the upload. Returns
//   { csv, total, ranked, matched,
//     unmatched: [{ rank, name, position, team, suggestion, candidates }],
//     flagged:   [{ name, underdog_name, ranked_position, underdog_position }] }
// `unmatched` is every ranked player with no trustworthy Underdog row, with the
// nearest Underdog name when there is a close one (so a spelling gap is a
// one-glance fix rather than a mystery). `flagged` is every player who DID make
// the upload on an exact name while the two sources file him at different
// positions — worth an eyeball, never silently dropped.
function build(underdogCsv, rankingsText) {
  const ranked = parseRankings(rankingsText);
  const exp = underdogIds.buildExport(underdogCsv, ranked);
  const report = underdogIds.matchReport(underdogCsv, ranked);
  const detail = new Map(report.unmatched.map((u) => [players.key(u.name), u]));
  const missing = new Set(exp.unmatched.map((n) => players.key(n)));
  const unmatched = ranked
    .filter((r) => missing.has(players.key(r.name)))
    .map((r) => {
      const d = detail.get(players.key(r.name)) || {};
      return {
        rank: r.rank, name: r.name, position: r.position, team: r.team,
        suggestion: d.suggestion || null, candidates: d.candidates || [],
      };
    });
  return { csv: exp.csv, total: exp.total, ranked: ranked.length, matched: exp.matched, unmatched, flagged: exp.flagged };
}

module.exports = { parseRankings, detectMeta, suggestLabel, build };
