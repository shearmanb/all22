// DraftKings salaries without a login.
//
// DraftKings publishes no API, but its own lobby runs on two public JSON
// endpoints (the same ones every DFS tool reads):
//   1. https://www.draftkings.com/lobby/getcontests?sport=NFL
//      -> { Contests: [{ dg, ... }], DraftGroups: [{ DraftGroupId, GameTypeId,
//         ContestTypeId, GameCount, StartDateEst, ContestStartTimeSuffix, ... }] }
//      Every open slate ("draft group") with its start time and game count.
//   2. https://api.draftkings.com/draftgroups/v1/draftgroups/<id>/draftables
//      -> { draftables: [{ playerId, displayName, position, salary,
//         teamAbbreviation, status, rosterSlotId, competition: { name } }] }
//      Every player on that slate with his salary.
//
// Both are undocumented, so the parsers shape-check hard and throw a readable
// error rather than inventing a slate (same stance as Edge Rush's ESPN feed).
// DraftKings may also refuse a cloud server outright; the page says so and the
// CSV export stays the manual path.
//
// The draftables are turned into the SAME columns DraftKings' "Export to CSV"
// carries (Position, Name, ID, Salary, TeamAbbrev, Game Info, …), so a fetched
// slate and an uploaded one are stored and read identically — value.js's
// parseSalaries reads both.

const FETCH_TIMEOUT_MS = 20000;
const USER_AGENT = 'Mozilla/5.0 (compatible; All22/1.0; personal fantasy tool)';
const LOBBY_URL = 'https://www.draftkings.com/lobby/getcontests?sport=NFL';
const draftablesUrl = (id) => `https://api.draftkings.com/draftgroups/v1/draftgroups/${encodeURIComponent(id)}/draftables`;

// DraftKings' classic NFL game type (QB, 2 RB, 3 WR, TE, FLEX, DST, $50K) —
// the one that lines up with FanDuel's full-roster contests. Showdown,
// Tiers, Snake etc. price differently and are left out of the picker.
const CLASSIC_GAME_TYPE = 1;

