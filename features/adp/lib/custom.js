// custom.js — user-added ADP sources. The owner pastes a URL on the Edge Rush
// page; the collector recognizes the host and parses it daily alongside the
// built-in FFC/Sleeper feeds. Adapters that ship:
//
//   FantasyPros ADP  (fantasypros.com/nfl/adp/*.php) — reuses the embedded-data
//     hunt proven for the rankings URL fetch. FantasyPros ADP is itself a
//     consensus of ESPN, Sleeper, CBS and RTSports, so one URL brings several
//     sites' ADP in a single reliable-to-parse page. Native Yahoo ADP is NOT
//     among them (Yahoo guards its numbers) — that needs OAuth, not a URL.
//   MyFantasyLeague  (api.myfantasyleague.com/{yr}/export?TYPE=adp&JSON=1) —
//     documented free JSON.
//
// Any other host fails with a clear "not supported yet" message rather than a
// silent empty pull (CLAUDE.md: failures must be visible). Parsing is pure and
// golden-tested; only fetchCustom touches the network.
//
// NOTE: the parsers are written against these sources' known payload shapes but
// were not live-exercised from this build's sandbox (its proxy blocks the
// hosts). Confirm the first real pull on Railway — a shape drift surfaces as a
// loud per-source error in the collector's last-run summary, not bad data.

const FETCH_TIMEOUT_MS = 20000;
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const FORMATS = new Set(['ppr', 'half', 'standard', 'best_ball', 'superflex', 'unknown']);
function cleanFormat(f) {
  const v = String(f || '').toLowerCase().trim();
  return FORMATS.has(v) ? v : 'unknown';
}

