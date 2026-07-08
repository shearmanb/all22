// Tests for the Draft Wizard URL import. FantasyPros doesn't document these
// pages, so the extractor is shape-agnostic — these tests feed it several
// plausible payload shapes (clean JSON, JSON embedded in HTML, ordered lists
// without pick numbers) plus an end-to-end fetch against a local fixture
// server that mimics "page references a data endpoint".
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fpw = require('./fpwizard');

const OWNER_URL = 'https://draftwizard.fantasypros.com/d/secondscreen.jsp?mockDraftKey=nfl%7E09cd1de8-94cf-428b-b268-b5c14c670777';

test('parseTarget: real second-screen URL, bare key, junk', () => {
  const t = fpw.parseTarget(OWNER_URL);
  assert.ok(t);
  assert.equal(t.key, 'nfl~09cd1de8-94cf-428b-b268-b5c14c670777');
  const bare = fpw.parseTarget('nfl~09cd1de8-94cf-428b-b268-b5c14c670777');
  // ~ is an unreserved character, so it survives encodeURIComponent as-is.
  assert.ok(bare.url.includes('mockDraftKey=nfl~09cd1de8'));
  assert.equal(fpw.parseTarget('https://evil.example.com/?mockDraftKey=nfl~x'), null);
  assert.equal(fpw.parseTarget('not a url at all'), null);
});

function mkPicks(n, shape) {
  const names = ['Bijan Robinson', 'Justin Jefferson', 'Jahmyr Gibbs', 'CeeDee Lamb',
    'Josh Allen', 'Derrick Henry', 'Nico Collins', 'Trey McBride',
    'Saquon Barkley', 'Puka Nacua', 'Lamar Jackson', 'Malik Nabers'];
  const pos = ['RB', 'WR', 'RB', 'WR', 'QB', 'RB', 'WR', 'TE', 'RB', 'WR', 'QB', 'WR'];
  const teams = ['ATL', 'MIN', 'DET', 'DAL', 'BUF', 'BAL', 'HOU', 'ARI', 'PHI', 'LAR', 'BAL', 'NYG'];
  return Array.from({ length: n }, (_, i) => shape(names[i % 12], pos[i % 12], teams[i % 12], i + 1));
}

test('extractDraft: whole-body JSON with nested player objects and a team count', () => {
  const body = JSON.stringify({
    status: 'COMPLETE',
    draft: {
      num_teams: 10,
      picks: mkPicks(20, (name, position, team, i) => ({
        pick: i, player: { name, position, team }, is_user: i === 3,
      })),
    },
  });
  const found = fpw.extractDraft(body);
  assert.ok(found);
  assert.equal(found.picks.length, 20);
  assert.equal(found.teamsLen, 10);
  assert.equal(found.picks[0].name, 'Bijan Robinson');
  assert.equal(found.picks[0].position, 'RB');
  assert.equal(found.picks[0].team, 'ATL');
  // is_user was set on pick 3 (1-based) = array index 2; everyone else unset.
  assert.equal(found.picks[2].mine, true);
  assert.equal(found.picks[3].mine, undefined);
  assert.equal(found.picks.filter((p) => p.mine === true).length, 1);
});

test('extractDraft: JSON embedded in an HTML page (script var)', () => {
  const data = {
    mockDraft: {
      teams: [{ name: 'Team 1' }, { name: 'Team 2' }, { name: 'Team 3' }, { name: 'Team 4' },
              { name: 'Team 5' }, { name: 'Team 6' }, { name: 'Team 7' }, { name: 'Team 8' }],
      picks: mkPicks(16, (name, position, team, i) => ({
        overall_pick: i, round: Math.ceil(i / 8), player_name: name, player_position: position, nfl_team: team,
      })),
    },
  };
  const html = '<!doctype html><html><head><script>window.__DATA__ = ' + JSON.stringify(data) +
    ';</script></head><body><div id="board"></div></body></html>';
  const found = fpw.extractDraft(html);
  assert.ok(found);
  assert.equal(found.picks.length, 16);
  assert.equal(found.teamsLen, 8); // team list length, not the pick array
  assert.equal(found.picks[4].name, 'Josh Allen');
  assert.equal(found.picks[4].position, 'QB');
});

test('extractDraft: ordered player list without pick numbers still works', () => {
  const body = JSON.stringify({ results: mkPicks(12, (name, position, team) => ({ name, pos: position, team })) });
  const found = fpw.extractDraft(body);
  assert.ok(found);
  assert.equal(found.picks.length, 12);
  assert.equal(found.picks[0].overall, null); // no numbers in the data
});

