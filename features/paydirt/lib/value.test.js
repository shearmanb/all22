// Tests for Pay Dirt's projections x salaries join. Run with: node --test
const test = require('node:test');
const assert = require('node:assert');
const { parseProjections, parseSalaries, perK, build } = require('./value');

// Fantasy Points' weekly export: the merged-cell group header on row 1, the
// real header on row 2, position and team both labelled "POS".
const FP =
  '"","","Player Details","","","","","Projection"\n' +
  '"#","NAME","POS","POS","SEASON","WEEK","OPP","FPTS"\n' +
  '"1","Jahmyr Gibbs","RB","DET","2026","7","NO","24.5"\n' +
  '"2","Puka Nacua","WR","LA","2026","7","SF","21.0"\n' +
  '"3","Derrick Henry","RB","BLT","2026","7","IND","17.6"\n' +
  '"4","Marquise Brown","WR","KC","2026","7","LV","11.2"\n' +
  '"5","Kenneth Walker","RB","SEA","2026","7","ARI","13.0"\n' +
  '"6","Ravens D/ST","DST","BLT","2026","7","IND","8.0"\n' +
  '"7","Tony Pollard","RB","TEN","2026","7","HST","9.9"\n';

// FanDuel's "Download players list" CSV.
const FD =
  '"Id","Position","First Name","Nickname","Last Name","FPPG","Played","Salary","Game","Team","Opponent","Injury Indicator","Injury Details","Tier","Roster Position"\n' +
  '"1-1","RB","Jahmyr","Jahmyr Gibbs","Gibbs","20.1","6","9000","DET@NO","DET","NO","","","","RB/FLEX"\n' +
  '"1-2","WR","Puka","Puka Nacua","Nacua","18.0","6","8400","SF@LAR","LAR","SF","Q","Ankle","","WR/FLEX"\n' +
  '"1-3","RB","Derrick","Derrick Henry","Henry","17.0","6","8000","IND@BAL","BAL","IND","","","","RB/FLEX"\n' +
  '"1-4","WR","Marquise","Hollywood Brown","Brown","10.0","6","5500","LV@KC","KC","LV","","","","WR/FLEX"\n' +
  '"1-5","RB","Kenneth","Kenneth Walker III","Walker","12.0","6","6800","ARI@SEA","SEA","ARI","","","","RB/FLEX"\n' +
  '"1-6","D","Baltimore","Baltimore Ravens","Ravens","7.0","6","4200","IND@BAL","BAL","IND","","","","D"\n' +
  '"1-7","WR","Tony","Tony Brown","Brown","3.0","6","4500","HOU@TEN","TEN","HOU","","","","WR/FLEX"\n' +
  '"1-8","QB","Lamar","Lamar Jackson","Jackson","24.0","6","9200","IND@BAL","BAL","IND","","","","QB"\n';

test('parseProjections reads the Fantasy Points export, FPTS included', () => {
  const rows = parseProjections(FP);
  assert.equal(rows.length, 7);
  assert.deepEqual(rows[0], { rank: 1, name: 'Jahmyr Gibbs', position: 'RB', team: 'DET', opp: 'NO', fpts: 24.5 });
  // Fantasy Points' own team codes fold into the primary abbreviation.
  assert.equal(rows[2].team, 'BAL');
  assert.equal(rows[5].position, 'DST');
  assert.equal(rows[5].name, 'Baltimore Ravens');
});

test('parseProjections says plainly when there is no projection column', () => {
  assert.throws(() => parseProjections('"RK","NAME","POS"\n"1","Jahmyr Gibbs","RB"\n'), /FPTS/);
  assert.throws(() => parseProjections('  '), /empty/);
});

test('parseSalaries reads FanDuel\'s CSV by its labels, using the lobby nickname', () => {
  const rows = parseSalaries(FD);
  assert.equal(rows.length, 8);
  assert.deepEqual(rows[1], { name: 'Puka Nacua', position: 'WR', team: 'LAR', opp: 'SF', salary: 8400, injury: 'Q' });
  assert.equal(rows[3].name, 'Hollywood Brown');
  assert.equal(rows[5].position, 'DST');
});

test('parseSalaries reads a pasted list, one player per line', () => {
  const rows = parseSalaries('Josh Allen QB BUF $9,200\nBijan Robinson RB ATL $8,800\n1. Puka Nacua WR LAR 8400\n');
  assert.deepEqual(rows.map((r) => [r.name, r.position, r.team, r.salary]), [
    ['Josh Allen', 'QB', 'BUF', 9200],
    ['Bijan Robinson', 'RB', 'ATL', 8800],
    ['Puka Nacua', 'WR', 'LAR', 8400],
  ]);
  assert.throws(() => parseSalaries('no numbers here\n'), /salary/);
});

test('perK is points per $1,000, two decimals', () => {
  assert.equal(perK(24.5, 9000), 2.72);
  assert.equal(perK(10, 0), null);
});

test('build joins projections to salaries and reports both kinds of miss', () => {
  const out = build(FP, FD);
  const by = new Map(out.rows.map((r) => [r.name, r]));
  assert.equal(by.get('Jahmyr Gibbs').salary, 9000);
  assert.equal(by.get('Jahmyr Gibbs').value, 2.72);
  // Team codes differ across sites (LA vs LAR, BLT vs BAL) and still join.
  assert.equal(by.get('Puka Nacua').salary, 8400);
  assert.equal(by.get('Puka Nacua').injury, 'Q');
  // A suffix on one side only is the same player.
  assert.equal(by.get('Kenneth Walker').salary, 6800);
  // FanDuel's lobby nickname resolves through the alias table, and says so.
  assert.equal(by.get('Marquise Brown').salary, 5500);
  assert.equal(by.get('Marquise Brown').fd_name, 'Hollywood Brown');
  // Defenses join on team, not name.
  assert.equal(by.get('Baltimore Ravens').salary, 4200);
  // Tony Pollard is not Tony Brown just because a first name and team agree.
  assert.ok(!by.has('Tony Pollard'));
  assert.deepEqual(out.no_salary.map((r) => r.name), ['Tony Pollard']);
  // On the slate without a projection, most expensive first.
  assert.deepEqual(out.no_projection.map((r) => r.name), ['Lamar Jackson', 'Tony Brown']);
});
