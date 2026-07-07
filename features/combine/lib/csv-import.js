// csv-import.js — turn an uploaded CSV / spreadsheet export (FantasyPros CSV,
// Excel "Save As CSV", or a pasted spreadsheet range) into the same row shape
// the OCR/paste paths produce: [{ rank?, name, position?, team?, auction_value? }].
//
// Pure + dependency-free: parses CSV/TSV text and auto-detects which columns are
// the name / position / team / rank / auction value by their header labels, so
// the owner doesn't hand-map columns. The rows then go through the SAME
// players_master matching pipeline as every other input (lib/ingest.js).
//
// Native .xlsx is NOT handled here (it's a binary zip that needs a library);
// the owner saves those as CSV first.

// Split CSV/TSV text into an array of string-cell rows. Handles quoted fields
// with embedded delimiters/newlines and "" escapes. Delimiter is auto-detected
// per file (tab when the header has more tabs than commas — i.e. pasted from a
// spreadsheet — otherwise comma).
function parseTable(text) {
  const s = String(text || '');
  const firstLine = s.split(/\r?\n/, 1)[0] || '';
  const delim = (firstLine.split('\t').length > firstLine.split(',').length) ? '\t' : ',';
  const rows = [];
  let field = '', row = [], inQuotes = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === delim) {
      row.push(field); field = '';
    } else if (c === '\n') {
      row.push(field); rows.push(row); row = []; field = '';
    } else if (c !== '\r') {
      field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  // Drop rows that are entirely blank.
  return rows.filter((r) => r.some((x) => String(x).trim() !== ''));
}

// Detect column indices from a header row. Returns -1 for any column not found.
function detectColumns(header) {
  const h = header.map((x) => String(x).trim().toLowerCase());
  const find = (re, avoid) => {
    for (let i = 0; i < h.length; i++) {
      if (re.test(h[i]) && !(avoid && avoid.test(h[i]))) return i;
    }
    return -1;
  };
  let name = find(/player/);
  if (name < 0) name = find(/\bname\b|full ?name/, /team/);
  return {
    name,
    pos: find(/\bpos\b|position/),
    team: find(/\bteam\b|\btm\b/, /player/),
    rank: find(/\brk\b|\brank\b|\boverall\b|\bovr\b|^#$/),
    auction: find(/\$|auction|\baav\b|salary|price|\bvalue\b|\bcost\b|\bbudget\b/),
  };
}

function cleanAuction(raw) {
  const s = String(raw == null ? '' : raw).replace(/[$,\s]/g, '');
  if (s === '') return null;
  const v = Number(s);
  return Number.isFinite(v) ? v : null;
}

// Parse full CSV text into matched-pipeline input rows + the detected mapping.
// Returns { rows, mapping, headerFound }.
function importCsv(text) {
  const table = parseTable(text);
  if (!table.length) return { rows: [], mapping: {}, headerFound: false };

  // Find the header row: the first of the first few rows that has a name column
  // (real exports sometimes carry a title/blank line above the header).
  let headerIdx = -1, mapping = null;
  for (let i = 0; i < Math.min(8, table.length); i++) {
    const m = detectColumns(table[i]);
    if (m.name >= 0) { headerIdx = i; mapping = m; break; }
  }

  let dataRows, map;
  if (headerIdx >= 0) {
    dataRows = table.slice(headerIdx + 1);
    map = mapping;
  } else {
    // No recognizable header — treat it as a bare one-name-per-line list.
    dataRows = table;
    map = { name: 0, pos: -1, team: -1, rank: -1, auction: -1 };
  }

  const rows = [];
  for (const r of dataRows) {
    const name = String(r[map.name] || '').trim();
    if (!name) continue;
    // Skip a repeated header line that slipped into the data.
    if (/^(player|name)\b/i.test(name)) continue;
    const out = { name };
    if (map.pos >= 0) out.position = String(r[map.pos] || '').trim();
    if (map.team >= 0) out.team = String(r[map.team] || '').trim();
    if (map.rank >= 0) {
      const n = parseInt(String(r[map.rank] || '').replace(/[^0-9]/g, ''), 10);
      if (Number.isFinite(n)) out.rank = n;
    }
    if (map.auction >= 0) out.auction_value = cleanAuction(r[map.auction]);
    rows.push(out);
  }
  return { rows, mapping: map, headerFound: headerIdx >= 0 };
}

// Human-readable list of which fields were detected (for the UI note).
function detectedFields(mapping) {
  const out = [];
  if (mapping.name >= 0) out.push('name');
  if (mapping.pos >= 0) out.push('position');
  if (mapping.team >= 0) out.push('team');
  if (mapping.rank >= 0) out.push('rank');
  if (mapping.auction >= 0) out.push('auction $');
  return out;
}

module.exports = { importCsv, parseTable, detectColumns, detectedFields };
