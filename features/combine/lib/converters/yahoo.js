// Yahoo Fantasy Football pre-draft rankings export.
//
// IMPORTANT — Yahoo has no first-party "upload rankings CSV" button; the common
// path is a browser extension that reads a CSV whose only hard requirement is a
// player-name column, matched against Yahoo's pre-draft "Top 300" list. We emit
// Rank + Player (plus Position/Team for matching). If the tool you use expects a
// different header, change the COLUMNS line below — that is the single place to edit.
//
// COLUMNS: "Rank","Player","Position","Team"
const { toCsv } = require('./util');

module.exports = {
  id: 'yahoo',
  label: 'Yahoo',
  description: 'Rank + player list for Yahoo pre-draft rankings (via the custom-rankings import tool). Requires a name column; confirm the header your import tool expects.',
  filenameBase: 'yahoo-rankings',
  verified: false,
  build(players) {
    const headers = ['Rank', 'Player', 'Position', 'Team'];
    const rows = players.map((p) => [p.rank, p.name, p.position || '', p.team || '']);
    return toCsv(headers, rows);
  },
};
