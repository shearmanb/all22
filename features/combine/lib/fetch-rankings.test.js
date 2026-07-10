// Golden tests for the FantasyPros URL fetcher's pure parts.
const test = require('node:test');
const assert = require('node:assert');
const { parseTarget, inferMeta, extractEcrData, rowsFromEcr } = require('./fetch-rankings');

test('parseTarget accepts fantasypros rankings URLs and rejects everything else', () => {
  assert.ok(parseTarget('https://www.fantasypros.com/nfl/rankings/ppr-cheatsheets.php'));
  assert.ok(parseTarget('www.fantasypros.com/nfl/rankings/qb-cheatsheets.php'));
  assert.equal(parseTarget('https://evil.example.com/nfl/rankings/ppr-cheatsheets.php'), null);
  assert.equal(parseTarget('https://fantasypros.com.evil.example.com/x.php'), null);
  assert.equal(parseTarget('not a url at all'), null);
});

test('inferMeta reads format and scope from the URL', () => {
  const half = inferMeta('https://www.fantasypros.com/nfl/rankings/half-point-ppr-cheatsheets.php');
  assert.equal(half.format, 'half');
  assert.equal(half.scope, 'overall');
  const ppr = inferMeta('https://www.fantasypros.com/nfl/rankings/ppr-cheatsheets.php');
  assert.equal(ppr.format, 'ppr');
  const std = inferMeta('https://www.fantasypros.com/nfl/rankings/consensus-cheatsheets.php');
  assert.equal(std.format, 'standard');
  const sf = inferMeta('https://www.fantasypros.com/nfl/rankings/ppr-superflex-cheatsheets.php');
  assert.equal(sf.format, 'superflex');
  const bb = inferMeta('https://www.fantasypros.com/nfl/rankings/best-ball-overall.php');
  assert.equal(bb.format, 'best_ball');
  assert.equal(bb.scope, 'overall');
  const qb = inferMeta('https://www.fantasypros.com/nfl/rankings/qb-cheatsheets.php');
  assert.equal(qb.scope, 'positional');
  const pprRb = inferMeta('https://www.fantasypros.com/nfl/rankings/ppr-rb-cheatsheets.php');
  assert.equal(pprRb.format, 'ppr');
  assert.equal(pprRb.scope, 'positional');
});

const SAMPLE_PAGE = `
<html><head><script>
var some = {"other": true};
var ecrData = {"sport":"NFL","type":"DK","ranking_type_name":"draft","year":"2026",
  "scoring":"PPR","total_experts":22,"last_updated":"07/09",
  "players":[
    {"player_id":15528,"player_name":"Michael \\"Mike\\" Thomas","player_team_id":"NO","player_position_id":"WR","rank_ecr":2,"rank_min":"1","rank_max":"6","rank_ave":"1.37","rank_std":"0.91","pos_rank":"WR1","tier":1},
    {"player_id":2434,"player_name":"Christian McCaffrey","player_team_id":"SF","player_position_id":"RB","rank_ecr":1,"tier":1},
    {"player_id":9001,"player_name":"Denver Broncos","player_team_id":"DEN","player_position_id":"DEF","rank_ecr":140}
  ]};
var sosData = {"whatever": []};
</script></head><body></body></html>`;

test('extractEcrData finds the embedded payload with a balanced-brace scan', () => {
  const data = extractEcrData(SAMPLE_PAGE);
  assert.ok(data);
  assert.equal(data.players.length, 3);
  assert.equal(data.scoring, 'PPR');
  assert.equal(extractEcrData('<html>no data here</html>'), null);
});

test('rowsFromEcr orders by rank_ecr and normalizes position/team', () => {
  const rows = rowsFromEcr(extractEcrData(SAMPLE_PAGE));
  assert.equal(rows[0].name, 'Christian McCaffrey');
  assert.equal(rows[0].position, 'RB');
  assert.equal(rows[0].team, 'SF');
  assert.equal(rows[1].name, 'Michael "Mike" Thomas'); // escaped quotes survive
  assert.equal(rows[2].position, 'DST'); // DEF -> DST
});
