const test = require('node:test');
const assert = require('node:assert');
const { diffBoard, mergeCells, samePlayer } = require('./boarddiff');

// A cell as boardvision.resolveCells hands it over.
const cell = (round, slot, name, extra) => Object.assign(
  { round, slot, name, position: '', readable: true, player_id: null, matched_name: '', confidence: 'none' },
  extra || {}
);
// A pick as store/router hands it over.
const pick = (id, round, slot, player_name, player_id) =>
  ({ id, round, draft_slot: slot, player_name, player_id: player_id || null });

const verdictAt = (findings, round, slot) =>
  (findings.find((f) => f.round === round && f.slot === slot) || {}).verdict;

test('board and app agreeing is ok — by id and by name', () => {
  const cells = [
    cell(1, 1, 'Jahmyr Gibbs', { player_id: 900001, confidence: 'high' }),
    cell(1, 2, 'Bijan Robinson'),                       // no id on either side
  ];
  const picks = [pick(1, 1, 1, 'Jahmyr Gibbs', 900001), pick(2, 1, 2, 'Bijan Robinson')];
  const { findings, summary } = diffBoard(cells, picks);
  assert.equal(summary.ok, 2);
  assert.equal(summary.problems, 0);
  assert.deepEqual(findings.map((f) => f.verdict), ['ok', 'ok']);
});

test('name spelling differences still count as agreement', () => {
  // The registry name and the sticker rarely match character for character.
  const cells = [cell(1, 1, "Ja'Marr Chase"), cell(1, 2, 'Amon Ra St Brown')];
  const picks = [pick(1, 1, 1, 'JaMarr Chase'), pick(2, 1, 2, 'Amon-Ra St. Brown')];
  assert.equal(diffBoard(cells, picks).summary.ok, 2);
});

test('a different player in the same square is a mismatch', () => {
  const cells = [cell(2, 5, 'Puka Nacua', { player_id: 900004, confidence: 'high' })];
  const picks = [pick(9, 2, 5, 'Jonathan Taylor', 900006)];
  const { findings, summary } = diffBoard(cells, picks);
  assert.equal(summary.mismatch, 1);
  assert.equal(summary.problems, 1);
  assert.equal(findings[0].board_name, 'Puka Nacua');
  assert.equal(findings[0].app_name, 'Jonathan Taylor');
  assert.equal(findings[0].pick_id, 9, 'carries the pick to fix');
});

test('ids win over names: same name, different players is still a mismatch', () => {
  const cells = [cell(3, 4, 'Michael Carter', { player_id: 111, confidence: 'high' })];
  const picks = [pick(4, 3, 4, 'Michael Carter', 222)];
  assert.equal(diffBoard(cells, picks).summary.mismatch, 1);
});

test('a sticker with no recorded pick is missing_from_app', () => {
  const { findings, summary } = diffBoard([cell(1, 7, 'James Cook')], []);
  assert.equal(summary.missing_from_app, 1);
  assert.equal(summary.problems, 1);
  assert.equal(findings[0].board_name, 'James Cook');
});

test('a recorded pick the photos never showed is missing_from_board, not a problem', () => {
  // The owner photographed rounds 1-2; round 5 simply is not in frame.
  const { findings, summary } = diffBoard([cell(1, 1, 'Jahmyr Gibbs')], [
    pick(1, 1, 1, 'Jahmyr Gibbs'),
    pick(2, 5, 3, 'Somebody Else'),
  ]);
  assert.equal(summary.ok, 1);
  assert.equal(summary.missing_from_board, 1);
  assert.equal(summary.problems, 0, 'not photographed is not the same as wrong');
  assert.equal(verdictAt(findings, 5, 3), 'missing_from_board');
});

test('an unreadable cell is reported, never dropped and never a mismatch', () => {
  const cells = [cell(2, 2, 'Jah???', { readable: false })];
  const { findings, summary } = diffBoard(cells, [pick(1, 2, 2, 'Jahmyr Gibbs')]);
  assert.equal(summary.unreadable, 1);
  assert.equal(summary.mismatch, 0);
  assert.equal(summary.problems, 0);
  assert.equal(findings[0].app_name, 'Jahmyr Gibbs', 'shows what the app has for that square');
});

test('a cell whose square could not be worked out is reported as unplaced', () => {
  const { findings, summary } = diffBoard([cell(null, null, 'Puka Nacua')], []);
  assert.equal(summary.unplaced, 1);
  assert.equal(findings[0].verdict, 'unplaced');
});

test('multi-photo: a readable cell beats an unreadable one for the same square', () => {
  const cells = [
    cell(1, 1, '', { readable: false }),          // blurry first shot
    cell(1, 1, 'Jahmyr Gibbs'),                   // clear second shot
  ];
  const { summary } = diffBoard(cells, [pick(1, 1, 1, 'Jahmyr Gibbs')]);
  assert.equal(summary.ok, 1);
  assert.equal(summary.unreadable, 0);
});

test('multi-photo: a later blurry shot never undoes an earlier clear read', () => {
  const cells = [cell(1, 1, 'Jahmyr Gibbs'), cell(1, 1, '', { readable: false })];
  assert.equal(diffBoard(cells, [pick(1, 1, 1, 'Jahmyr Gibbs')]).summary.ok, 1);
});

test('multi-photo: two clear photos disagreeing about one square is flagged', () => {
  const cells = [cell(1, 1, 'Jahmyr Gibbs'), cell(1, 1, 'Bijan Robinson')];
  const { findings } = diffBoard(cells, [pick(1, 1, 1, 'Jahmyr Gibbs')]);
  assert.equal(findings[0].verdict, 'ok', 'the first read still decides');
  assert.equal(findings[0].photo_conflict, 'Bijan Robinson', 'but the disagreement is surfaced');
});

test('findings come back in board order, unplaced last', () => {
  const cells = [cell(2, 1, 'B'), cell(null, null, 'Floating'), cell(1, 3, 'A')];
  const { findings } = diffBoard(cells, []);
  assert.deepEqual(findings.map((f) => f.board_name), ['A', 'B', 'Floating']);
});

test('summary counts the board and the app, so partial coverage is visible', () => {
  const { summary } = diffBoard([cell(1, 1, 'A'), cell(1, 2, 'B')], [
    pick(1, 1, 1, 'A'), pick(2, 1, 2, 'B'), pick(3, 4, 4, 'C'),
  ]);
  assert.equal(summary.cells_seen, 2);
  assert.equal(summary.picks_recorded, 3);
});

test('an empty check is clean, not an error', () => {
  const { findings, summary } = diffBoard([], []);
  assert.deepEqual(findings, []);
  assert.equal(summary.problems, 0);
  assert.equal(summary.cells_seen, 0);
});

test('samePlayer: ids decide when both have them, names otherwise', () => {
  assert.equal(samePlayer({ player_id: 1 }, { player_id: 1 }), true);
  assert.equal(samePlayer({ player_id: 1 }, { player_id: 2 }), false);
  assert.equal(samePlayer({ name: 'Bijan Robinson' }, { name: 'bijan  robinson' }), true);
  assert.equal(samePlayer({ name: '' }, { name: '' }), false, 'two blanks are not a match');
});

test('mergeCells separates placed cells from unplaced ones', () => {
  const { placed, unplaced } = mergeCells([cell(1, 1, 'A'), cell(null, 2, 'B'), cell(3, null, 'C')]);
  assert.equal(placed.size, 1);
  assert.equal(unplaced.length, 2);
});