test('extractDraft: a plain page with no draft data returns null', () => {
  assert.equal(fpw.extractDraft('<html><body><h1>Draft Wizard</h1><p>Loading…</p></body></html>'), null);
  assert.equal(fpw.extractDraft(''), null);
});

test('toPlaybookPicks: snake math, DST naming, my-slot fallback', () => {
  const raw = [
    { name: 'Bijan Robinson', position: 'RB', team: 'ATL', overall: 1, round: null, slot: null, mine: undefined, hasPickInfo: true },
    { name: 'Philadelphia Eagles', position: 'DST', team: 'PHI', overall: 13, round: null, slot: null, mine: undefined, hasPickInfo: true },
  ];
  const { picks } = fpw.toPlaybookPicks(raw, { leagueSize: 12, mySlot: 12 });
  assert.equal(picks[0].round, 1);
  assert.equal(picks[0].draftSlot, 1);
  assert.equal(picks[0].isMyPick, false);
  // Pick 13 in a 12-team snake = round 2, first off the board = slot 12.
  assert.equal(picks[1].round, 2);
  assert.equal(picks[1].draftSlot, 12);
  assert.equal(picks[1].isMyPick, true);
  assert.ok(/DST$/.test(picks[1].playerName));
});

test('toPlaybookPicks: trusts is_user flags and reads the slot off round 1', () => {
  const raw = mkPicks(24, (name, position, team, i) => ({
    name, position, team, overall: i, round: null, slot: null,
    mine: i === 5 || i === 20 ? true : undefined, hasPickInfo: true,
  }));
  const { picks, inferredMySlot } = fpw.toPlaybookPicks(raw, { leagueSize: 12, mySlot: null });
  assert.equal(inferredMySlot, 5);
  assert.deepEqual(picks.filter((p) => p.isMyPick).map((p) => p.overallPick), [5, 20]);
});

test('discoverUrls: same-site data URLs only, key injected when missing', () => {
  const html = `
    <script src="/static/app.js"></script>
    <script>fetch("/ajax/secondscreen/data.jsp?mockDraftKey=nfl~abc")</script>
    <script>const u = "https://draftwizard.fantasypros.com/ajax/other.json";</script>
    <script>bad("https://evil.example.com/ajax/steal?mockDraftKey=nfl~abc")</script>
  `;
  const urls = fpw.discoverUrls(html, 'https://draftwizard.fantasypros.com/d/secondscreen.jsp', 'nfl~abc', false);
  assert.ok(urls.some((u) => u.includes('/ajax/secondscreen/data.jsp')));
  assert.ok(urls.some((u) => u.includes('/ajax/other.json')));
  assert.ok(!urls.some((u) => u.includes('evil.example.com')));
  assert.ok(!urls.some((u) => u.endsWith('app.js')));
});

test('fetchDraft end-to-end: page references a data endpoint that has the picks', async () => {
  const data = {
    num_teams: 12,
    picks: mkPicks(24, (name, position, team, i) => ({ pick: i, player: { name, position, team } })),
  };
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/d/secondscreen.jsp')) {
      res.setHeader('Content-Type', 'text/html');
      res.end('<html><script>load("/ajax/mock_draft/data.json?x=1")</script><body>Loading…</body></html>');
    } else if (req.url.startsWith('/ajax/mock_draft/data.json')) {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(data));
    } else {
      res.statusCode = 404;
      res.end('nope');
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  try {
    const result = await fpw.fetchDraft(
      { url: base + '/d/secondscreen.jsp?mockDraftKey=nfl~test', key: 'nfl~test' },
      { allowAnyHost: true, leagueSize: 12, mySlot: 3 }
    );
    assert.equal(result.picks.length, 24);
    assert.equal(result.inferredLeagueSize, 12);
    assert.equal(result.picks[0].playerName, 'Bijan Robinson');
    assert.equal(result.picks[12].round, 2);
    // mySlot 3 in a snake: picks 3 and 22 are mine
    assert.deepEqual(result.picks.filter((p) => p.isMyPick).map((p) => p.overallPick), [3, 22]);
    assert.ok(result.tried.length >= 2); // page first, then the discovered endpoint
  } finally {
    server.close();
  }
});

