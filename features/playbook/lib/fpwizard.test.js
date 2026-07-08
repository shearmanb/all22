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
