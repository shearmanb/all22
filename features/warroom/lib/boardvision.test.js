const test = require('node:test');
const assert = require('node:assert');
const { parseCells } = require('./boardvision');

test('parses the cells out of a clean model answer', () => {
  const { cells, truncated } = parseCells(JSON.stringify([
    { round: 1, slot: 1, name: "Ja'Marr Chase", position: 'WR', readable: true },
    { round: 1, slot: 2, name: 'Jahmyr Gibbs', position: 'RB', readable: true },
  ]));
  assert.equal(truncated, false);
  assert.equal(cells.length, 2);
  assert.deepEqual(cells[0], { round: 1, slot: 1, name: "Ja'Marr Chase", position: 'WR', readable: true });
});

test('survives markdown fences and chatter around the array', () => {
  const { cells } = parseCells('Here is the board:\n```json\n[{"round":2,"slot":3,"name":"Puka Nacua"}]\n```\nHope that helps!');
  assert.equal(cells.length, 1);
  assert.equal(cells[0].name, 'Puka Nacua');
});

test('an unreadable cell is kept, not dropped', () => {
  // Dropping it would read downstream as "the app has a pick the board doesn't",
  // which is the wrong alarm entirely.
  const { cells } = parseCells(JSON.stringify([
    { round: 3, slot: 4, name: 'Jah???', readable: false },
    { round: 3, slot: 5, name: '', readable: false },
  ]));
  assert.equal(cells.length, 2);
  assert.equal(cells[0].readable, false);
  assert.equal(cells[1].readable, false);
});

test('a name with no readable flag is taken as readable; a blank name never is', () => {
  const { cells } = parseCells(JSON.stringify([
    { round: 1, slot: 1, name: 'Bijan Robinson' },
    { round: 1, slot: 2, name: '   ' },
  ]));
  assert.equal(cells[0].readable, true);
  assert.equal(cells[1].readable, false);
});

test('a cell with neither a name nor a place tells us nothing and is skipped', () => {
  const { cells } = parseCells(JSON.stringify([
    { round: null, slot: null, name: '', readable: false },
    { round: null, slot: null, name: 'Floating Name' },
    { round: 4, slot: 1, name: '', readable: false },
  ]));
  assert.equal(cells.length, 2);
  assert.equal(cells[0].name, 'Floating Name');
  assert.equal(cells[1].round, 4);
});

test('round and slot are coerced to sane integers or null — never a guess', () => {
  const { cells } = parseCells(JSON.stringify([
    { round: '3', slot: '7', name: 'A' },
    { round: 0, slot: -2, name: 'B' },
    { round: 'unknown', slot: null, name: 'C' },
    { round: 2.9, slot: 4.2, name: 'D' },
  ]));
  assert.deepEqual(cells.map((c) => [c.round, c.slot]), [[3, 7], [null, null], [null, null], [2, 4]]);
});

test('positions are normalised the way the rest of the app spells them', () => {
  const { cells } = parseCells(JSON.stringify([
    { round: 1, slot: 1, name: 'A', position: 'wr' },
    { round: 1, slot: 2, name: 'B', position: 'D/ST' },
    { round: 1, slot: 3, name: 'C', position: 'rb1' },
    { round: 1, slot: 4, name: 'D' },
  ]));
  assert.deepEqual(cells.map((c) => c.position), ['WR', 'DST', 'RB', '']);
});

test('a truncated answer keeps every complete cell and says it was cut', () => {
  const text = '[{"round":1,"slot":1,"name":"Chase"},{"round":1,"slot":2,"name":"Gibbs"},{"round":1,"slot":3,"na';
  const { cells, truncated } = parseCells(text);
  assert.equal(truncated, true);
  assert.equal(cells.length, 2);
});

test('names are copied as written, not corrected', () => {
  const { cells } = parseCells(JSON.stringify([{ round: 1, slot: 1, name: '  Jamar Chace  ' }]));
  assert.equal(cells[0].name, 'Jamar Chace');
});

test('junk entries are ignored rather than throwing the whole read away', () => {
  const { cells } = parseCells('[null, "nope", 42, {"round":1,"slot":1,"name":"Real Player"}]');
  assert.equal(cells.length, 1);
  assert.equal(cells[0].name, 'Real Player');
});

test('no array at all is an error the caller can report', () => {
  assert.throws(() => parseCells('I could not read that photo.'), /No JSON array/);
});

// The seam between the prompt and the parser: if someone edits PROMPT and
// renames a field, or relaxes "skip empty cells", this is what catches it.
// Fixture = what the model returns for a full 6-team, 2-round board where the
// last three squares of round 2 are still empty.
test('a whole board read straight from the prompt lands intact', () => {
  const modelOutput = `[
  {"round": 1, "slot": 1, "name": "Ja'Marr Chase", "position": "", "readable": true},
  {"round": 1, "slot": 2, "name": "Jahmyr Gibbs", "position": "", "readable": true},
  {"round": 1, "slot": 3, "name": "Puka Nacua", "position": "", "readable": true},
  {"round": 1, "slot": 4, "name": "Bijan Robinson", "position": "", "readable": true},
  {"round": 1, "slot": 5, "name": "Jonathan Taylor", "position": "", "readable": true},
  {"round": 1, "slot": 6, "name": "Brock Bowers", "position": "", "readable": true},
  {"round": 2, "slot": 1, "name": "Josh Allen", "position": "", "readable": true},
  {"round": 2, "slot": 2, "name": "James Cook", "position": "", "readable": true},
  {"round": 2, "slot": 3, "name": "Amon-Ra St. Brown", "position": "", "readable": true}
]`;
  const { cells, truncated } = parseCells(modelOutput);
  assert.equal(truncated, false);
  assert.equal(cells.length, 9, 'the three empty squares are absent, not blank cells');
  assert.equal(cells.every((c) => c.readable), true);
  assert.deepEqual(cells[0], { round: 1, slot: 1, name: "Ja'Marr Chase", position: '', readable: true });
  assert.deepEqual(cells[8], { round: 2, slot: 3, name: 'Amon-Ra St. Brown', position: '', readable: true });
  // Every square is placed, so the diff can line all nine up against picks.
  assert.equal(cells.filter((c) => c.round && c.slot).length, 9);
});