function startMs(g) {
  const m = /\/Date\((\d+)/.exec(String(g.StartDate || ''));
  if (m) return Number(m[1]);
  const t = Date.parse(g.StartDateEst || '');
  return Number.isFinite(t) ? t : null;
}

// "Sun 1:00 PM" from DK's Eastern-time string, read as written (it IS Eastern,
// and that's how the owner thinks about slates).
function slateWhen(est) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(String(est || ''));
  if (!m) return '';
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getUTCDay()];
  let h = +m[4];
  const ap = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${day} ${m[2]}/${m[3]} ${h}:${m[5]} ${ap} ET`;
}

// Lobby JSON -> classic NFL slates, most contests first (the main slate always
// carries by far the most contests, so it leads and is the default).
function parseLobby(json) {
  if (!json || !Array.isArray(json.DraftGroups)) {
    throw new Error('DraftKings\' lobby answered, but not in the shape expected (no DraftGroups list) — they may have changed it. Use the CSV export instead.');
  }
  const contests = new Map();
  for (const c of Array.isArray(json.Contests) ? json.Contests : []) {
    if (c && c.dg != null) contests.set(String(c.dg), (contests.get(String(c.dg)) || 0) + 1);
  }
  const out = [];
  for (const g of json.DraftGroups) {
    if (!g || g.DraftGroupId == null) continue;
    const classic = Number(g.GameTypeId) === CLASSIC_GAME_TYPE;
    if (!classic) continue;
    const suffix = String(g.ContestStartTimeSuffix || '').trim().replace(/^\((.*)\)$/, '$1');
    const games = Number(g.GameCount) || null;
    const when = slateWhen(g.StartDateEst);
    const n = contests.get(String(g.DraftGroupId)) || 0;
    out.push({
      id: Number(g.DraftGroupId),
      label: [when || 'Slate ' + g.DraftGroupId, suffix || null, games ? `${games} game${games === 1 ? '' : 's'}` : null].filter(Boolean).join(' · '),
      start: startMs(g),
      games,
      suffix: suffix || null,
      contests: n,
      tag: g.DraftGroupTag || null,
    });
  }
  out.sort((a, b) => (b.contests - a.contests) || ((b.games || 0) - (a.games || 0)));
  return out;
}

function csvCell(v) {
  const s = String(v == null ? '' : v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// "BAL @ CIN" + "BAL" -> "CIN".
function opponentOf(gameName, team) {
  const m = /^\s*([A-Z]{2,4})\s*@\s*([A-Z]{2,4})/i.exec(String(gameName || ''));
  if (!m || !team) return '';
  const a = m[1].toUpperCase(), b = m[2].toUpperCase(), t = String(team).toUpperCase();
  return t === a ? b : t === b ? a : '';
}

// Draftables JSON -> CSV text in DraftKings' export columns, one row per
// player. DK lists a player once per roster slot he can fill (and, in
// single-game modes, again at a captain's 1.5x price), so rows are folded by
// playerId keeping the lowest salary — his real price.
function draftablesToCsv(json) {
  if (!json || !Array.isArray(json.draftables)) {
    throw new Error('DraftKings answered, but not in the shape expected (no draftables list) — they may have changed it. Use the CSV export instead.');
  }
  const byPlayer = new Map();
  for (const d of json.draftables) {
    if (!d) continue;
    const salary = Number(d.salary);
    const name = String(d.displayName || [d.firstName, d.lastName].filter(Boolean).join(' ')).trim();
    if (!name || !Number.isFinite(salary) || salary <= 0) continue;
    const key = String(d.playerId != null ? d.playerId : name);
    const prev = byPlayer.get(key);
    if (prev && prev.salary <= salary) continue;
    const team = String(d.teamAbbreviation || '').trim().toUpperCase();
    const game = (d.competition && d.competition.name) || '';
    const status = String(d.status || '').trim();
    byPlayer.set(key, {
      position: String(d.position || '').trim().toUpperCase(),
      name, id: d.draftableId != null ? d.draftableId : (d.playerId != null ? d.playerId : ''),
      salary, team, game,
      opp: opponentOf(game, team),
      injury: /^none$/i.test(status) ? '' : status.toUpperCase(),
    });
  }
  const rows = [...byPlayer.values()].sort((a, b) => b.salary - a.salary);
  if (!rows.length) throw new Error('DraftKings returned that slate with no priced players.');
  const lines = ['Position,Name,ID,Salary,TeamAbbrev,Opponent,Game Info,Injury Indicator'];
  for (const r of rows) {
    lines.push([r.position, r.name, r.id, r.salary, r.team, r.opp, r.game, r.injury].map(csvCell).join(','));
  }
  return { csv: lines.join('\n') + '\n', count: rows.length };
}

async function getJson(url) {
  let res;
  try {
    res = await fetch(url, {
      headers: { accept: 'application/json', 'user-agent': USER_AGENT },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (e) {
    throw new Error(`Could not reach DraftKings (${e.name === 'TimeoutError' ? 'timed out' : e.message}). Use the CSV export instead.`);
  }
  if (res.status === 403 || res.status === 401) {
    throw new Error(`DraftKings refused this server (HTTP ${res.status}) — they block some cloud addresses. Use the CSV export instead.`);
  }
  if (!res.ok) throw new Error(`DraftKings responded ${res.status}. Use the CSV export instead.`);
  try { return await res.json(); } catch (e) {
    throw new Error('DraftKings answered with something other than JSON (often a block page). Use the CSV export instead.');
  }
}

async function fetchSlates() {
  return parseLobby(await getJson(LOBBY_URL));
}

async function fetchSalaries(draftGroupId) {
  const id = String(draftGroupId || '').trim();
  if (!/^\d+$/.test(id)) throw new Error('Pick a DraftKings slate first.');
  const url = draftablesUrl(id);
  return Object.assign(draftablesToCsv(await getJson(url)), { url, id: Number(id) });
}

module.exports = { parseLobby, draftablesToCsv, opponentOf, slateWhen, fetchSlates, fetchSalaries, LOBBY_URL, draftablesUrl };
