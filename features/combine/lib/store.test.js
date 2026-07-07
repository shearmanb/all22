// Tests for store.js's pure helpers (the DB paths need Postgres and are
// exercised in production via /health + the golden ingest tests upstream).
const test = require('node:test');
const assert = require('node:assert');
const store = require('./store');

test('withPositionRanks numbers players within their position, in list order', () => {
  const rows = [
    { rank: 1, position: 'QB' },
    { rank: 2, position: 'QB' },
    { rank: 3, position: 'WR' },
    { rank: 4, position: 'QB' },
    { rank: 5, position: '' }, // unmatched, position unknown yet
    { rank: 6, position: 'WR' },
  ];
  store.withPositionRanks(rows);
  assert.deepEqual(rows.map((r) => r.position_rank), [1, 2, 1, 3, null, 2]);
});

test('withPositionRanks on a positional paste (QB block then WR block) restarts per position', () => {
  const rows = [
    { rank: 1, position: 'QB' },
    { rank: 2, position: 'QB' },
    { rank: 3, position: 'WR' },
    { rank: 4, position: 'WR' },
    { rank: 5, position: 'WR' },
  ];
  store.withPositionRanks(rows);
  assert.deepEqual(rows.map((r) => r.position_rank), [1, 2, 1, 2, 3]);
});

test('cleanScope accepts only known scopes and defaults to overall', () => {
  assert.equal(store.cleanScope('positional'), 'positional');
  assert.equal(store.cleanScope('  OVERALL '), 'overall');
  assert.equal(store.cleanScope('nonsense'), 'overall');
  assert.equal(store.cleanScope(undefined), 'overall');
});
