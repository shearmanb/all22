// Golden tests for the canonical name engine. Run with: node --test
// These pin the behavior the whole app relies on (clean/key/display, team-defense
// detection, and the fuzzy matcher + its confidence), so we can sharpen matching
// without silently breaking a name that already worked.
const test = require('node:test');
const assert = require('node:assert');
const players = require('./players');
const aliases = require('./aliases');

test('clean strips suffixes and periods, collapses spaces', () => {
  assert.equal(players.clean("Ja'Marr Chase Jr."), "Ja'Marr Chase");
  assert.equal(players.clean('A.J. Brown'), 'AJ Brown');
  assert.equal(players.clean('  Patrick   Mahomes  II '), 'Patrick Mahomes');
});

test('key normalizes punctuation, hyphens and suffixes to a match form', () => {
  assert.equal(players.key('A.J. Brown'), 'aj brown');
  assert.equal(players.key('Amon-Ra St. Brown'), 'amon ra st brown');
  assert.equal(players.key('Odell Beckham Jr.'), 'odell beckham');
  // Same player, three spellings -> one key.
  const k = players.key('DK Metcalf');
  assert.equal(players.key('D.K. Metcalf'), k);
  assert.equal(players.key('d.k. metcalf'), k);
});

test('display title-cases shouting OCR and drops a leading rank', () => {
  assert.equal(players.display('BIJAN ROBINSON'), 'Bijan Robinson');
  assert.equal(players.display('12. Justin Jefferson'), 'Justin Jefferson');
  assert.equal(players.display('Patrick Mahomes Ill'), 'Patrick Mahomes III'); // OCR I/l fix
});

test('teamDefenseFromLine recognizes a defense, rejects a real player', () => {
  assert.equal(players.teamDefenseFromLine('Philadelphia Eagles'), 'PHI');
  assert.equal(players.teamDefenseFromLine('49ers'), 'SF');
  assert.equal(players.teamDefenseFromLine('Cowboys DST'), 'DAL');
  assert.equal(players.teamDefenseFromLine('Bijan Robinson'), ''); // a player, not a defense
});

function rosterIndex(extraAliases) {
  return players.buildNameIndex([
    { name: 'Bijan Robinson', position: 'RB', team: 'ATL' },
    { name: 'Justin Jefferson', position: 'WR', team: 'MIN' },
    { name: 'AJ Brown', position: 'WR', team: 'PHI' },
    { name: 'Marquise Brown', position: 'WR', team: 'KC' },
  ], { aliases: extraAliases });
}

test('matchName: exact and punctuation-insensitive hits are high confidence', () => {
  const idx = rosterIndex();
  let m = players.matchName('Bijan Robinson', idx);
  assert.equal(m.entry.name, 'Bijan Robinson');
  assert.equal(m.confidence, 'high');
  assert.equal(m.via, 'exact');

  m = players.matchName('A.J. Brown', idx); // periods removed -> 'aj brown'
  assert.equal(m.entry.name, 'AJ Brown');
  assert.equal(m.confidence, 'high');
});

test('matchName: a one-letter OCR slip on the last name is a low-confidence hit', () => {
  const idx = rosterIndex();
  const m = players.matchName('Bijan Robnson', idx); // missing an 'i'
  assert.equal(m.entry.name, 'Bijan Robinson');
  assert.equal(m.confidence, 'low');
  assert.equal(m.via, 'lastname-fuzzy');
});

test('matchName: unknown name returns no entry', () => {
  const idx = rosterIndex();
  const m = players.matchName('Zxqv Nobodyman', idx);
  assert.equal(m.entry, null);
  assert.equal(m.confidence, 'none');
});

test('alias resolves a true nickname the fuzzy matcher cannot', () => {
  // Different first name on a common last name ("Brown") — only an alias fixes this.
  const idx = rosterIndex(aliases.buildMap({ t: { 'Hollywood Brown': 'Marquise Brown' } }));
  const m = players.matchName('Hollywood Brown', idx);
  assert.equal(m.entry.name, 'Marquise Brown');
  assert.equal(m.via, 'alias');
  assert.equal(m.confidence, 'high');
});

test('findName stays a thin entry-or-null wrapper (back-compat)', () => {
  const idx = rosterIndex();
  assert.equal(players.findName('Justin Jefferson', idx).team, 'MIN');
  assert.equal(players.findName('Nobody Here', idx), null);
});
