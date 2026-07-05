// Vanilla CSV — the universal, site-agnostic export. This is phase one's
// guaranteed output: a plain table that opens in Excel/Sheets.
//
// COLUMNS: Rank, Player, Position, Team, Pos Rank
const { toCsv } = require('./util');

module.exports = {
  id: 'vanilla',
  label: 'Plain CSV (Excel)',
  description: 'Universal Rank / Player / Position / Team / Pos Rank table. Opens directly in Excel or Google Sheets.',
  filenameBase: 'rankings',
  verified: true,
  build(players) {
    const headers = ['Rank', 'Player', 'Position', 'Team', 'Pos Rank'];
    const rows = players.map((p) => {
      // Position rank as the familiar "QB5" form when we have both pieces.
      const posRank = p.position && p.posRank ? `${p.position}${p.posRank}` : '';
      return [p.rank, p.name, p.position || '', p.team || '', posRank];
    });
    return toCsv(headers, rows);
  },
};