function toNum(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

// ---------------------------------------------------------------------------
// Host recognition + provenance. Returns null for an unsupported/invalid URL.
// ---------------------------------------------------------------------------
function identify(url) {
  let u;
  try { u = new URL(String(url).includes('://') ? url : 'https://' + url); } catch (e) { return null; }
  const host = u.hostname.toLowerCase();
  if (/(^|\.)fantasypros\.com$/.test(host)) {
    return { adapter: 'fantasypros', site: 'fantasypros', label: 'FantasyPros ADP', url: u.toString() };
  }
  if (/(^|\.)myfantasyleague\.com$/.test(host)) {
    return { adapter: 'mfl', site: 'mfl', label: 'MyFantasyLeague ADP', url: u.toString() };
  }
  return null;
}

const SUPPORTED_HINT =
  'Supported ADP links right now: a FantasyPros ADP page ' +
  '(fantasypros.com/nfl/adp/ppr-overall.php, half-point-ppr, standard, superflex) ' +
  'or a MyFantasyLeague ADP export. FantasyPros already blends ESPN, Sleeper, CBS ' +
  'and RTSports. (Native Yahoo ADP needs a Yahoo login, not a link.)';

// Format implied by a FantasyPros ADP URL (owner can override in the entry).
function inferFormat(url) {
  const f = String(url).toLowerCase();
  if (f.includes('half-point-ppr') || f.includes('half-ppr')) return 'half';
  if (f.includes('superflex')) return 'superflex';
  if (f.includes('best-ball') || f.includes('bestball')) return 'best_ball';
  if (f.includes('ppr')) return 'ppr';
  if (f.includes('standard')) return 'standard';
  return 'unknown';
}

// ---------------------------------------------------------------------------
// FantasyPros: hunt the embedded player array (shape-agnostic, like fpwizard).
// ---------------------------------------------------------------------------
function balancedEnd(src, start) {
  const open = src[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < src.length; i++) {
    const ch = src[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

const NAME_KEYS = ['player_name', 'name', 'full_name', 'player'];
const ADP_KEYS = ['adp', 'rank_ave', 'average', 'avg', 'average_pick'];
const TEAM_KEYS = ['player_team_id', 'team', 'team_id', 'tm'];
const POS_KEYS = ['player_position_id', 'position', 'pos'];
const BYE_KEYS = ['player_bye_week', 'bye', 'bye_week'];

function pick(obj, keys) {
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null && obj[k] !== '') return obj[k];
  }
  return undefined;
}

// Does this array look like ADP rows? (objects carrying a name and an ADP-ish
// number). Returns the mapped rows, or null.
function adpRowsFromArray(arr) {
  if (!Array.isArray(arr) || arr.length < 5) return null;
  const rows = [];
  for (const el of arr) {
    if (!el || typeof el !== 'object') return null;
    const name = pick(el, NAME_KEYS);
    const adp = toNum(pick(el, ADP_KEYS));
    if (!name || adp === null) continue;
    rows.push({
      name: String(name),
      position: String(pick(el, POS_KEYS) || '').toUpperCase().replace('DEF', 'DST'),
      team: String(pick(el, TEAM_KEYS) || '').toUpperCase(),
      bye: toNum(pick(el, BYE_KEYS)),
      adp,
      high: null, low: null, stdev: null, times_drafted: null,
    });
  }
  return rows.length >= 5 ? rows : null;
}

// Walk any parsed JSON value for the first array that looks like ADP rows.
function findAdpRows(value, depth = 0) {
  if (depth > 6 || !value || typeof value !== 'object') return null;
  const direct = adpRowsFromArray(value);
  if (direct) return direct;
  const children = Array.isArray(value) ? value : Object.values(value);
  for (const child of children) {
    const found = findAdpRows(child, depth + 1);
    if (found) return found;
  }
  return null;
}

// Extract ADP rows from a FantasyPros ADP page's HTML by hunting embedded JSON.
function parseFantasyProsAdp(html) {
  const src = String(html || '');
  const startRe = /[=:(,]\s*([[{])/g;
  let m;
  let best = null;
  while ((m = startRe.exec(src))) {
    const start = m.index + m[0].length - 1;
    const end = balancedEnd(src, start);
    if (end === -1) { startRe.lastIndex = start + 1; continue; }
    if (end - start < 200) { startRe.lastIndex = start + 1; continue; }
    let parsed;
    try { parsed = JSON.parse(src.slice(start, end + 1)); } catch (e) { startRe.lastIndex = start + 1; continue; }
    const rows = findAdpRows(parsed);
    if (rows && (!best || rows.length > best.length)) best = rows;
    startRe.lastIndex = end + 1;
  }
  if (!best) {
    throw new Error('Could not find ADP data on that FantasyPros page (their layout may have changed). ' + SUPPORTED_HINT);
  }
  return best;
}

async function fetchFantasyProsAdp(entry) {
  const id = identify(entry.url);
  const res = await fetch(id.url, {
    headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/xhtml+xml', 'accept-language': 'en-US,en;q=0.9' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`FantasyPros responded ${res.status} — it may be blocking automated fetches right now.`);
  const rows = parseFantasyProsAdp(await res.text());
  return {
    site: 'fantasypros',
    format: cleanFormat(entry.format || inferFormat(id.url)),
    teams: Number(entry.teams) || 12,
    rows,
  };
}

// ---------------------------------------------------------------------------
// MyFantasyLeague: documented JSON. { adp: { player: [ {id,name,adp,...} ] } }.
// ---------------------------------------------------------------------------
function parseMfl(json) {
  const players = json && json.adp && json.adp.player;
  const list = Array.isArray(players) ? players : (players ? [players] : null);
  if (!list) throw new Error('MyFantasyLeague response had no ADP player list (check the URL includes TYPE=adp&JSON=1).');
  const rows = [];
  for (const p of list) {
    if (!p) continue;
    // MFL names come as "Last, First TEAM POS" or carry name/team/position keys.
    let name = p.name || '';
    let team = String(p.team || '').toUpperCase();
    let position = String(p.position || '').toUpperCase();
    if (name.includes(',')) {
      const parts = name.split(/\s+/);
      // "Chase, Ja'Marr" -> "Ja'Marr Chase"
      const comma = name.split(',');
      if (comma.length === 2) name = (comma[1].trim() + ' ' + comma[0].trim()).trim();
      void parts;
    }
    const adp = toNum(p.adp);
    if (!name || adp === null) continue;
    rows.push({
      name, position: position.replace('DEF', 'DST'), team,
      bye: null, adp,
      high: toNum(p.maxPick), low: toNum(p.minPick), stdev: null,
      times_drafted: toNum(p.draftsSelectedIn),
    });
  }
  if (!rows.length) throw new Error('MyFantasyLeague returned no ADP rows.');
  return rows;
}

async function fetchMfl(entry) {
  const id = identify(entry.url);
  const u = new URL(id.url);
  if (!/adp/i.test(u.searchParams.get('TYPE') || '')) u.searchParams.set('TYPE', 'adp');
  u.searchParams.set('JSON', '1');
  const res = await fetch(u.toString(), {
    headers: { accept: 'application/json', 'user-agent': USER_AGENT },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`MyFantasyLeague responded ${res.status}.`);
  const rows = parseMfl(await res.json());
  return { site: 'mfl', format: cleanFormat(entry.format || 'ppr'), teams: Number(entry.teams) || 12, rows };
}

// ---------------------------------------------------------------------------
// Dispatch: a custom entry -> normalized { site, format, teams, rows }.
// ---------------------------------------------------------------------------
async function fetchCustom(entry) {
  const id = identify(entry && entry.url);
  if (!id) throw new Error(`I don't know how to read ADP from that link yet. ${SUPPORTED_HINT}`);
  if (id.adapter === 'fantasypros') return fetchFantasyProsAdp(entry);
  if (id.adapter === 'mfl') return fetchMfl(entry);
  throw new Error(`No adapter for ${id.adapter}.`);
}

module.exports = {
  identify,
  inferFormat,
  cleanFormat,
  parseFantasyProsAdp,
  parseMfl,
  fetchCustom,
  SUPPORTED_HINT,
};
