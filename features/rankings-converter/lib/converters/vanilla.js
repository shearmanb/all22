// Vanilla CSV — the universal, site-agnostic export. This is phase one's
// guaranteed output: a plain table that opens in Excel/Sheets.
//
// COLUMNS: Rank, Player, Position, Team
const { toCsv } = require('./util');

module.exports = {
  id: 'vanilla',
  label: 'Plain CSV (Excel)',
  description: 'Universal Rank / Player / Position / Team table. Opens directly in Excel or Google Sheets.',
  filenameBase: 'rankings',
  verified: true,
  build(players) {
    const headers = ['Rank', 'Player', 'Position', 'Team'];
    const rows = players.map((p) => [p.rank, p.name, p.position || '', p.team || '']);
    return toCsv(headers, rows);
  },
};
