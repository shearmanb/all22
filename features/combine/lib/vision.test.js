// Golden tests for the vision-response parser: the model is told to return a
// bare JSON array, but the extractor must survive fences, prose and junk rows.
const test = require('node:test');
const assert = require('node:assert');
const vision = require('./vision');
const { extractRows, splitDataUrl } = vision;

test('extractRows parses a clean JSON array', () => {
  const rows = extractRows('[{"rank":1,"name":"Ja\'Marr Chase","position":"WR","team":"CIN"}]');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, "Ja'Marr Chase");
  assert.equal(rows[0].position, 'WR');
  assert.equal(rows[0].team, 'CIN');
  assert.equal(rows[0].rank, 1);
});

test('extractRows survives markdown fences and surrounding prose', () => {
  const text = 'Here are the rows:\n```json\n[{"rank":1,"name":"Bijan Robinson","position":"rb","team":"atl"}]\n```\nDone!';
  const rows = extractRows(text);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].position, 'RB');    // upper-cased
  assert.equal(rows[0].team, 'ATL');
});

test('extractRows keeps brackets inside player names intact', () => {
  const rows = extractRows('[{"rank":null,"name":"Odell Beckham [IR]","position":"WR","team":""}]');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].rank, null);
  assert.equal(rows[0].name, 'Odell Beckham [IR]');
});

test('extractRows drops nameless rows and rejects non-arrays', () => {
  const rows = extractRows('[{"rank":2,"name":""},{"rank":3,"name":"Saquon Barkley"}]');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'Saquon Barkley');
  assert.throws(() => extractRows('{"name":"not an array"}'));
  assert.throws(() => extractRows('no json here'));
});

test('extractRows parses auction values and defaults to null', () => {
  const rows = extractRows('[{"rank":1,"name":"Bijan Robinson","position":"RB","team":"ATL","auction_value":"$52"},{"rank":2,"name":"Saquon Barkley","position":"RB","team":"PHI"}]');
  assert.equal(rows[0].auction_value, 52);   // "$" stripped, numeric
  assert.equal(rows[1].auction_value, null);  // absent -> null, never the rank
});

test('splitDataUrl handles data URLs and rejects garbage', () => {
  const { mediaType, base64 } = splitDataUrl('data:image/jpeg;base64,aGVsbG8=');
  assert.equal(mediaType, 'image/jpeg');
  assert.equal(base64, 'aGVsbG8=');
  assert.throws(() => splitDataUrl('not-an-image'));
});

test('parseRows salvages complete rows from a truncated array', () => {
  const out = vision.parseRows('[{"rank":1,"name":"Ja\'Marr Chase","position":"WR","team":"CIN"},{"rank":2,"name":"Bijan Robinson","position":"RB","team":"ATL"},{"rank":3,"name":"Justin Jeff');
  assert.equal(out.truncated, true);
  assert.equal(out.rows.length, 2);
  assert.equal(out.rows[1].name, 'Bijan Robinson');
});

test('parseRows reports complete arrays as not truncated', () => {
  const out = vision.parseRows('[{"rank":1,"name":"Ja\'Marr Chase","position":"WR","team":"CIN"}]');
  assert.equal(out.truncated, false);
  assert.equal(out.rows.length, 1);
});

test('parseRows still throws when nothing complete was returned', () => {
  assert.throws(() => vision.parseRows('[{"rank":1,"name":"Ja'), /Unterminated/);
  assert.throws(() => vision.parseRows('sorry, I cannot read that'), /No JSON array/);
});

test('splitDataUrl normalises the media type', () => {
  assert.equal(vision.splitDataUrl('data:IMAGE/JPG;base64,AAAA').mediaType, 'image/jpeg');
  assert.equal(vision.splitDataUrl('data:image/PNG;base64,AAAA').mediaType, 'image/png');
});
