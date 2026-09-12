// Underdog "rankings with IDs" support.
//
// Underdog's own Rankings page has a CSV download/upload. The downloaded file
// already contains every player with Underdog's exact per-contest player IDs:
//   "id","firstName","lastName","adp","projectedPoints","salary",
//   "positionRank","slotName","teamName","lineupStatus","byeWeek"
// The `id` (a UUID) is specific to that contest/season and changes over time,
// so we never hardcode IDs — the owner uploads the current file per contest and
// we match their ranked NAMES against it (via the canonical lib/players.js).
//
// Export strategy: reproduce the owner's known manual workflow (download →
// reorder rows → upload) automatically. We keep Underdog's exact header and
// every raw data line untouched, and only REORDER them: the owner's ranked
// players move to the top in their order, everyone else follows in the file's
// original order. Because we never re-serialize Underdog's own rows, the IDs and
// column formatting are preserved byte-for-byte — the file can't be rejected for
// missing players or altered columns.
const players = require('../../../lib/players');
const aliases = require('../../../lib/aliases');

// Minimal RFC-4180 field parser for a single CSV record (no embedded newlines —
// Underdog writes one player per line). Handles quoted fields and "" escapes.
function parseCsvLine(line) {
  const out = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') { field += '"'; i++; } // escaped quote
        else inQuotes = false;
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      out.push(field); field = '';
    } else {
      field += c;
    }
  }
  out.push(field);
  return out;
}

// Locate a column index by header name (case-insensitive), so the parser keeps
// working if Underdog reorders columns between seasons.
function colIndex(headers, name) {
  const want = name.toLowerCase();
  return headers.findIndex((h) => h.trim().toLowerCase() === want);
}

// Parse a raw Underdog CSV into { headerLine, rows, count } where each row keeps
// its original raw text plus the bits we match on. Throws a human-readable error
// if it doesn't look like an Underdog rankings file.
function parse(csvText) {
  if (!csvText || !String(csvText).trim()) {
    throw new Error('The Underdog file is empty.');
  }
  // Split into lines, tolerate \r\n or \n, drop a leading BOM and blank lines.
  const lines = String(csvText).replace(/^﻿/, '').split(/\r?\n/);
  let headerLine = null;
  const dataLines = [];
  for (const raw of lines) {
    if (!raw.trim()) continue;
    if (headerLine === null) headerLine = raw;
    else dataLines.push(raw);
  }
  if (headerLine === null) throw new Error('The Underdog file has no header row.');

  const headers = parseCsvLine(headerLine);
  const idIdx = colIndex(headers, 'id');
  const firstIdx = colIndex(headers, 'firstName');
  const lastIdx = colIndex(headers, 'lastName');
  const posIdx = colIndex(headers, 'slotName');
  const teamIdx = colIndex(headers, 'teamName');
  if (idIdx < 0 || firstIdx < 0 || lastIdx < 0) {
    throw new Error('That does not look like an Underdog rankings CSV — it needs "id", "firstName" and "lastName" columns. Download a fresh file from Underdog\'s Rankings page.');
  }

  const rows = [];
  for (const rawLine of dataLines) {
    const fields = parseCsvLine(rawLine);
    const first = (fields[firstIdx] || '').trim();
    const last = (fields[lastIdx] || '').trim();
    const id = (fields[idIdx] || '').trim();
    const name = `${first} ${last}`.trim();
    if (!name) continue; // skip stray/blank rows
    const position = posIdx >= 0 ? (fields[posIdx] || '').trim() : '';
    const team = teamIdx >= 0 ? (fields[teamIdx] || '').trim() : '';
    rows.push({ rawLine, name, id, position, team });
  }
  return { headerLine, rows, count: rows.length };
}

// Validate + summarize an uploaded file (for the "save this Underdog file" step).
// Returns { count } or throws a human-readable error.
function summarize(csvText) {
  const { count } = parse(csvText);
  if (!count) throw new Error('No players were found in that Underdog file.');
  return { count };
}


// --- Matching --------------------------------------------------------------
// The name engine anchors on the LAST name because it was built for OCR-garbled
// screenshots against a full-league roster. An Underdog file is a different
// animal: it is one contest's pool, and a 4-team slate holds ~100 players. In a
// pool that small a unique last name proves nothing — "Bijan Robinson" must not
// resolve to Demarcus Robinson just because he is the only Robinson on the
// slate, and that is exactly how wrong players ended up at the top of the
// upload. So here a full-name match (exact / spaceless / alias) stands on its
// own, while any last-name-anchored or edit-distance match must ALSO agree on
// the first name and, when both sides publish one, the position. A miss is
// visible (the owner sees "not in the Underdog file"); a wrong hit is silent.
const FULL_NAME_VIAS = new Set(['exact', 'compact', 'alias']);

// Index Underdog's players for matching. Every row is indexed under the name
// Underdog prints AND, when that name is a known nickname, under its canonical
// too: the alias table maps variant -> canonical ("Hollywood Brown" ->
// "Marquise Brown"), which resolves a ranking that uses the nickname — but here
// it is UNDERDOG that prints the nickname while the rankings use the legal
// name. Real names are indexed first, so a genuine player always outranks
// someone else's alias.
function buildIndex(rows) {
  const items = rows.map((r, i) => ({ name: r.name, idx: i }));
  for (let i = 0; i < rows.length; i++) {
    const canonical = aliases.MAP.get(players.key(rows[i].name));
    if (canonical) items.push({ name: canonical, idx: i });
  }
  return players.buildNameIndex(items, { aliases: aliases.MAP });
}

