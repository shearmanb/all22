// Underdog Fantasy rankings export.
//
// IMPORTANT — format drifts season to season. Underdog's own rankings page has a
// "CSV download/upload" button; the most reliable workflow is to DOWNLOAD their
// current CSV (it already contains every player with Underdog's exact names) and
// confirm the columns match what we emit here. As of the 2025 season Underdog's
// uploader matches players by name and reads a rank column, so we emit name +
// rank with position/team to help disambiguate. If Underdog rejects the file,
// adjust the COLUMNS line below to match the header row of a freshly downloaded
// template — that is the single place to change.
//
// COLUMNS: "First Name","Last Name","Position","Team","Rank"
const { toCsv, splitName } = require('./util');

module.exports = {
  id: 'underdog',
  label: 'Underdog (names only)',
  description: 'Legacy name-only list. For a file Underdog accepts with the correct player IDs, use the "Underdog upload (with player IDs)" section above instead.',
  filenameBase: 'underdog-rankings',
  verified: false,
  build(players) {
    const headers = ['First Name', 'Last Name', 'Position', 'Team', 'Rank'];
    const rows = players.map((p) => {
      const { first, last } = splitName(p.name);
      return [first, last, p.position || '', p.team || '', p.rank];
    });
    return toCsv(headers, rows);
  },
};
