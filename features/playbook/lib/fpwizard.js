// FantasyPros Draft Wizard URL import. The owner pastes a Draft Wizard link
// (e.g. the "second screen" URL: .../d/secondscreen.jsp?mockDraftKey=nfl~<uuid>)
// and we fetch the draft server-side instead of making him copy-paste the board.
//
// FantasyPros doesn't document these pages, so nothing here assumes an exact
// payload shape. The strategy:
//   1. fetch the pasted page;
//   2. hunt for pick data in it — whole-body JSON, or JSON blobs embedded in
//      the HTML/scripts (balanced-brace scan), scored by how pick-like their
//      arrays are;
//   3. if the page itself has none, mine it for same-site data URLs (ajax/json
//      endpoints, anything mentioning the mock draft key) and try those;
//   4. normalize whatever we found into Playbook's pick shape (snake-draft
//      round/slot math, DST naming) — the same preview/save path as a paste.
// If every step comes up empty the caller gets { picks: [], tried } and the UI
// says so loudly; the paste path always remains as the fallback.

const { clean, teamFromToken } = require('../../../lib/players');

// Bumped on every importer change; stamped into the diagnostic download so a
// report is always tied to the build that produced it.
const VERSION = 6;

// --- URL / key --------------------------------------------------------------

// Accepts a full fantasypros.com URL or a bare "nfl~<uuid>" key.
// Returns { url, key } or null when it's clearly not a Draft Wizard link.
function parseTarget(input) {
  const s = String(input || '').trim();
  if (!s) return null;
  let dec = s;
  try { dec = decodeURIComponent(s); } catch (e) { /* keep raw */ }
  const bare = /^([a-z]{2,6}~[0-9a-f][0-9a-f-]{7,})$/i.exec(dec);
  if (bare) {
    return {
      key: bare[1],
      url: 'https://draftwizard.fantasypros.com/d/secondscreen.jsp?mockDraftKey=' + encodeURIComponent(bare[1]),
    };
  }
  let u;
  try { u = new URL(s); } catch (e) { return null; }
  if (!/(^|\.)fantasypros\.com$/i.test(u.hostname)) return null;
  return { key: u.searchParams.get('mockDraftKey') || null, url: u.toString() };
}

// --- JSON hunting -----------------------------------------------------------

function tryJson(text) {
  try { return JSON.parse(text); } catch (e) { return null; }
}

// JSP-era pages often embed JAVASCRIPT object literals, not strict JSON:
// unquoted keys ({pick: 1}) and single-quoted strings ('Bijan Robinson').
// Repair those two patterns and re-parse. Heuristic by design — the result
// still has to survive JSON.parse, so a bad repair just yields null.
function tryRelaxedJson(text) {
  let t = String(text)
    // 'single quoted' -> "double quoted" (escaping inner double quotes)
    .replace(/'((?:[^'\\]|\\.)*)'/g, (m, inner) => '"' + inner.replace(/\\'/g, "'").replace(/"/g, '\\"') + '"')
    // {key: / ,key:  ->  {"key":
    .replace(/([{,]\s*)([A-Za-z_$][\w$]*)(\s*:)/g, '$1"$2"$3');
  return tryJson(t);
}

