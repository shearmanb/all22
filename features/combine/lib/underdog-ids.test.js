// Tests for the Underdog "rankings with IDs" parse/match/export. Run with: node --test
// The export must preserve Underdog's rows byte-for-byte and only REORDER them.
const test = require('node:test');
const assert = require('node:assert');
const { parse, buildExport, matchReport } = require('./underdog-ids');

const CSV =
  '"id","firstName","lastName","adp"\n' +
  '"u1","Bijan","Robinson","1.2"\n' +
  '"u2","Justin","Jefferson","2.1"\n' +
  '"u3","Marquise","Brown","30.0"';

test('parse reads id + full name from the Underdog columns', () => {
  const { rows, count } = parse(CSV);
  assert.equal(count, 3);
  assert.equal(rows[0].name, 'Bijan Robinson');
  assert.equal(rows[0].id, 'u1');
});

test('parse rejects a non-Underdog CSV with a human-readable error', () => {
  assert.throws(() => parse('"name","rank"\n"Bijan Robinson","1"'), /Underdog/);
});

test('buildExport moves ranked players to the top, keeps the rest in place', () => {
  const { csv, total, matched, unmatched } = buildExport(CSV, [
    { name: 'Justin Jefferson' },
    { name: 'Bijan Robinson' },
  ]);
  assert.equal(total, 3);
  assert.equal(matched, 2);
  assert.equal(unmatched.length, 0);
  const lines = csv.replace(/^﻿/, '').trim().split('\r\n');
  assert.ok(lines[1].includes('Jefferson')); // ranked #1 first
  assert.ok(lines[2].includes('Robinson'));  // ranked #2 next
  assert.ok(lines[3].includes('Brown'));      // unranked stays after, original order
  // Rows are preserved byte-for-byte (IDs intact).
  assert.ok(lines[1].includes('"u2"'));
});

test('matchReport counts matches and flags a miss with a suggestion', () => {
  const r = matchReport(CSV, [{ name: 'Bijan Robinson' }, { name: 'Bijan Robnson' }]);
  // First is an exact match; the misspelling is either fuzzy-matched or flagged.
  assert.ok(r.matched >= 1);
  assert.equal(r.total, 3);
});

// A contest pool is small (a 4-team slate is ~100 players), so a unique last
// name must NOT be enough: the wrong Robinson at the top of an upload is the
// bug this guards against.
const SLATE =
  '"id","playerId","firstName","lastName","slotName","teamName"\n' +
  '"u1","p1","Demarcus","Robinson","WR","San Francisco 49ers"\n' +
  '"u2","p2","Hunter","Henry","TE","New England Patriots"\n' +
  '"u3","p3","A.J.","Brown","WR","New England Patriots"\n' +
  '"u4","p4","Jaxon","Smith-Njigba","WR","Seattle Seahawks"\n' +
  '"u5","p5","Kenneth","Walker III","RB","Seattle Seahawks"';

test('a last-name-only hit on a small slate is rejected, full names still match', () => {
  const { matched, unmatched, csv } = buildExport(SLATE, [
    { name: 'Bijan Robinson', position: 'RB' },     // only Robinson on the slate — NOT him
    { name: 'Derrick Henry', position: 'RB' },      // only Henry — NOT him
    { name: 'Amon-Ra St. Brown', position: 'WR' },  // same position, different first name — NOT him
    { name: 'A.J. Brown', position: 'WR' },         // exact
    { name: 'Jaxson Smith-Njigba', position: 'WR' },// one-letter first-name typo — fine
    { name: 'Ken Walker', position: 'RB' },         // first-name prefix — fine
  ]);
  assert.equal(matched, 3);
  assert.deepEqual(unmatched, ['Bijan Robinson', 'Derrick Henry', 'Amon-Ra St. Brown']);
  const lines = csv.replace(/^﻿/, '').trim().split('\r\n');
  assert.ok(lines[1].includes('"A.J."'));
  assert.ok(lines[2].includes('Smith-Njigba'));
  assert.ok(lines[3].includes('Walker'));
  assert.ok(lines[4].includes('Demarcus')); // unranked, keeps its place after the ranked block
});

test('a full-name match survives a position disagreement, and reports it', () => {
  // Sources routinely file the same player differently (a move tight end listed
  // WR on one site). The name is the identity, so he keeps his slot — but the
  // disagreement is surfaced, never swallowed.
  const r = buildExport(SLATE, [{ name: 'Hunter Henry', position: 'RB' }]);
  assert.equal(r.matched, 1);
  assert.equal(r.unmatched.length, 0);
  assert.deepEqual(r.flagged, [{
    name: 'Hunter Henry', underdog_name: 'Hunter Henry',
    ranked_position: 'RB', underdog_position: 'TE',
  }]);
  // Agreeing (or absent) positions raise no flag.
  assert.equal(buildExport(SLATE, [{ name: 'Hunter Henry', position: 'TE' }]).flagged.length, 0);
  assert.equal(buildExport(SLATE, [{ name: 'Hunter Henry' }]).flagged.length, 0);
});

