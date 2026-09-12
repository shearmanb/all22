// Tests for the stateless Underdog quick upload. Run with: node --test
const test = require('node:test');
const assert = require('node:assert');
const { parseRankings, build } = require('./underdog-quick');

const UD =
  '"id","playerId","firstName","lastName","adp","slotName","teamName"\n' +
  '"u1","p1","Jahmyr","Gibbs","1.0","RB","Detroit Lions"\n' +
  '"u2","p2","Bijan","Robinson","2.1","RB","Atlanta Falcons"\n' +
  '"u3","p3","Ja\'Marr","Chase","3.0","WR","Cincinnati Bengals"\n' +
  '"u4","p4","Demarcus","Robinson","200.0","WR","San Francisco 49ers"\n' +
  '"u5","p5","Patrick","Mahomes","40.0","QB","Kansas City Chiefs"';

test('parseRankings reads a Fantasy Points export, whose header is TWO rows', () => {
  // Row 1 is a merged-cell group header: "Player Details" spans the name /
  // position / team block and matches the name-column regex, while the column
  // beneath it holds positions. Picking that row yields a list of "RB", "WR"
  // and nothing matches — the bug this guards against.
  const rows = parseRankings(
    '"","","Player Details","","","","","Projection"\n' +
    '"#","NAME","POS","POS","SEASON","WEEK","OPP","FPTS"\n' +
    '"1","Jahmyr Gibbs","RB","DET","2026","1","NO","24.5"\n' +
    '"2","Puka Nacua","WR","LA","2026","1","SF","21.0"\n' +
    '"3","Derrick Henry","RB","BLT","2026","1","IND","17.6"\n'
  );
  assert.deepEqual(rows.map((r) => [r.rank, r.name, r.position, r.team]), [
    [1, 'Jahmyr Gibbs', 'RB', 'DET'],
    // The team column is unlabelled ("POS" twice), so it is recovered from the
    // data — taking the team, not the identical-looking OPP column beside it.
    // Fantasy Points' own abbreviations are recognized as teams.
    [2, 'Puka Nacua', 'WR', 'LA'],
    [3, 'Derrick Henry', 'RB', 'BLT'],
  ]);
});

test('parseRankings reads a FantasyPros-style CSV (RK / PLAYER NAME / POS with rank)', () => {
  const rows = parseRankings(
    '"RK","TIERS","PLAYER NAME","TEAM","POS","OPP"\n' +
    '"2","1","Ja\'Marr Chase","CIN","WR1","vs CLE"\n' +
    '"1","1","Jahmyr Gibbs","DET","RB1","@ GB"\n'
  );
  // Sorted by the published rank, position stripped of its ordinal.
  assert.deepEqual(rows.map((r) => [r.rank, r.name, r.position, r.team]), [
    [1, 'Jahmyr Gibbs', 'RB', 'DET'],
    [2, "Ja'Marr Chase", 'WR', 'CIN'],
  ]);
});

test('parseRankings reads Scott Barrett\'s sheet and a bare pasted list', () => {
  const scott = parseRankings('"OVERALL","NAME","Position","Team","BYE","$$$"\n"1","Jahmyr Gibbs","RB","DET","6","$60"\n"2","Bijan Robinson","RB","ATL","11","$59"\n');
  assert.deepEqual(scott.map((r) => r.name), ['Jahmyr Gibbs', 'Bijan Robinson']);
  const pasted = parseRankings('1. Jahmyr Gibbs RB DET\n2. Bijan Robinson RB ATL\n');
  assert.deepEqual(pasted.map((r) => [r.rank, r.name, r.position]), [[1, 'Jahmyr Gibbs', 'RB'], [2, 'Bijan Robinson', 'RB']]);
});

test('parseRankings rejects an empty or name-less file loudly', () => {
  assert.throws(() => parseRankings('   '), /empty/);
  assert.throws(() => parseRankings('1,2\n3,4\n'), /player-name column/);
});

test('build reorders Underdog\'s file to the rankings and reports every miss', () => {
  const r = build(UD,
    '"RK","PLAYER NAME","TEAM","POS"\n' +
    '"1","Bijan Robinson","ATL","RB1"\n' +
    '"2","Jahmyr Gibbs","DET","RB2"\n' +
    '"3","Patrick Mahomes II","KC","QB1"\n' +
    '"4","Wan\'Dale Robinson","NYG","WR20"\n' +   // only a wrong-first-name Robinson exists
    '"5","Detroit Lions","DET","DST1"\n'          // no defenses on Underdog
  );
  assert.equal(r.total, 5);
  assert.equal(r.ranked, 5);
  assert.equal(r.matched, 3);
  assert.deepEqual(r.unmatched.map((u) => u.name), ["Wan'Dale Robinson", 'Detroit Lions']);
  const lines = r.csv.replace(/^﻿/, '').trim().split('\r\n');
  assert.ok(lines[1].includes('"Bijan"'));
  assert.ok(lines[2].includes('"Gibbs"'));
  assert.ok(lines[3].includes('"Mahomes"'));
  assert.ok(lines[4].includes('"Chase"'));      // unranked keep Underdog's order after
  assert.ok(lines[5].includes('"Demarcus"'));
  assert.equal(lines.length, 6);                 // header + every Underdog row, none lost
});