test('extractDraft: JS object literal (unquoted keys, single quotes) in a JSP page', () => {
  const rows = mkPicks(14, (name, position, team, i) =>
    `{pick: ${i}, name: '${name}', pos: '${position}', team: '${team}'}`).join(', ');
  const html = '<html><script>var draftData = {numTeams: 14, picks: [' + rows + ']};</script></html>';
  const found = fpw.extractDraft(html);
  assert.ok(found, 'relaxed JSON should be repaired and parsed');
  assert.equal(found.picks.length, 14);
  assert.equal(found.teamsLen, 14);
  assert.equal(found.picks[0].name, 'Bijan Robinson');
  assert.equal(found.picks[0].position, 'RB');
});

test('fetchDraft: discovered endpoint gets keyed variants when the key is missing', async () => {
  const data = { picks: mkPicks(16, (name, position, team, i) => ({ pick: i, name, position, team })) };
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (req.url.startsWith('/d/secondscreen.jsp')) {
      res.setHeader('Content-Type', 'text/html');
      res.end('<html><script>poll("/ajax/draft/status.json")</script></html>');
    } else if (u.pathname === '/ajax/draft/status.json' && u.searchParams.get('mockDraftKey') === 'nfl~kv') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(data)); // only answers WITH the key
    } else if (u.pathname === '/ajax/draft/status.json') {
      res.end('{"error": "missing key"}');
    } else { res.statusCode = 404; res.end('nope'); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  try {
    const result = await fpw.fetchDraft(
      { url: base + '/d/secondscreen.jsp?mockDraftKey=nfl~kv', key: 'nfl~kv' },
      { allowAnyHost: true, leagueSize: 8, mySlot: 1 }
    );
    assert.equal(result.picks.length, 16);
    assert.ok(result.captures.length >= 2, 'captures record what each URL sent');
  } finally {
    server.close();
  }
});

// ---- Real-world fixture: the owner's actual second-screen page, captured via
// the diagnostic download. The picks are NOT in this HTML (Vue SPA) — but the
// config block carries the key, league size, roster and the owner's seat.
const fs = require('node:fs');
const path = require('node:path');
const REAL_PAGE = fs.readFileSync(path.join(__dirname, 'fixtures', 'fp-secondscreen.html'), 'utf8');

test('real second-screen page: config is mined (key, teams, seat, roster)', () => {
  const cfg = fpw.mineConfig(REAL_PAGE);
  assert.equal(cfg.key, 'nfl~09cd1de8-94cf-428b-b268-b5c14c670777');
  assert.equal(cfg.teamCount, 12);
  assert.equal(cfg.userPos, 5);
  assert.ok(cfg.positions.startsWith('QB,RB,RB,WR'));
  assert.ok(cfg.urls.includes('/spaDraft'));
});

test('real second-screen page: the second-screen bundle is found for mining', () => {
  const bundles = fpw.findBundles(REAL_PAGE, 'https://draftwizard.fantasypros.com/d/secondscreen.jsp', false);
  assert.ok(bundles.some((b) => b.includes('second-screen/bundle-')), JSON.stringify(bundles));
});

test('real second-screen page: no false-positive picks in the shell HTML', () => {
  const found = fpw.extractDraft(REAL_PAGE);
  // alertMap/upsideMap etc. must not be mistaken for a draft board.
  assert.ok(!found || found.picks.length < 4);
});

test('mineBundlePaths: pulls draft-ish endpoint strings out of minified JS', () => {
  const js = 'var a=fetch("/spaDraft/secondScreen/state");b.get("/assets/img/x.png");c("/ajax/mock_draft/picks");d("/styles/app.css")';
  const paths = fpw.mineBundlePaths(js);
  assert.deepEqual(paths, ['/spaDraft/secondScreen/state', '/ajax/mock_draft/picks']);
});

test('fetchDraft: mines the bundle, hits its endpoint with the key, gets picks', async () => {
  const data = { picks: mkPicks(24, (name, position, team, i) => ({ pick: i, player: { name, position, team } })) };
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/d/secondscreen.jsp') {
      res.setHeader('Content-Type', 'text/html');
      // Page shell mirrors the real one: config + a second-screen bundle, no picks.
      res.end(`<html><script>window.draftRoomData={};window.draftRoomData.config={url:'/spaDraft',teamCount:12,userPos:5
        ,mockDraftKey: "nfl~bundletest"};</script>
        <script src='/assets/js/min/pages/second-screen/bundle-abc123.js'></script><body>Loading…</body></html>`);
    } else if (u.pathname === '/assets/js/min/pages/second-screen/bundle-abc123.js') {
      res.setHeader('Content-Type', 'text/javascript');
      res.end('!function(){var e="/spaDraft/secondScreen/getState";fetch(e+"?x=1")}();');
    } else if (u.pathname === '/spaDraft/secondScreen/getState' && u.searchParams.get('mockDraftKey') === 'nfl~bundletest') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(data));
    } else if (u.pathname.startsWith('/spaDraft')) {
      res.end('{"error":"key required"}');
    } else { res.statusCode = 404; res.end('nope'); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  try {
    const result = await fpw.fetchDraft(
      { url: base + '/d/secondscreen.jsp?mockDraftKey=nfl~bundletest', key: 'nfl~bundletest' },
      { allowAnyHost: true, leagueSize: 12, mySlot: 1 }
    );
    assert.equal(result.picks.length, 24);
    assert.equal(result.inferredLeagueSize, 12);
    // userPos from the page config decides "my picks", not the form default —
    // and it's a 0-based seat index, so userPos 5 = draft slot 6.
    assert.equal(result.inferredMySlot, 6);
    assert.deepEqual(result.picks.filter((p) => p.isMyPick).map((p) => p.overallPick), [6, 19]);
  } finally {
    server.close();
  }
});

