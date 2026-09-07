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

test('position disagreement rejects a match even when the full name is the same', () => {
  const r = matchReport(SLATE, [{ name: 'Hunter Henry', position: 'RB' }, { name: 'Hunter Henry' }]);
  // RB "Hunter Henry" is not the TE; a positionless row still matches by name.
  assert.equal(r.matched, 1);
  assert.equal(r.unmatched.length, 1);
  assert.equal(r.unmatched[0].name, 'Hunter Henry');
});

test('parse carries slotName and teamName when present', () => {
  const { rows } = parse(SLATE);
  assert.equal(rows[0].position, 'WR');
  assert.equal(rows[0].team, 'San Francisco 49ers');
});