test('position still gates a last-name-only hit, where identity is not proven', () => {
  // "Derrick Henry" reaches Hunter Henry only through the last name, so the
  // position mismatch is the evidence that they are different people.
  const r = buildExport(SLATE, [{ name: 'Derrick Henry', position: 'RB' }]);
  assert.equal(r.matched, 0);
  assert.deepEqual(r.unmatched, ['Derrick Henry']);
});

test('Underdog\'s nickname resolves to the legal name the rankings use', () => {
  // The alias table maps variant -> canonical; here UNDERDOG prints the
  // nickname, so rows are indexed under both.
  const csv = SLATE + '\n"u6","p6","Hollywood","Brown","WR","Philadelphia Eagles"';
  const r = buildExport(csv, [{ name: 'Marquise Brown', position: 'WR' }]);
  assert.equal(r.matched, 1);
  assert.ok(r.csv.split('\r\n')[1].includes('Hollywood'));
});

test('a short first name that is the TAIL of the long one still matches', () => {
  const csv = SLATE + '\n"u7","p7","Drew","Ogletree","TE","Indianapolis Colts"';
  assert.equal(buildExport(csv, [{ name: 'Andrew Ogletree', position: 'TE' }]).matched, 1);
  // ...but a 3-letter coincidence inside a longer name does not.
  const csv2 = SLATE + '\n"u8","p8","Brian","Thomas","WR","Jacksonville Jaguars"';
  assert.equal(buildExport(csv2, [{ name: 'Ian Thomas', position: 'WR' }]).matched, 0);
});

test('parse carries slotName and teamName when present', () => {
  const { rows } = parse(SLATE);
  assert.equal(rows[0].position, 'WR');
  assert.equal(rows[0].team, 'San Francisco 49ers');
});

test('a miss offers candidates by last name and by position+team, not just spelling', () => {
  const csv = SLATE +
    '\n"u9","p9","Cheetah","Hill","WR","Miami Dolphins"' +
    '\n"u10","p10","Jaylen","Waddle","WR","Miami Dolphins"' +
    '\n"u11","p11","Tua","Tagovailoa","QB","Miami Dolphins"';
  const r = matchReport(csv, [{ name: 'Tyreek Hill', position: 'WR', team: 'MIA' }]);
  const u = r.unmatched[0];
  // A nickname shares the LAST name and nothing else — edit distance never
  // finds it, so the shared last name has to lead.
  assert.equal(u.candidates[0], 'Cheetah Hill');
  // Same position, same team is the next-best evidence; the QB is not offered.
  assert.ok(u.candidates.includes('Jaylen Waddle'));
  assert.ok(!u.candidates.includes('Tua Tagovailoa'));
});

test('a player who is simply absent is offered nothing to pair with', () => {
  const r = matchReport(SLATE, [{ name: 'Some Nobody', position: 'RB', team: 'DEN' }]);
  assert.deepEqual(r.unmatched[0].candidates, []);
  assert.equal(r.unmatched[0].suggestion, null);
});

test('no pairing is offered when the contest has no such team or position', () => {
  // SLATE carries San Francisco, New England and Seattle, and no kickers.
  // A Dallas player cannot be in it under ANY name, so offering him the one
  // same-surname Patriot would invite a wrong alias — permanent, and silently
  // wrong every week after.
  const csv = SLATE + '\n"u12","p12","Kyle","Williams","WR","New England Patriots"';
  const awayTeam = matchReport(csv, [{ name: 'Javonte Williams', position: 'WR', team: 'DAL' }]);
  assert.deepEqual(awayTeam.unmatched[0].candidates, []);
  // Same for a kicker, when the contest lists no kickers at all.
  const kicker = matchReport(csv, [{ name: 'Jake Bates', position: 'K', team: 'SEA' }]);
  assert.deepEqual(kicker.unmatched[0].candidates, []);
  // A player whose team AND position are both in the contest still gets them:
  // the shared surname leads, then the other receivers on that team.
  const here = matchReport(csv, [{ name: 'Javonte Williams', position: 'WR', team: 'NE' }]);
  assert.equal(here.unmatched[0].candidates[0], 'Kyle Williams');
  assert.ok(here.unmatched[0].candidates.includes('A.J. Brown'));
});

test('a team abbreviation from any source resolves to one primary', () => {
  const players = require('../../../lib/players');
  assert.equal(players.primaryTeam('LA'), 'LAR');   // Fantasy Points / older feeds
  assert.equal(players.primaryTeam('BLT'), 'BAL');
  assert.equal(players.primaryTeam('GNB'), 'GB');
  assert.equal(players.primaryTeam('SEA'), 'SEA');
  assert.equal(players.primaryTeam('nope'), '');
});