test('fetchDraft: id-only picks resolve names via the site PLAYER_DATA file', async () => {
  // Array of pairs, not an object: integer-like object keys iterate in numeric
  // order and would scramble the intended pick order.
  const ids = [[23046, ['Bijan Robinson', 'RB', 'ATL']], [19790, ['Justin Jefferson', 'WR', 'MIN']],
    [26060, ['Jahmyr Gibbs', 'RB', 'DET']], [18232, ['Josh Allen', 'QB', 'BUF']],
    [17240, ['Derrick Henry', 'RB', 'BAL']], [24173, ['Trey McBride', 'TE', 'ARI']]];
  const picks = ids.map(([id], i) => ({ pick: i + 1, player: id }));
  const playerData = 'window.PLAYER_DATA = ' + JSON.stringify(
    ids.map(([id, [name, pos, team]]) => ({ player_id: id, name, position: pos, team }))
  ) + ';';
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/d/secondscreen.jsp') {
      res.setHeader('Content-Type', 'text/html');
      res.end(`<html><script src='/files/playersArray.jsp?varName=window.PLAYER_DATA&sport=nfl'></script>
        <script>go("/ajax/draft/state.json")</script><body></body></html>`);
    } else if (u.pathname === '/ajax/draft/state.json') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ num_teams: 6, picks }));
    } else if (u.pathname === '/files/playersArray.jsp') {
      res.setHeader('Content-Type', 'text/javascript');
      res.end(playerData);
    } else { res.statusCode = 404; res.end('nope'); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  try {
    const result = await fpw.fetchDraft(
      { url: base + '/d/secondscreen.jsp?mockDraftKey=nfl~ids', key: 'nfl~ids' },
      { allowAnyHost: true, leagueSize: 6, mySlot: 2 }
    );
    assert.equal(result.picks.length, 6);
    assert.equal(result.picks[0].playerName, 'Bijan Robinson');
    assert.equal(result.picks[0].position, 'RB');
    assert.equal(result.picks[3].playerName, 'Josh Allen');
    assert.equal(result.inferredLeagueSize, 6);
  } finally {
    server.close();
  }
});

test('huntPicks union: per-team roster arrays merge into one full board', () => {
  // 4 teams x 3 rounds, snake — each team's picks live in its own array.
  const teams = [1, 2, 3, 4].map((slot) => ({
    team_name: 'Team ' + slot,
    picks: [1, 2, 3].map((round) => {
      const overall = round % 2 === 1 ? (round - 1) * 4 + slot : (round - 1) * 4 + (4 - slot + 1);
      return { overall_pick: overall, round, player_name: 'Player ' + overall, position: 'RB', team: 'ATL' };
    }),
  }));
  const found = fpw.extractDraft(JSON.stringify({ draft: { teams } }));
  assert.ok(found);
  assert.equal(found.picks.length, 12); // the union, not one team's 3
  assert.deepEqual(found.picks.map((p) => p.overall), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
});

test('huntPicks union: a duplicated list does not out-vote the single best array', () => {
  // The same 6-pick list appears twice (aliased/copied) — union must not
  // treat that as "12 picks" or double anything.
  const picks = mkPicks(6, (name, position, team, i) => ({ pick: i, player_name: name, position, team }));
  const found = fpw.extractDraft(JSON.stringify({ a: picks, b: JSON.parse(JSON.stringify(picks)) }));
  assert.ok(found);
  assert.equal(found.picks.length, 6);
});

// ---- Real spaDraft state schema (captured via the diagnostic): the actual
// GET /spaDraft response for a fresh mock. Filled variants below simulate a
// completed draft the way FantasyPros populates this same shape.
const SPA_STATE = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'fp-spadraft-empty.json'), 'utf8'));

