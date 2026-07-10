// Golden tests for user-added ADP source parsing/host-detection.
const test = require('node:test');
const assert = require('node:assert');
const { identify, inferFormat, parseFantasyProsAdp, parseMfl } = require('./custom');

test('identify recognizes supported hosts and rejects the rest', () => {
  assert.equal(identify('https://www.fantasypros.com/nfl/adp/ppr-overall.php').adapter, 'fantasypros');
  assert.equal(identify('api.myfantasyleague.com/2026/export?TYPE=adp').adapter, 'mfl');
  assert.equal(identify('https://sports.yahoo.com/fantasy/adp'), null);
  assert.equal(identify('https://fantasypros.com.evil.example.com/x'), null);
  assert.equal(identify('not a url'), null);
});

test('inferFormat reads the format from a FantasyPros ADP URL', () => {
  assert.equal(inferFormat('https://www.fantasypros.com/nfl/adp/half-point-ppr-overall.php'), 'half');
  assert.equal(inferFormat('https://www.fantasypros.com/nfl/adp/ppr-overall.php'), 'ppr');
  assert.equal(inferFormat('https://www.fantasypros.com/nfl/adp/standard-overall.php'), 'standard');
  assert.equal(inferFormat('https://www.fantasypros.com/nfl/adp/superflex.php'), 'superflex');
});

// FantasyPros embeds its data as a JS variable; the exact key varies, so the
// parser hunts for ANY embedded array of {name, adp}-ish objects.
const FP_PAGE = `<html><head><script>
window.foo = {"unrelated": [1,2,3,4,5,6]};
var adpData = {"count": 3, "players": [
  {"player_name":"Ja'Marr Chase","player_team_id":"CIN","player_position_id":"WR","adp":"1.5","player_bye_week":"10"},
  {"player_name":"Bijan Robinson","player_team_id":"ATL","player_position_id":"RB","adp":"2.3","player_bye_week":"5"},
  {"player_name":"CeeDee Lamb","player_team_id":"DAL","player_position_id":"WR","adp":"3.8","player_bye_week":"7"},
  {"player_name":"Saquon Barkley","player_team_id":"PHI","player_position_id":"RB","adp":"4.1","player_bye_week":"9"},
  {"player_name":"Justin Jefferson","player_team_id":"MIN","player_position_id":"WR","adp":"5.0","player_bye_week":"6"},
  {"player_name":"Philadelphia Eagles","player_team_id":"PHI","player_position_id":"DEF","adp":"150","player_bye_week":"9"}
]};
</script></head><body></body></html>`;

test('parseFantasyProsAdp pulls the ADP array out of the embedded JSON', () => {
  const rows = parseFantasyProsAdp(FP_PAGE);
  assert.equal(rows.length, 6);
  assert.equal(rows[0].name, "Ja'Marr Chase");
  assert.equal(rows[0].adp, 1.5);
  assert.equal(rows[0].team, 'CIN');
  assert.equal(rows[0].position, 'WR');
  assert.equal(rows[0].bye, 10);
  assert.equal(rows[5].position, 'DST'); // DEF -> DST
});

test('parseFantasyProsAdp fails loudly when no ADP array is present', () => {
  assert.throws(() => parseFantasyProsAdp('<html>nothing here</html>'), /Could not find ADP/);
});

test('parseMfl normalizes "Last, First" names and pick spread', () => {
  const rows = parseMfl({
    adp: { player: [
      { id: '13593', name: "Chase, Ja'Marr", team: 'CIN', position: 'WR', adp: '1.6', minPick: '1', maxPick: '4', draftsSelectedIn: '500' },
      { id: '0', name: 'Robinson, Bijan', team: 'ATL', position: 'RB', adp: '2.4' },
      { id: '1', name: '', adp: '9' },   // nameless -> dropped
    ] },
  });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].name, "Ja'Marr Chase");
  assert.equal(rows[0].adp, 1.6);
  assert.equal(rows[0].low, 1);
  assert.equal(rows[0].high, 4);
  assert.equal(rows[0].times_drafted, 500);
  assert.equal(rows[1].name, 'Bijan Robinson');
});

test('parseMfl fails loudly on the wrong shape', () => {
  assert.throws(() => parseMfl({ nope: true }), /no ADP player list/);
});
