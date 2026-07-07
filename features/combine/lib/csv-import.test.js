const test = require('node:test');
const assert = require('node:assert');
const { importCsv, parseTable } = require('./csv-import');

test('parses a FantasyPros-style CSV export and maps columns by header', () => {
  const csv = [
    '"RK","TIERS","PLAYER NAME","TEAM","POS","BYE WEEK"',
    '"1","1","Ja\'Marr Chase","CIN","WR1","10"',
    '"2","1","Bijan Robinson","ATL","RB1","5"',
  ].join('\n');
  const { rows, mapping, headerFound } = importCsv(csv);
  assert.ok(headerFound);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].name, "Ja'Marr Chase");
  assert.equal(rows[0].team, 'CIN');
  assert.equal(rows[0].position, 'WR1');   // cleaned to WR downstream by the pipeline
  assert.equal(rows[0].rank, 1);
  assert.equal(mapping.auction, -1);        // no auction column here
  assert.equal(rows[0].auction_value, undefined);
});

test('detects an auction value column and strips $', () => {
  const csv = 'Rank,Player,Pos,Team,Auction $\n1,Bijan Robinson,RB,ATL,$52\n2,Breece Hall,RB,NYJ,41';
  const { rows, mapping } = importCsv(csv);
  assert.ok(mapping.auction >= 0);
  assert.equal(rows[0].auction_value, 52);
  assert.equal(rows[1].auction_value, 41);
});

test('handles tab-separated paste from a spreadsheet', () => {
  const tsv = 'Player\tTeam\tPos\nJustin Jefferson\tMIN\tWR\nSaquon Barkley\tPHI\tRB';
  const { rows } = importCsv(tsv);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].name, 'Justin Jefferson');
  assert.equal(rows[0].team, 'MIN');
});

test('quoted fields with embedded commas survive', () => {
  const table = parseTable('Player,Note\n"Smith, Jr., Roy","big, if true"');
  assert.deepEqual(table[1], ['Smith, Jr., Roy', 'big, if true']);
});

test('a bare one-name-per-line list still works (no header)', () => {
  const { rows, headerFound } = importCsv('Ja\'Marr Chase\nBijan Robinson\nJustin Jefferson');
  assert.equal(headerFound, false);
  assert.equal(rows.length, 3);
  assert.equal(rows[2].name, 'Justin Jefferson');
});

test('skips a repeated header row inside the data', () => {
  const csv = 'Player,Team\nBijan Robinson,ATL\nPlayer,Team\nBreece Hall,NYJ';
  const { rows } = importCsv(csv);
  assert.deepEqual(rows.map((r) => r.name), ['Bijan Robinson', 'Breece Hall']);
});
