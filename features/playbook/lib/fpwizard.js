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
    const parsed = tryJson(src.slice(start, end + 1));
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

// Turn one array element into a raw pick, or null if it doesn't look like one.
function readPick(el) {
  if (!el || typeof el !== 'object' || Array.isArray(el)) return null;
  const name = pickName(el);
  if (!name || name.length > 60) return null;
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

// Walk a JSON tree and return the most pick-like array found, plus a guess at
// the league size from any team-list array alongside it.
function huntPicks(root) {
  let best = null;
  let teamsLen = null;
  const queue = [root];
  let visited = 0;
  while (queue.length && visited < 5000) {
    const node = queue.shift();
    visited++;
    if (!node || typeof node !== 'object') continue;
    if (Array.isArray(node)) {
      if (node.length >= 4 && node.length <= 600) {
        const sample = node.slice(0, 40);
        const reads = sample.map(readPick);
        const named = reads.filter(Boolean);
        if (named.length / sample.length >= 0.7) {
          const withInfo = named.filter((p) => p.hasPickInfo).length;
          const withPos = named.filter((p) => p.position).length;
          // Pick arrays carry pick numbers and/or positions; a plain roster of
          // team names carries neither.
          if (withInfo || withPos >= named.length * 0.5) {
            const score = named.length / sample.length + (withInfo ? 1 : 0) +
              (withPos / Math.max(1, named.length)) + Math.min(1, node.length / 100);
            if (!best || score > best.score) best = { arr: node, score };
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
  if (!best) return null;
  return { picks: best.arr.map(readPick).filter(Boolean), teamsLen, score: best.score };
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
  let best = null;
  for (const root of roots) {
    const found = huntPicks(root);
    if (found && found.picks.length && (!best || found.score > best.score)) best = found;
  }
  return best;
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

async function fetchText(url, fetchImpl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const res = await fetchImpl(url, { headers: BROWSER_HEADERS, redirect: 'follow', signal: controller.signal });
    const body = await res.text();
    return { status: res.status, body };
  } finally {
    clearTimeout(timer);
  }
}

// Fetch the pasted URL, mine it (and up to 6 data URLs it references) for the
// draft. opts: { fetchImpl (tests), allowAnyHost (tests), leagueSize, mySlot }.
// Returns { picks, inferredMySlot, inferredLeagueSize, tried: [{url, status, note}] }.
async function fetchDraft(target, opts) {
  const o = opts || {};
  const fetchImpl = o.fetchImpl || fetch;
  const tried = [];
  const urls = [target.url];
  const queued = new Set(urls);

  let best = null;
  for (let i = 0; i < urls.length && i < 8; i++) {
    const url = urls[i];
    let status = 0, body = '';
    try {
      const r = await fetchText(url, fetchImpl);
      status = r.status; body = r.body;
    } catch (e) {
      tried.push({ url, status: 0, note: e.name === 'AbortError' ? 'timed out' : e.message });
      continue;
    }
    const found = status >= 200 && status < 300 ? extractDraft(body) : null;
    tried.push({ url, status, note: found ? found.picks.length + ' picks' : 'no picks found' });
    if (found && found.picks.length >= 4) {
      if (!best || found.score > best.score) best = found;
      if (found.picks.length >= 12) break; // a real board — stop looking
    }
    // Only the first page (the one the owner pasted) seeds discovery.
    if (i === 0 && status >= 200 && status < 300) {
      for (const u of discoverUrls(body, url, target.key, o.allowAnyHost)) {
        if (!queued.has(u)) { queued.add(u); urls.push(u); }
      }
    }
  }

  if (!best) return { picks: [], inferredMySlot: null, inferredLeagueSize: null, tried };
  const leagueSize = best.teamsLen || num(o.leagueSize) || 12;
  const normalized = toPlaybookPicks(best.picks, { leagueSize, mySlot: o.mySlot });
  return {
    picks: normalized.picks,
    inferredMySlot: normalized.inferredMySlot,
    inferredLeagueSize: best.teamsLen || null,
    tried,
  };
}

module.exports = { parseTarget, extractDraft, discoverUrls, toPlaybookPicks, fetchDraft, jsonBlobs };
