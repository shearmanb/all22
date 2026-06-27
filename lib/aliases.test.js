// Tests for the alias module: the curated map, loose key matching, and learning.
// Run with: node --test
const test = require('node:test');
const assert = require('node:assert');
const players = require('./players');
const aliases = require('./aliases');

test('the seed map exposes a known league-wide nickname', () => {
  assert.equal(aliases.MAP.get(players.key('Hollywood Brown')), 'Marquise Brown');
});

test('buildMap keys loosely (case / punctuation insensitive)', () => {
  const map = aliases.buildMap({ s: { 'Pop  DOUGLAS': 'Demario Douglas' } });
  assert.equal(map.get(players.key('pop douglas')), 'Demario Douglas');
});

test('addLearned merges runtime aliases into the shared map by reference', () => {
  // An index built BEFORE the learned alias is added must still see it, because the
  // index holds the map by reference — this is what makes "remember this" work.
  // The variant shares no last name with the roster, so it is unresolvable until
  // the alias is taught (a shared last name would resolve via fuzzy matching).
  const idx = players.buildNameIndex(
    [{ name: 'Derrick Henry', team: 'BAL' }, { name: 'Marquise Brown', team: 'KC' }],
    { aliases: aliases.MAP }
  );
  assert.equal(players.findName('Hollywood Wagon', idx), null); // not known yet
  aliases.addLearned([{ alias: 'Hollywood Wagon', canonical: 'Derrick Henry' }]);
  const m = players.matchName('Hollywood Wagon', idx);
  assert.equal(m.entry.team, 'BAL');
  assert.equal(m.via, 'alias');
});
