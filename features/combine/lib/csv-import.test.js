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

test('FantasyPoints season projections export (quoted cells, duplicate POS columns)', () => {
  const csv = [
    '"RK","Name","POS","Team","Bye","POS","ADP","FPTS","G","FPTS/G","TIER"',
    '"1","Josh Allen","QB","BUF","7","QB1","28.2","335.9","15","22.39","1"',
    '"2","Lamar Jackson","QB","BLT","13","QB2","37.9","312.2","15","20.81","2"',
  ].join('\n');
  const { rows, mapping, headerFound } = importCsv(csv);
  assert.equal(headerFound, true);
  // The plain "POS" column wins over the "QB1"-style positional-rank column.
  assert.equal(mapping.pos, 2);
  assert.equal(rows.length, 2);
  // Bye week is dropped; every OTHER extra column rides along in the note under
  // its own label, so nothing the source published is silently thrown away.
  assert.deepEqual(rows[0], {
    name: 'Josh Allen', position: 'QB', team: 'BUF', rank: 1,
    notes: 'Pos: QB1 · Adp: 28.2 · Fpts: 335.9 · G: 15 · Fpts/G: 22.39 · Tier: 1',
  });
  assert.equal(rows[1].name, 'Lamar Jackson');
  assert.ok(!/Bye/i.test(rows[1].notes));
});

test('a headerless spreadsheet range is mapped by what the cells look like', () => {
  const tsv = [
    '1\tJahmyr Gibbs\tRB\tDET\t6\t$60',
    '2\tBijan Robinson\tRB\tATL\t11\t$59',
    '3\tChristian McCaffrey\tRB\tSF\t8\t$54',
  ].join('\n');
  const { rows, mapping, headerFound } = importCsv(tsv);
  assert.equal(headerFound, false);
  assert.equal(mapping.name, 1);
  assert.equal(mapping.pos, 2);
  assert.equal(mapping.team, 3);
  assert.equal(mapping.rank, 0);
  assert.equal(mapping.auction, 5);
  assert.equal(mapping.notes, -1);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].name, 'Jahmyr Gibbs');
  assert.equal(rows[0].position, 'RB');
  assert.equal(rows[0].auction_value, 60);
});

test('a notes/comment column is detected and carried on the row', () => {
  const csv = [
    'Rank,Player,Pos,Team,Comments',
    '1,Jahmyr Gibbs,RB,DET,"Elite dual-threat, locked top pick"',
    '2,Bijan Robinson,RB,ATL,',
  ].join('\n');
  const { rows, mapping } = importCsv(csv);
  assert.ok(mapping.notes >= 0);
  assert.equal(rows[0].notes, 'Elite dual-threat, locked top pick');
  assert.equal(rows[1].notes, undefined);
});

test('a one-name-per-line list is still read as bare names', () => {
  const { rows } = importCsv('Bijan Robinson\nJustin Jefferson');
  assert.deepEqual(rows.map((r) => r.name), ['Bijan Robinson', 'Justin Jefferson']);
});

test('extra columns ride along in the note, bye week does not', () => {
  const csv = [
    'OVERALL,NAME,Position,Team,BYE,$$$,AUCTION RK,TIER',
    '1,Jahmyr Gibbs,RB,DET,6,$60,1,1',
  ].join('\n');
  const { rows } = importCsv(csv);
  assert.equal(rows[0].name, 'Jahmyr Gibbs');
  assert.equal(rows[0].auction_value, 60);
  assert.equal(rows[0].notes, 'Auction Rk: 1 · Tier: 1');
});

test('a headerless paste drops stray numbers rather than guessing at them', () => {
  // No header means no label for the "6"/"11" column — that is the bye-week
  // noise, and an unlabelled number in a note would be worse than useless.
  const { rows } = importCsv('1\tJahmyr Gibbs\tRB\tDET\t6\t$60\n2\tBijan Robinson\tRB\tATL\t11\t$59');
  assert.equal(rows[0].notes, undefined);
  assert.equal(rows[1].notes, undefined);
});
