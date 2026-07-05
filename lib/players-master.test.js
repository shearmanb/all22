// Tests for the pure part of the players_master service: turning Sleeper's
// raw player object into the de-duped list we upsert.
const test = require('node:test');
const assert = require('node:assert');
const { buildList } = require('./players-master');

test('buildList dedupes same-key players, preferring active skill players', () => {
  const list = buildList({
    a: { full_name: 'Michael Carter', position: 'RB', team: 'ARI', active: true },
    b: { full_name: 'Michael Carter', position: 'CB', team: 'NYJ', active: true },
    c: { first_name: 'Bijan', last_name: 'Robinson', position: 'RB', team: 'ATL', active: true },
    d: { full_name: '', position: 'QB' },            // nameless -> dropped
    e: { full_name: 'Retired Guy', position: 'WR', team: '', active: false },
  });
  const byName = Object.fromEntries(list.map((p) => [p.name, p]));
  assert.equal(list.length, 3);
  assert.equal(byName['Michael Carter'].position, 'RB'); // skill position won
  assert.equal(byName['Bijan Robinson'].team, 'ATL');    // first+last fallback
  assert.equal(byName['Retired Guy'].active, false);
  assert.ok(byName['Bijan Robinson'].key);               // match key present
});

test('buildList maps DEF to DST', () => {
  const list = buildList({
    PHI: { first_name: 'Philadelphia', last_name: 'Eagles', position: 'DEF', team: 'PHI', active: true },
  });
  assert.equal(list[0].position, 'DST');
});
