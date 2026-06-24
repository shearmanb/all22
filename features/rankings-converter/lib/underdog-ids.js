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
    rows.push({ rawLine, name, id });
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

// Build the reordered Underdog CSV for a ranked list of the owner's players.
//   csvText     the stored Underdog file (one contest's download)
//   rankedList  the owner's list in rank order: [{ name }, ...]
// Returns { csv, total, matched, unmatched } where unmatched is the list of the
// owner's names that had no Underdog row (so they can fix spelling).
function buildExport(csvText, rankedList) {
  const { headerLine, rows } = parse(csvText);

  // Canonical name index over Underdog's players (tolerant matching).
  const index = players.buildNameIndex(rows.map((r, i) => ({ name: r.name, idx: i })));

  const used = new Set();
  const orderedTop = [];
  const unmatched = [];
  let matched = 0;

  for (const p of (rankedList || [])) {
    const name = players.display((p && p.name) || '');
    if (!name) continue;
    const hit = players.findName(name, index);
    if (hit && !used.has(hit.idx)) {
      used.add(hit.idx);
      orderedTop.push(rows[hit.idx].rawLine);
      matched++;
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
  return { csv, total: rows.length, matched, unmatched };
}

module.exports = { parse, summarize, buildExport, parseCsvLine };