// Scan text for balanced {...} / [...] regions that parse as JSON. Only starts
// at assignment/argument positions ("= {", ": [", "({", ", [", etc.) so an
// HTML page doesn't trigger a parse attempt at every brace.
function jsonBlobs(text, maxBlobs) {
  const out = [];
  const src = String(text || '').slice(0, 2 * 1024 * 1024);
  const startRe = /[=:(,(]\s*([[{])/g;
  let m;
  while (out.length < maxBlobs && (m = startRe.exec(src))) {
    const start = m.index + m[0].length - 1;
    const end = balancedEnd(src, start);
    if (end === -1) continue;
    if (end - start < 80) { startRe.lastIndex = start + 1; continue; } // too small to be a draft
    const slice = src.slice(start, end + 1);
    const parsed = tryJson(slice) || tryRelaxedJson(slice);
    if (parsed && typeof parsed === 'object') {
      out.push(parsed);
      startRe.lastIndex = end + 1;
    } else {
      startRe.lastIndex = start + 1;
    }
  }
  return out;
}

// Index of the bracket closing src[start], respecting strings/escapes; -1 if unbalanced.
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
    else if (ch === '}' || ch === ']') {
      depth--;
      // JSON.parse validates bracket kinds; we only find the balanced end.
      if (depth === 0) return i;
    }
  }
  return -1;
}

// --- Recognizing picks in arbitrary JSON ------------------------------------

function str(v) { return typeof v === 'string' && v.trim() ? v.trim() : null; }

function pickName(el, depth) {
  if (!el || typeof el !== 'object') return null;
  const direct = str(el.player_name) || str(el.playerName) || str(el.full_name) ||
    str(el.fullName) || str(el.name) || str(el.player_display_name);
  if (direct && /[a-z]/i.test(direct)) return direct;
  if ((depth || 0) < 2) {
    const nested = el.player || el.Player || el.player_info;
    if (nested) return pickName(nested, (depth || 0) + 1);
  }
  return null;
}

function pickField(el, names) {
  for (const n of names) {
    if (el[n] !== undefined && el[n] !== null && el[n] !== '') return el[n];
    const p = el.player || el.Player || el.player_info;
    if (p && typeof p === 'object' && p[n] !== undefined && p[n] !== null && p[n] !== '') return p[n];
  }
  return undefined;
}

function normPos(v) {
  if (v === undefined || v === null) return '';
  const p = String(v).trim().toUpperCase();
  if (p === 'DEF' || p === 'D/ST' || p === 'DS') return 'DST';
  if (p === 'PK') return 'K';
  return /^(QB|RB|WR|TE|K|DST|FLX|DL|LB|DB|S|CB|P)$/.test(p) ? p : '';
}

function num(v) {
  const n = Number(v);
  return isFinite(n) && n > 0 ? Math.round(n) : null;
}

// A player referenced by FantasyPros numeric id instead of a name — resolved
// later against the site's PLAYER_DATA file.
function pickPlayerId(el) {
  const direct = pickField(el, ['player_id', 'playerId', 'fpid', 'fp_id', 'id']);
  if (num(direct)) return num(direct);
  // e.g. { player: 23046, pick: 1 }
  if (num(el.player)) return num(el.player);
  return null;
}

// Turn one array element into a raw pick, or null if it doesn't look like one.
function readPick(el) {
  if (!el || typeof el !== 'object' || Array.isArray(el)) return null;
  const name = pickName(el);
  if (!name || name.length > 60) return readIdPick(el);
  const position = normPos(pickField(el, ['position', 'pos', 'player_position', 'position_id']));
  const teamRaw = pickField(el, ['nfl_team', 'team_abbr', 'team_abbreviation', 'pro_team', 'team']);
  const team = teamRaw == null ? '' : (teamFromToken(String(teamRaw)) || '');
  const overall = num(pickField(el, ['overall', 'overall_pick', 'overallPick', 'pick', 'pick_number', 'pickNumber', 'pick_no']));
  const round = num(pickField(el, ['round', 'rd', 'round_number']));
  const slot = num(pickField(el, ['draft_slot', 'draftSlot', 'slot', 'pick_in_round', 'round_pick']));
  const mineRaw = pickField(el, ['is_user', 'isUser', 'is_mine', 'isMine', 'self', 'is_me', 'my_pick', 'user_pick']);
  const mine = mineRaw === true || mineRaw === 'true' || mineRaw === 1 ? true : undefined;
  const hasPickInfo = overall !== null || round !== null;
  return { name, position, team, overall, round, slot, mine, hasPickInfo };
}

// A nameless element that still reads as a pick: a numeric player id plus a
// pick/round number. The id gets a name later via resolvePlayerIds().
function readIdPick(el) {
  const playerId = pickPlayerId(el);
  const overall = num(pickField(el, ['overall', 'overall_pick', 'overallPick', 'pick', 'pick_number', 'pickNumber', 'pick_no']));
  const round = num(pickField(el, ['round', 'rd', 'round_number']));
  if (!playerId || (overall === null && round === null)) return null;
  const slot = num(pickField(el, ['draft_slot', 'draftSlot', 'slot', 'pick_in_round', 'round_pick']));
  const mineRaw = pickField(el, ['is_user', 'isUser', 'is_mine', 'isMine', 'self', 'is_me', 'my_pick', 'user_pick']);
  const mine = mineRaw === true || mineRaw === 'true' || mineRaw === 1 ? true : undefined;
  return { name: null, playerId, position: '', team: '', overall, round, slot, mine, hasPickInfo: true };
}

// Build { fpId: {name, position, team} } from FantasyPros' PLAYER_DATA file
// (window.PLAYER_DATA = [...] — a big array of player objects).
function buildPlayerMap(body) {
  const map = {};
  const roots = [];
  const whole = tryJson(String(body || '').trim());
  if (whole) roots.push(whole);
  else roots.push(...jsonBlobs(String(body || ''), 10));
  for (const root of roots) {
    const queue = [root];
    let visited = 0;
    while (queue.length && visited < 3000) {
      const node = queue.shift();
      visited++;
      if (!node || typeof node !== 'object') continue;
      if (Array.isArray(node)) {
        for (const el of node) {
          if (el && typeof el === 'object' && !Array.isArray(el)) {
            const id = num(el.player_id !== undefined ? el.player_id : el.id);
            const name = pickName(el);
            if (id && name && map[id] === undefined) {
              map[id] = {
                name,
                position: normPos(el.position || el.pos || el.position_id),
                team: el.team ? (teamFromToken(String(el.team)) || '') : '',
              };
            } else if (el && typeof el === 'object') {
              queue.push(el);
            }
          }
        }
      } else {
        for (const k of Object.keys(node)) if (node[k] && typeof node[k] === 'object') queue.push(node[k]);
      }
    }
  }
  return map;
}

// Walk a JSON tree and return the most pick-like content, plus a guess at the
// league size. Draft payloads come flat (one picks array) OR as per-team
// rosters (12 arrays of ~15) — when several qualifying arrays carry distinct
// overall-pick numbers, their UNION is the board and beats any single array.
function huntPicks(root) {
  const candidates = [];
  let teamsLen = null;
  const seen = new Set();
  const queue = [root];
  let visited = 0;
  while (queue.length && visited < 5000) {
    const node = queue.shift();
    visited++;
    if (!node || typeof node !== 'object') continue;
    if (Array.isArray(node)) {
      if (seen.has(node)) continue; // an aliased array must not count twice
      seen.add(node);
      if (node.length >= 2 && node.length <= 600) {
        const sample = node.slice(0, 40);
        const reads = sample.map(readPick);
        const named = reads.filter(Boolean);
        if (named.length / sample.length >= 0.7 && named.length >= 2) {
          const withInfo = named.filter((p) => p.hasPickInfo).length;
          const withPos = named.filter((p) => p.position).length;
          // Pick arrays carry pick numbers and/or positions; a plain roster of
          // team names carries neither.
          if (withInfo || withPos >= named.length * 0.5) {
            const picks = node.map(readPick).filter(Boolean);
            const score = named.length / sample.length + (withInfo ? 1 : 0) +
              (withPos / Math.max(1, named.length)) + Math.min(1, node.length / 100);
            candidates.push({ picks, score, infoRate: withInfo / Math.max(1, named.length) });
          } else if (node.length >= 6 && node.length <= 20 && teamsLen === null) {
            teamsLen = node.length; // looks like the fantasy-team list
          }
        }
      }
      for (const el of node) if (el && typeof el === 'object') queue.push(el);
    } else {
      for (const k of Object.keys(node)) {
        const v = node[k];
        if (v && typeof v === 'object') queue.push(v);
        // An explicit team count beats guessing from array lengths.
        if (teamsLen === null && /^(num_teams|numTeams|league_size|leagueSize|teams_count)$/.test(k)) {
          const n = num(v);
          if (n && n >= 4 && n <= 24) teamsLen = n;
        }
      }
    }
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];

  // Union pass: merge every numbered pick across qualifying arrays. Distinct
  // overall numbers = per-team rosters of one board; heavy overlap = the same
  // list seen twice (union adds nothing, best single array stands).
  const byOverall = new Map();
  for (const c of candidates) {
    if (c.infoRate < 0.7) continue;
    for (const p of c.picks) {
      if (p.overall !== null && !byOverall.has(p.overall)) byOverall.set(p.overall, p);
    }
  }
  if (byOverall.size >= 8 && byOverall.size >= best.picks.length * 1.5) {
    const union = [...byOverall.values()].sort((a, b) => a.overall - b.overall);
    return { picks: union, teamsLen, score: best.score + 1 };
  }
  return { picks: best.picks, teamsLen, score: best.score };
}

// The Draft Wizard state payload (GET /spaDraft?mockDraftKey=...) has a known
// shape — parse it DETERMINISTICALLY instead of heuristically:
//   draftOrder: [[round, pickInRound, seat], ...]  (index = overall pick - 1)
//   picks:      the drafted players in overall order (ids or objects)
//   teams:      [{ id: seat, name, players: [...] }, ...]  (fallback source)
//   userPos:    the owner's 0-based seat
function parseSpaDraftState(root) {
  if (!root || typeof root !== 'object' || Array.isArray(root)) return null;
  if (!Array.isArray(root.draftOrder) || !Array.isArray(root.teams)) return null;
  if (!root.draftOrder.length || !root.teams.length) return null;
  const userPos = Number.isInteger(root.userPos) ? root.userPos : null;

  const mk = (pl, overall, round, slot) => {
    let name = null, playerId = null, position = '', team = '', mine;
    if (typeof pl === 'number') playerId = num(pl);
    else if (typeof pl === 'string') { playerId = num(pl); if (!playerId) name = pl.trim() || null; }
    else if (pl && typeof pl === 'object') {
      name = pickName(pl);
      playerId = pickPlayerId(pl);
      position = normPos(pickField(pl, ['position', 'pos', 'position_id']));
      const tr = pickField(pl, ['nfl_team', 'team_abbr', 'pro_team', 'team']);
      team = tr == null ? '' : (teamFromToken(String(tr)) || '');
      // Observed pick-object schema: { owner, ownerPos (0-based seat), round,
      // pick (overall), isUserTeam, id, isNewPick, posInRound, isKeeper }.
      if (Number.isInteger(pl.ownerPos)) slot = pl.ownerPos + 1;
      if (num(pl.pick)) overall = num(pl.pick);
      if (num(pl.round)) round = num(pl.round);
      if (pl.isUserTeam === true) mine = true;
    }
    if (!name && !playerId) return null;
    if (mine === undefined) mine = userPos !== null && slot === userPos + 1 ? true : undefined;
    return { name, playerId, position, team, overall, round, slot, mine, hasPickInfo: true };
  };

  // Source 1: the top-level picks list in overall order. CAUTION: on the
  // second-screen state this can be just the recent-picks ticker (last few),
  // not the whole board.
  const fromPicks = [];
  if (Array.isArray(root.picks) && root.picks.length) {
    root.picks.forEach((pl, i) => {
      const at = root.draftOrder[i];
      const p = mk(pl, i + 1, at ? at[0] : null, at ? at[2] : null);
      if (p) fromPicks.push(p);
    });
  }
  // Source 2: rebuild from per-team rosters — team seat n's k-th player went
  // at the k-th draftOrder entry belonging to seat n.
  const fromTeams = [];
  const bySlot = {};
  root.draftOrder.forEach((e, i) => {
    if (Array.isArray(e) && e.length >= 3) (bySlot[e[2]] = bySlot[e[2]] || []).push({ overall: i + 1, round: e[0] });
  });
  root.teams.forEach((t, ti) => {
    const slot = num(t && t.id) || ti + 1;
    const seq = bySlot[slot] || [];
    (t && Array.isArray(t.players) ? t.players : []).forEach((pl, pi) => {
      const at = seq[pi];
      const p = mk(pl, at ? at.overall : null, at ? at.round : null, slot);
      if (p) fromTeams.push(p);
    });
  });
  fromTeams.sort((a, b) => (a.overall || Infinity) - (b.overall || Infinity));

  // Whichever source saw more of the draft is the board.
  const picks = fromTeams.length > fromPicks.length ? fromTeams : fromPicks;
  if (picks.length < 2) return null;

  // GUARD (learned the hard way): an anonymous GET of /spaDraft?mockDraftKey
  // with no cmd STARTS A NEW SIMULATION — random CPU teams, a handful of
  // auto-picks all flagged isNewPick, the user's team empty. Reject that
  // signature. A resumed real draft passes: it has more picks than teams
  // (and/or the user's roster is populated).
  const userTeam = userPos !== null && root.teams[userPos] ? root.teams[userPos] : null;
  const userEmpty = !userTeam || !Array.isArray(userTeam.players) || userTeam.players.length === 0;
  const allNew = Array.isArray(root.picks) && root.picks.length &&
    root.picks.every((p) => p && typeof p === 'object' && p.isNewPick === true);
  if (allNew && picks.length <= root.teams.length && userEmpty) {
    return 'rejected';
  }
  return { picks, teamsLen: root.teams.length, score: 100 };
}

// Extract the best pick list from a response body (JSON or HTML with embedded
// JSON). Returns { picks: [raw], teamsLen } or null.
function extractDraft(body) {
  const text = String(body || '');
  if (!text.trim()) return null;
  const roots = [];
  const whole = tryJson(text.trim());
  if (whole && typeof whole === 'object') roots.push(whole);
  else roots.push(...jsonBlobs(text, 40));
  // A recognized spaDraft state payload beats every heuristic outright — and a
  // REJECTED one (manufactured fresh sim) is excluded from the heuristics too,
  // so its fake picks can't sneak back in through the generic hunt.
  const huntable = [];
  for (const root of roots) {
    const state = parseSpaDraftState(root);
    if (state === 'rejected') continue;
    if (state) return state;
    huntable.push(root);
  }
  let best = null;
  for (const root of huntable) {
    const found = huntPicks(root);
    if (found && found.picks.length && (!best || found.score > best.score)) best = found;
  }
  return best;
}

// --- Page config mining -------------------------------------------------------

// The second-screen page embeds window.draftRoomData.config with everything
// but the picks: the draft key, teamCount (league size), userPos (the owner's
// seat) and API base paths like url:'/spaDraft'. Mine it with targeted
// regexes — the object is relaxed JS spread across template whitespace, not
// parseable JSON.
function mineConfig(html) {
  const s = String(html || '');
  const get = (re) => { const m = re.exec(s); return m ? m[1] : null; };
  const urls = [];
  const urlRe = /[A-Za-z]*[uU]rl['"]?\s*:\s*["'](\/[^"'\s]{1,120})["']/g;
  let m;
  while ((m = urlRe.exec(s)) && urls.length < 8) {
    if (!urls.includes(m[1])) urls.push(m[1]);
  }
  const userPosRaw = get(/userPos\s*:\s*(\d+)/);
  return {
    key: get(/mockDraftKey\s*[:=]\s*["']([^"']+)["']/),
    teamCount: num(get(/teamCount\s*:\s*(\d+)/)),
    // 0-BASED seat index (verified against a real board: userPos 5 = the 6th
    // column, "Your Team" picking 1.06). 0 is a real value (seat 1).
    userPos: userPosRaw === null ? null : parseInt(userPosRaw, 10),
    positions: get(/positions\s*:\s*["']([A-Z/,]+)["']/),
    urls,
  };
}

// Script bundles worth mining for API paths: same-site .js whose path suggests
// it drives the draft screens (second-screen / draft-room bundles).
function findBundles(html, baseUrl, allowAnyHost) {
  const out = [];
  const re = /src\s*=\s*["']([^"']+\.js[^"']*)["']/gi;
  let m;
  while ((m = re.exec(String(html || ''))) && out.length < 2) {
    if (!/(second[-_]?screen|draft[-_]?room|draft)/i.test(m[1])) continue;
    let abs;
    try { abs = new URL(m[1], baseUrl); } catch (e) { continue; }
    if (!/^https?:$/.test(abs.protocol)) continue;
    if (!allowAnyHost && !/(^|\.)fantasypros\.com$/i.test(abs.hostname)) continue;
    if (!out.includes(abs.toString())) out.push(abs.toString());
  }
  return out;
}

// Inside a minified bundle, API endpoints exist as string literals. Pull out
// path-looking strings that mention the draft/spa/ajax/screen machinery, any
// .jsp reference (with or without a leading slash — legacy code concatenates
// relative names), and every quoted string near a mockDraftKey usage: the
// code that attaches the key is the code that names the endpoint.
function mineBundlePaths(js) {
  const src = String(js || '');
  const out = [];
  const add = (p) => {
    if (!p || p.length > 100 || out.length >= 30) return;
    if (ASSET_RE.test(p)) return;
    if (!out.includes(p)) out.push(p);
  };
  let m;
  const absRe = /["'](\/[A-Za-z0-9_\-./]{2,80})["']/g;
  while ((m = absRe.exec(src))) {
    if (/draft|spa|ajax|mock|screen|pick/i.test(m[1])) add(m[1]);
  }
  const jspRe = /["']([A-Za-z0-9_\-./]{1,80}\.jsp[A-Za-z0-9_\-./?=&%~]{0,80})["']/g;
  while ((m = jspRe.exec(src))) add(m[1]);
  // ±250 chars around each mockDraftKey mention: harvest every quoted
  // path-ish string, keyword or not.
  let at = -1;
  while ((at = src.indexOf('mockDraftKey', at + 1)) !== -1) {
    const ctx = src.slice(Math.max(0, at - 250), at + 250);
    const ctxRe = /["']([A-Za-z0-9_\-./]{3,80})["']/g;
    let c;
    while ((c = ctxRe.exec(ctx))) {
      if (/[/.]/.test(c[1])) add(c[1]); // needs a slash or dot to be a path
    }
  }
  return out;
}

// --- URL discovery inside a fetched page -------------------------------------

const ASSET_RE = /\.(js|css|png|jpe?g|gif|svg|woff2?|ttf|ico|map)(\?|$)/i;

function discoverUrls(html, baseUrl, key, allowAnyHost) {
  const found = [];
  const seen = new Set();
  const re = /["']([^"'\s]{6,400}?(?:mockDraftKey|ajax|jayson|\.json|secondscreen|mock_draft|draft)[^"'\s]{0,200}?)["']/gi;
  let m;
  while ((m = re.exec(String(html || ''))) && found.length < 6) {
    let candidate = m[1];
    if (ASSET_RE.test(candidate)) continue;
    if (candidate.includes('{') || candidate.includes('<')) continue; // template, not a URL
    let abs;
    try { abs = new URL(candidate, baseUrl); } catch (e) { continue; }
    if (!/^https?:$/.test(abs.protocol)) continue;
    if (!allowAnyHost && !/(^|\.)fantasypros\.com$/i.test(abs.hostname)) continue;
    // A data endpoint that takes the key but doesn't have it yet gets it.
    if (key && !abs.searchParams.get('mockDraftKey') && /mockdraftkey/i.test(candidate)) {
      abs.searchParams.set('mockDraftKey', key);
    }
    const s = abs.toString();
    if (s === baseUrl || seen.has(s)) continue;
    seen.add(s);
    found.push(s);
  }
  return found;
}

// --- Normalization to Playbook's pick shape ----------------------------------

// rawPicks -> { picks, inferredMySlot, inferredLeagueSize }
function toPlaybookPicks(rawPicks, opts) {
  const leagueSize = num(opts && opts.leagueSize) || 12;
  const mySlot = num(opts && opts.mySlot) || null;
  const haveOverall = rawPicks.filter((p) => p.overall !== null).length >= rawPicks.length * 0.7;
  const list = rawPicks.map((p, i) => {
    const overall = haveOverall && p.overall !== null ? p.overall : i + 1;
    const round = p.round || Math.ceil(overall / leagueSize);
    const slotInRound = overall - (round - 1) * leagueSize;
    // Snake draft: even rounds run backwards.
    const draftSlot = p.slot ||
      (round % 2 === 1 ? slotInRound : leagueSize - slotInRound + 1);
    const name = p.position === 'DST' && !/dst$/i.test(p.name)
      ? clean(p.name) + ' DST'
      : clean(p.name);
    return {
      overallPick: overall,
      round,
      playerName: name,
      position: p.position === 'FLX' ? '' : p.position,
      nflTeam: p.team || '',
      draftSlot,
      isMyPick: p.mine === true,
    };
  });
  list.sort((a, b) => a.overallPick - b.overallPick);
  // If the data marked the user's picks, trust it and read the slot off round 1;
  // otherwise fall back to the my-slot the owner set in the form.
  const flagged = list.find((p) => p.isMyPick && p.round === 1);
  const inferredMySlot = flagged ? flagged.draftSlot : null;
  if (!list.some((p) => p.isMyPick) && mySlot) {
    for (const p of list) p.isMyPick = p.draftSlot === mySlot;
  }
  return { picks: list, inferredMySlot };
}

// --- Fetch orchestration ------------------------------------------------------

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  Accept: 'text/html,application/json;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

async function fetchText(url, fetchImpl, req) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const init = { headers: { ...BROWSER_HEADERS }, redirect: 'follow', signal: controller.signal };
    if (req && req.method === 'POST') {
      init.method = 'POST';
      init.body = req.body || '';
      init.headers['Content-Type'] = 'application/x-www-form-urlencoded';
    }
    const res = await fetchImpl(url, init);
    const body = await res.text();
    return { status: res.status, body };
  } finally {
    clearTimeout(timer);
  }
}

// Fetch the pasted URL, mine it (and the data URLs it references) for the
// draft. opts: { fetchImpl (tests), allowAnyHost (tests), leagueSize, mySlot }.
// Returns { picks, inferredMySlot, inferredLeagueSize, tried, captures } —
// captures holds what each URL actually sent (trimmed) so a failed attempt
// can be downloaded and debugged instead of guessed at.
async function fetchDraft(target, opts) {
  const o = opts || {};
  const fetchImpl = o.fetchImpl || fetch;
  const started = Date.now();
  const BUDGET_MS = 40000;
  const tried = [];
  const captures = [];
  // Queue entries: a string URL (GET) or { url, method, body } for POSTs.
  const urls = [target.url];
  const queued = new Set([target.url]);
  const bundles = new Set(); // .js bundles get MINED for paths, not extracted

  // A discovered data endpoint may expect the draft key under a different
  // query-param name — queue keyed variants alongside the original.
  const queueUrl = (u) => {
    if (queued.has(u)) return;
    queued.add(u);
    urls.push(u);
    if (target.key && !u.includes(target.key)) {
      for (const param of ['mockDraftKey', 'key']) {
        try {
          const v = new URL(u);
          v.searchParams.set(param, target.key);
          const s = v.toString();
          if (!queued.has(s)) { queued.add(s); urls.push(s); }
        } catch (e) { /* skip malformed */ }
      }
    }
  };

  let best = null;
  let config = null;
  let firstBody = '';
  for (let i = 0; i < urls.length && i < 32; i++) {
    if (Date.now() - started > BUDGET_MS) break;
    const req = typeof urls[i] === 'string' ? { url: urls[i] } : urls[i];
    const url = (req.method === 'POST' ? 'POST ' : '') + req.url + (req.body ? ' [' + req.body + ']' : '');
    let status = 0, body = '';
    try {
      const r = await fetchText(req.url, fetchImpl, req);
      status = r.status; body = r.body;
    } catch (e) {
      tried.push({ url, status: 0, note: e.name === 'AbortError' ? 'timed out' : e.message });
      continue;
    }
    const ok = status >= 200 && status < 300;

    if (bundles.has(req.url)) {
      // A JS bundle: harvest the API paths it references and try them keyed.
      // Relative names (no leading slash) resolve against the pasted page's
      // directory AND the site root — legacy JSP code uses both.
      const paths = ok ? mineBundlePaths(body) : [];
      tried.push({ url, status, note: 'bundle — ' + paths.length + ' paths mined' });
      // Keep the bundle source in the diagnostic: if this attempt fails, the
      // endpoint's true name is somewhere in this text.
      captures.push({ url, status, picks: 0, bundle: true, body: String(body).slice(0, 800 * 1024) });
      for (const p of paths) {
        try { queueUrl(new URL(p, target.url).toString()); } catch (e) { /* skip */ }
        if (!p.startsWith('/')) {
          try { queueUrl(new URL('/' + p, target.url).toString()); } catch (e) { /* skip */ }
        }
      }
      continue;
    }

    const found = ok ? extractDraft(body) : null;
    tried.push({ url, status, note: found ? found.picks.length + ' picks' : 'no picks found' });
    // Retention: the first page and anything that yielded picks are pinned;
    // pick-less responses get evicted oldest-first.
    captures.push({ url, status, picks: found ? found.picks.length : 0, body: String(body).slice(0, 300 * 1024) });
    if (captures.length > 10) {
      const evict = captures.findIndex((c, j) => j > 0 && !c.picks && !c.bundle);
      captures.splice(evict === -1 ? 1 : evict, 1);
    }
    if (found && found.picks.length >= 4) {
      if (!best || found.score > best.score) best = found;
      if (found.score >= 100) break; // deterministic state parse — done
      if (found.picks.length >= 12) break; // a real board — stop looking
    }
    // Only the first page (the one the owner pasted) seeds discovery. Order
    // matters — the crawl budget is finite: the draft-screen bundles (which
    // name the real endpoints) go first, then the page's config paths, and the
    // nav-page links last.
    if (i === 0 && ok) {
      firstBody = body;
      config = mineConfig(body);
      // Strongest lead first (learned from the second-screen bundle): the
      // /spaDraft command API. A bare key defaults to cmd=draft which STARTS
      // a new sim; resumeMock/checkSync load the recorded one. Try GET and
      // form-POST for each.
      if (target.key) {
        const origin = new URL(req.url).origin;
        const sport = (/^([a-z]+)~/.exec(target.key) || [])[1] || 'nfl';
        const cmdReqs = [];
        for (const cmd of ['resumeMock', 'checkSync']) {
          const qs = `cmd=${cmd}&mockDraftKey=${encodeURIComponent(target.key)}&format=json&sport=${sport}`;
          for (const base of ['/spaDraft', ...(config.urls.length ? config.urls : [])]) {
            const abs = new URL(base, origin).toString();
            if (!queued.has(abs + '?' + qs)) { queued.add(abs + '?' + qs); cmdReqs.push(abs + '?' + qs); }
            const postKey = 'POST ' + abs + ' ' + qs;
            if (!queued.has(postKey)) { queued.add(postKey); cmdReqs.push({ url: abs, method: 'POST', body: qs }); }
          }
        }
        urls.splice(1, 0, ...cmdReqs); // right after the page, ahead of everything
      }
      for (const b of findBundles(body, req.url, o.allowAnyHost)) {
        if (!queued.has(b)) { queued.add(b); bundles.add(b); urls.push(b); }
      }
      for (const p of config.urls) {
        try { queueUrl(new URL(p, req.url).toString()); } catch (e) { /* skip */ }
      }
      for (const u of discoverUrls(body, req.url, target.key, o.allowAnyHost)) queueUrl(u);
    }
  }

  const cfgLeague = config && config.teamCount && config.teamCount >= 4 && config.teamCount <= 24 ? config.teamCount : null;
  // userPos is a 0-based seat index -> 1-based draft slot.
  const cfgSlot = config && config.userPos !== null && config.userPos >= 0 ? config.userPos + 1 : null;
  if (!best) {
    return { picks: [], inferredMySlot: cfgSlot, inferredLeagueSize: cfgLeague, tried, captures };
  }

  // Id-only picks: resolve names through the site's PLAYER_DATA file, which
  // the page itself references (playersArray.jsp).
  if (best.picks.some((p) => !p.name && p.playerId)) {
    const m = /["']([^"']*playersArray\.jsp[^"']*)["']|src\s*=\s*['"]([^'"]*playersArray\.jsp[^'"]*)['"]/.exec(firstBody);
    const playersUrl = m ? (m[1] || m[2]) : null;
    if (playersUrl) {
      try {
        const abs = new URL(playersUrl, target.url).toString();
        const r = await fetchText(abs, fetchImpl);
        const map = r.status >= 200 && r.status < 300 ? buildPlayerMap(r.body) : {};
        tried.push({ url: abs, status: r.status, note: Object.keys(map).length + ' players mapped' });
        best.picks.forEach((p) => {
          if (!p.name && p.playerId && map[p.playerId]) {
            p.name = map[p.playerId].name;
            p.position = p.position || map[p.playerId].position;
            p.team = p.team || map[p.playerId].team;
          }
        });
      } catch (e) {
        tried.push({ url: playersUrl, status: 0, note: 'player map fetch failed: ' + e.message });
      }
    }
    best.picks = best.picks.filter((p) => p.name);
    if (!best.picks.length) {
      return { picks: [], inferredMySlot: cfgSlot, inferredLeagueSize: cfgLeague, tried, captures };
    }
  }
  const leagueSize = best.teamsLen || cfgLeague || num(o.leagueSize) || 12;
  // The page's own userPos is FantasyPros saying which seat was the owner's —
  // it outranks the form field (which sits at its default most of the time).
  const normalized = toPlaybookPicks(best.picks, { leagueSize, mySlot: cfgSlot || num(o.mySlot) });
  return {
    picks: normalized.picks,
    inferredMySlot: normalized.inferredMySlot || cfgSlot,
    inferredLeagueSize: best.teamsLen || cfgLeague,
    tried,
    captures,
  };
}

module.exports = {
  VERSION,
  parseTarget, extractDraft, discoverUrls, toPlaybookPicks, fetchDraft, jsonBlobs,
  mineConfig, findBundles, mineBundlePaths, parseSpaDraftState,
};
