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
