// Vanilla CSV — the universal, site-agnostic export. This is phase one's
// guaranteed output: a plain table that opens in Excel/Sheets.
//
// COLUMNS: Rank, Player, Position, Team, Pos Rank [, Auction $]
// The "Auction $" column is added only when the set actually carries auction
// values (optional per PRD — rank-only lists stay a clean 5-column table).
const { toCsv } = require('./util');

module.exports = {
  id: 'vanilla',
  label: 'Plain CSV (Excel)',
  description: 'Universal Rank / Player / Position / Team / Pos Rank table (plus an Auction $ column when the set has auction values). Opens directly in Excel or Google Sheets.',
  filenameBase: 'rankings',
  verified: true,
  build(players) {
    const hasAuction = players.some((p) => p.auction_value !== null && p.auction_value !== undefined);
    const headers = ['Rank', 'Player', 'Position', 'Team', 'Pos Rank'];
    if (hasAuction) headers.push('Auction $');
    const rows = players.map((p) => {
      // Position rank as the familiar "QB5" form when we have both pieces.
      const posRank = p.position && p.posRank ? `${p.position}${p.posRank}` : '';
      const row = [p.rank, p.name, p.position || '', p.team || '', posRank];
      if (hasAuction) row.push(p.auction_value === null || p.auction_value === undefined ? '' : p.auction_value);
      return row;
    });
    return toCsv(headers, rows);
  },
};
