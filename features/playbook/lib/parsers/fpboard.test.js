// Golden test for the second-screen board-copy parser, using the owner's
// actual paste of his completed 12-team, 17-round mock (204 picks).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const fpboard = require('./fpboard');
const { parse: fpParse } = require('./fantasypros');

const PASTE = fs.readFileSync(path.join(__dirname, 'fixtures', 'fp-board-paste.txt'), 'utf8');

test('detects the board-copy format and routes it from the fantasypros parser', () => {
  assert.ok(fpboard.detect(PASTE));
  const viaDispatch = fpParse(PASTE, {});
  assert.equal(viaDispatch.picks.length, 204);
});

test('parses the full board: every pick, correct snake math, owner column', () => {
  const { picks, unparseable, inferredMySlot, inferredLeagueSize } = fpboard.parse(PASTE, {});
  assert.equal(picks.length, 204); // 17 rounds x 12 teams
  assert.equal(unparseable.length, 0);
  assert.equal(inferredLeagueSize, 12);
  assert.equal(inferredMySlot, 6); // "Your Team" is the 6th column

  assert.deepEqual(
    { name: picks[0].playerName, pos: picks[0].position, team: picks[0].nflTeam, slot: picks[0].draftSlot },
    { name: 'Jahmyr Gibbs', pos: 'RB', team: 'DET', slot: 1 }
  );
  // The owner's first-round pick: 1.06 Christian McCaffrey.
  const cmc = picks.find((p) => p.overallPick === 6);
  assert.equal(cmc.playerName, 'Christian McCaffrey');
  assert.equal(cmc.isMyPick, true);
  // Round 2 runs backwards: 2.07 Chase Brown = overall 19, still his column (slot 6).
  const cb = picks.find((p) => p.overallPick === 19);
  assert.equal(cb.playerName, 'Chase Brown');
  assert.equal(cb.draftSlot, 6);
  assert.equal(cb.isMyPick, true);
  // 2.12 De'Von Achane = overall 24, column 1.
  const achane = picks.find((p) => p.playerName === "De'Von Achane");
  assert.equal(achane.overallPick, 24);
  assert.equal(achane.draftSlot, 1);
  // The owner drafted 17 players, one per round.
  assert.equal(picks.filter((p) => p.isMyPick).length, 17);
  // DST cells (no Headshot suffix) parse with the DST naming convention.
  const dst = picks.find((p) => p.overallPick === (12 - 1) * 12 + 11);
  assert.equal(dst.playerName, 'Denver Broncos DST');
  assert.equal(dst.position, 'DST');
  // Kickers late.
  const k = picks.find((p) => p.playerName === 'Brandon Aubrey');
  assert.equal(k.position, 'K');
  assert.equal(k.round, 16);
});
