// FantasyPros custom-rankings export (Cheat Sheet Creator "Import Rankings").
//
// FantasyPros' importer is the most forgiving of the bunch: it accepts a CSV (or
// a pasted block) with Player / Team / Position / Rank columns. We emit those in
// the order their Cheat Sheet Creator expects. If they tighten the format, edit
// the COLUMNS line below.
//
// COLUMNS: "Rank","Player","Team","Position"
const { toCsv } = require('./util');

module.exports = {
  id: 'fantasypros',
  label: 'FantasyPros',
  description: 'Rank / Player / Team / Position for the FantasyPros Cheat Sheet Creator "Import Rankings" box.',
  filenameBase: 'fantasypros-rankings',
  verified: true,
  build(players) {
    const headers = ['Rank', 'Player', 'Team', 'Position'];
    const rows = players.map((p) => [p.rank, p.name, p.team || '', p.position || '']);
    return toCsv(headers, rows);
  },
};