test('spaDraft state: an empty draft yields no picks (no false positives)', () => {
  assert.equal(fpw.parseSpaDraftState(SPA_STATE), null);
  assert.ok(!fpw.extractDraft(JSON.stringify(SPA_STATE)));
});

test('spaDraft state: top-level picks (numeric ids) + draftOrder reconstruct the board', () => {
  const state = JSON.parse(JSON.stringify(SPA_STATE));
  state.userPos = 5; // seat 6, like the owner's real draft
  state.isCompleted = true;
  state.picks = Array.from({ length: 180 }, (_, i) => 20000 + i); // fp ids in overall order
  const found = fpw.parseSpaDraftState(state);
  assert.ok(found);
  assert.equal(found.picks.length, 180);
  assert.equal(found.teamsLen, 12);
  // overall 6 = round 1, seat 6 -> the owner's pick (userPos 5, 0-based)
  assert.equal(found.picks[5].slot, 6);
  assert.equal(found.picks[5].mine, true);
  // snake: overall 13 = round 2 first pick = seat 12
  assert.equal(found.picks[12].slot, 12);
  assert.equal(found.picks[12].round, 2);
  assert.equal(found.picks[12].mine, undefined);
  // owner's round-2 pick: overall 19 (24 - 6 + 1)
  assert.equal(found.picks[18].slot, 6);
  assert.equal(found.picks[18].mine, true);
});

test('spaDraft state: falls back to per-team rosters when picks is empty', () => {
  const state = JSON.parse(JSON.stringify(SPA_STATE));
  state.userPos = 0;
  state.picks = [];
  // Give each team its round-1 and round-2 players (ids); seat = team.id.
  state.teams.forEach((t) => {
    t.players = [30000 + t.id, 31000 + t.id];
  });
  const found = fpw.parseSpaDraftState(state);
  assert.ok(found);
  assert.equal(found.picks.length, 24);
  // Round 1 runs seats 1..12 in order; overall 1 belongs to seat 1.
  assert.equal(found.picks[0].playerId, 30001);
  assert.equal(found.picks[0].mine, true); // userPos 0 = seat 1
  // Snake round 2: overall 13 is seat 12's second player.
  assert.equal(found.picks[12].playerId, 31012);
  assert.equal(found.picks[12].round, 2);
});

test('fetchDraft: full spaDraft flow — state ids resolved via PLAYER_DATA', async () => {
  const state = JSON.parse(JSON.stringify(SPA_STATE));
  state.userPos = 5;
  state.picks = Array.from({ length: 24 }, (_, i) => 40000 + i);
  const playerData = 'window.PLAYER_DATA = ' + JSON.stringify(
    Array.from({ length: 24 }, (_, i) => ({ player_id: 40000 + i, name: 'Player ' + (i + 1), position: 'RB', team: 'ATL' }))
  ) + ';';
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/d/secondscreen.jsp') {
      res.setHeader('Content-Type', 'text/html');
      res.end(`<html><script src='/files/playersArray.jsp?varName=window.PLAYER_DATA&sport=nfl'></script>
        <script>window.draftRoomData={config:{url:'/spaDraft',teamCount:12,userPos:5,mockDraftKey:"nfl~spa"}};</script><body></body></html>`);
    } else if (u.pathname === '/spaDraft' && u.searchParams.get('mockDraftKey') === 'nfl~spa') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(state));
    } else if (u.pathname === '/spaDraft') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(SPA_STATE)); // un-keyed: fresh empty draft
    } else if (u.pathname === '/files/playersArray.jsp') {
      res.setHeader('Content-Type', 'text/javascript');
      res.end(playerData);
    } else { res.statusCode = 404; res.end('nope'); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  try {
    const result = await fpw.fetchDraft(
      { url: base + '/d/secondscreen.jsp?mockDraftKey=nfl~spa', key: 'nfl~spa' },
      { allowAnyHost: true, leagueSize: 12, mySlot: 1 }
    );
    assert.equal(result.picks.length, 24);
    assert.equal(result.picks[0].playerName, 'Player 1');
    assert.equal(result.inferredLeagueSize, 12);
    assert.equal(result.inferredMySlot, 6);
    // Seat 6 in a 12-team snake: overalls 6 and 19.
    assert.deepEqual(result.picks.filter((p) => p.isMyPick).map((p) => p.overallPick), [6, 19]);
  } finally {
    server.close();
  }
});