function normPos(p) {
  // FantasyPros publishes the ordinal in the position ("RB12"): strip it.
  const s = String(p || '').trim().toUpperCase().replace(/\d+$/, '');
  if (!s) return '';
  if (s === 'PK') return 'K';
  if (s === 'DEF' || s === 'D/ST' || s === 'DST') return 'DST';
  return s;
}

function positionsAgree(a, b) {
  const x = normPos(a), y = normPos(b);
  return !x || !y || x === y;
}

function firstNamesAgree(a, b) {
  const fa = players.key(a).split(' ')[0] || '';
  const fb = players.key(b).split(' ')[0] || '';
  if (!fa || !fb) return false;
  if (fa === fb) return true;
  // "Ken" / "Kenneth", "Cam" / "Cameron" — one is a prefix of the other.
  if (fa.length >= 3 && fb.length >= 3 && (fa.startsWith(fb) || fb.startsWith(fa))) return true;
  // "Drew" / "Andrew" — the short form is the TAIL of the long one. Held to 4+
  // characters so a coincidence like "Ian" inside "Brian" cannot qualify; the
  // last name and the position still have to agree for this to be reached.
  if (fa.length >= 4 && fb.length >= 4 && (fa.endsWith(fb) || fb.endsWith(fa))) return true;
  // A single typo in a real first name ("Jaxon" / "Jaxson").
  return fa.length >= 4 && fb.length >= 4 && players.editDistance(fa, fb) <= 1;
}

// Resolve one ranked player against the parsed Underdog rows. Returns
// { idx, positionMismatch } for a trustworthy match, or null when nothing is
// safe enough to put in an upload.
function resolveRow(index, rows, p) {
  const name = players.display((p && p.name) || '');
  if (!name) return null;
  const m = players.matchName(name, index);
  if (!m.entry) return null;
  const row = rows[m.entry.idx];
  const agree = positionsAgree(p && p.position, row.position);
  if (FULL_NAME_VIAS.has(m.via)) {
    // The full name IS the identity, and one contest pool never lists the same
    // full name twice. Two sources disagreeing about a position is ordinary (a
    // move tight end filed under WR on one site), so the match stands and the
    // disagreement is REPORTED rather than costing a real player his slot.
    return { idx: m.entry.idx, positionMismatch: !agree };
  }
  // Anchored on the last name alone, so it must clear BOTH bars.
  if (!agree || !firstNamesAgree(name, row.name)) return null;
  return { idx: m.entry.idx, positionMismatch: false };
}

// Build the reordered Underdog CSV for a ranked list of the owner's players.
//   csvText     the stored Underdog file (one contest's download)
//   rankedList  the owner's list in rank order: [{ name, position? }, ...]
// Returns { csv, total, matched, unmatched } where unmatched is the list of the
// owner's names that had no Underdog row (so they can fix spelling).
function buildExport(csvText, rankedList) {
  const { headerLine, rows } = parse(csvText);
  const index = buildIndex(rows);

  const used = new Set();
  const orderedTop = [];
  const unmatched = [];
  const flagged = [];
  let matched = 0;

  for (const p of (rankedList || [])) {
    const name = players.display((p && p.name) || '');
    if (!name) continue;
    const hit = resolveRow(index, rows, p);
    if (hit && !used.has(hit.idx)) {
      used.add(hit.idx);
      orderedTop.push(rows[hit.idx].rawLine);
      matched++;
      if (hit.positionMismatch) {
        flagged.push({
          name, underdog_name: rows[hit.idx].name,
          ranked_position: String((p && p.position) || '').trim(),
          underdog_position: rows[hit.idx].position,
        });
      }
    } else if (!hit) {
      unmatched.push(name);
    }
    // (hit already used = the owner listed the same player twice — silently skip)
  }

  // Everyone the owner didn't rank keeps Underdog's original order, after the top.
  const rest = [];
  for (let i = 0; i < rows.length; i++) {
    if (!used.has(i)) rest.push(rows[i].rawLine);
  }

  // BOM + CRLF to match Underdog's own file and open cleanly in Excel/Sheets.
  const body = [headerLine, ...orderedTop, ...rest].join('\r\n');
  const csv = '﻿' + body + '\r\n';
  return { csv, total: rows.length, matched, unmatched, flagged };
}

// Live match report for a ranked list against a stored Underdog file, WITHOUT
// building the export. Used to show inline match status while editing. Returns
//   { total, matched, unmatched: [{ name, suggestion }] }
// where suggestion is the closest Underdog name for a miss (or null), so the UI
// can offer a one-click "did you mean?" fix.
function matchReport(csvText, rankedList) {
  const { rows } = parse(csvText);
  const index = buildIndex(rows);
  const compacts = rows.map((r) => ({ name: r.name, compact: players.compactKey(r.name) }));

  const used = new Set();
  const unmatched = [];
  let matched = 0;

  for (const p of (rankedList || [])) {
    const name = players.display((p && p.name) || '');
    if (!name) continue;
    const hit = resolveRow(index, rows, p);
    if (hit && !used.has(hit.idx)) { used.add(hit.idx); matched++; continue; }
    if (hit) continue; // duplicate of an already-matched player — ignore

    // No match: suggest the nearest Underdog name by compact-key edit distance.
    const mc = players.compactKey(name);
    let best = null, bestD = Infinity;
    for (const c of compacts) {
      if (Math.abs(c.compact.length - mc.length) > 3) continue;
      const d = players.editDistance(mc, c.compact);
      if (d < bestD) { bestD = d; best = c.name; }
    }
    const thresh = Math.max(2, Math.floor(mc.length / 4));
    unmatched.push({ name, suggestion: (best && bestD <= thresh) ? best : null });
  }
  return { total: rows.length, matched, unmatched };
}

module.exports = { parse, summarize, buildExport, matchReport, resolveRow, buildIndex, parseCsvLine };
