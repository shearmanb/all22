// fetch-rankings.js — pull expert consensus rankings straight from a
// FantasyPros rankings URL, replacing copy/paste for the most common source.
//
// FantasyPros embeds the full payload in the page as `var ecrData = {...};`
// (verified July 2026). We fetch the HTML with a plain browser-ish UA, find
// that assignment with a balanced-brace scan (never a fragile regex over the
// whole object), JSON.parse it, and hand the players to the same ingest
// pipeline every other source uses. No API key, no login. If FantasyPros
// changes the page or blocks the fetch, the error is loud and paste/CSV stays
// the fallback — same philosophy as Playbook's fpwizard.
//
// The URL also tells us the set's identity (never guessed silently — the
// owner sees and can override before saving):
//   ...ppr-cheatsheets.php            -> ppr, overall
//   ...half-point-ppr-cheatsheets.php -> half, overall
//   ...consensus-cheatsheets.php      -> standard, overall
//   ...superflex-cheatsheets.php      -> superflex, overall
//   ...best-ball-overall.php          -> best_ball, overall
//   ...qb-cheatsheets.php / qb.php    -> positional (one position block)

const FETCH_TIMEOUT_MS = 20000;
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

// Accepts a fantasypros.com rankings URL. Returns a normalized https URL
// string or null when it's clearly not a supported page.
function parseTarget(input) {
  const s = String(input || '').trim();
  if (!s) return null;
  let u;
  try { u = new URL(s.includes('://') ? s : 'https://' + s); } catch (e) { return null; }
  if (!/(^|\.)fantasypros\.com$/i.test(u.hostname)) return null;
  u.protocol = 'https:';
  return u.toString();
}

// What the URL says the list IS (format + scope + a name suggestion).
function inferMeta(url) {
  const path = String(url).toLowerCase();
  const file = (path.split('/').pop() || '').replace(/\.php.*$/, '');
  let format = 'unknown';
  if (file.includes('half-point-ppr') || file.includes('half-ppr')) format = 'half';
  else if (file.includes('superflex') || file.includes('op')) format = 'superflex';
  else if (file.includes('best-ball')) format = 'best_ball';
  else if (file.includes('ppr')) format = 'ppr';
  else if (file.includes('consensus') || file.includes('cheatsheet')) format = 'standard';
  // A single position in the filename means a one-position list.
  const posMatch = /(?:^|-)(qb|rb|wr|te|k|dst|def|flex)(?:-|$)/.exec(file);
  const scope = posMatch && !file.includes('overall') ? 'positional' : 'overall';
  const stamp = new Date().toISOString().slice(0, 10);
  return {
    format,
    scope,
    source: 'FantasyPros ECR',
    name: `FantasyPros ECR${posMatch ? ' ' + posMatch[1].toUpperCase() : ''} ${stamp}`,
  };
}

// Trust the page's own scoring declaration over the URL when present — but
// never demote the URL's superflex/best_ball identity (a best-ball page
// declares PPR scoring because best ball IS ppr-scored; the format the list
// was published FOR stays best_ball; same for superflex).
function applyPageScoring(format, scoring) {
  if (['superflex', 'best_ball'].includes(format)) return format;
  const s = String(scoring || '').toUpperCase();
  if (s === 'PPR') return 'ppr';
  if (s === 'HALF') return 'half';
  if (s === 'STD') return 'standard';
  return format;
}

// Balanced-brace end scan (same approach as fpwizard's hunter).
function balancedEnd(src, start) {
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
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// Find `ecrData = { ... }` in the page and parse it. Null when absent.
function extractEcrData(html) {
  const src = String(html || '');
  const re = /ecrData\s*=\s*\{/g;
  let m;
  while ((m = re.exec(src))) {
    const start = m.index + m[0].length - 1;
    const end = balancedEnd(src, start);
    if (end === -1) continue;
    try {
      const parsed = JSON.parse(src.slice(start, end + 1));
      if (parsed && Array.isArray(parsed.players)) return parsed;
    } catch (e) { /* keep hunting */ }
  }
  return null;
}

// ecrData -> rows for the ingest pipeline, in consensus order.
function rowsFromEcr(data) {
  const players = (data.players || [])
    .filter((p) => p && p.player_name)
    .slice()
    .sort((a, b) => (Number(a.rank_ecr) || 1e9) - (Number(b.rank_ecr) || 1e9));
  return players.map((p) => ({
    name: String(p.player_name),
    position: String(p.player_position_id || '').toUpperCase().replace('DEF', 'DST'),
    team: String(p.player_team_id || '').toUpperCase(),
  }));
}

// Fetch + extract. Returns { rows, meta } or throws a human-readable error.
async function fetchRankings(input) {
  const url = parseTarget(input);
  if (!url) {
    throw new Error('That does not look like a fantasypros.com rankings link. Paste a URL like https://www.fantasypros.com/nfl/rankings/ppr-cheatsheets.php');
  }
  const res = await fetch(url, {
    headers: {
      'user-agent': USER_AGENT,
      accept: 'text/html,application/xhtml+xml',
      'accept-language': 'en-US,en;q=0.9',
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    redirect: 'follow',
  });
  if (!res.ok) {
    throw new Error(`FantasyPros responded ${res.status} — the page may be blocking automated fetches right now. Paste the rankings as text instead.`);
  }
  const html = await res.text();
  const data = extractEcrData(html);
  if (!data) {
    throw new Error('Could not find the rankings data on that page (FantasyPros may have changed their layout). Paste the rankings as text instead.');
  }
  const rows = rowsFromEcr(data);
  if (!rows.length) throw new Error('The page parsed but held no players — is it an empty/preseason list?');
  const meta = inferMeta(url);
  meta.format = applyPageScoring(meta.format, data.scoring);
  return {
    rows,
    meta: Object.assign(meta, {
      url,
      count: rows.length,
      total_experts: data.total_experts || null,
      last_updated: data.last_updated || null,
    }),
  };
}

module.exports = { parseTarget, inferMeta, applyPageScoring, extractEcrData, rowsFromEcr, fetchRankings };
