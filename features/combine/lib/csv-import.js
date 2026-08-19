// csv-import.js — turn an uploaded CSV / spreadsheet export (FantasyPros CSV,
// Excel "Save As CSV", or a pasted spreadsheet range) into the same row shape
// the OCR/paste paths produce:
// [{ rank?, name, position?, team?, auction_value?, notes? }].
//
// Pure + dependency-free: parses CSV/TSV text and auto-detects which columns are
// the name / position / team / rank / auction value / notes by their header
// labels — or, when the paste has no header, by what the cells look like — so
// the owner doesn't hand-map columns. The rows then go through the SAME
// players_master matching pipeline as every other input (lib/ingest.js).
//
// Native .xlsx is NOT handled here (it's a binary zip that needs a library);
// the owner saves those as CSV first.

const players = require('../../../lib/players');

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
    notes: find(/\bnotes?\b|\bcomments?\b|\banalysis\b|\bblurb\b|\bthoughts?\b|\btake\b|\bwhy\b|\bremarks?\b/),
    // Bye week is deliberately identified so it can be THROWN AWAY: it's the
    // one extra column that carries nothing the owner wants on a player.
    bye: find(/\bbye\b/),
    // The header row verbatim — extra columns are folded into the note under
    // their own label ("Auction Rk: 12"), so nothing else is silently dropped.
    labels: header.map((x) => String(x == null ? '' : x).trim()),
  };
}

// Tidy a header label for use in a note: "AUCTION RK" -> "Auction Rk",
// "$$$" -> "$$$". All-caps shouting reads badly next to prose.
function labelText(raw) {
  const s = String(raw || '').trim().replace(/\s+/g, ' ');
  if (!s) return '';
  if (s === s.toUpperCase() && /[a-z]/i.test(s)) {
    return s.toLowerCase().replace(/\b([a-z])/g, (m, c) => c.toUpperCase());
  }
  return s;
}

// Every column that isn't already a field of its own, minus bye week, rendered
// as "Label: value" note fragments. This is how an auction-rank / tier / ADP /
// projection column survives ingest instead of being thrown away.
function extraNotes(row, map) {
  const claimed = new Set([map.name, map.pos, map.team, map.rank, map.auction, map.notes, map.bye]);
  const labels = map.labels || [];
  const out = [];
  for (let i = 0; i < row.length; i++) {
    if (claimed.has(i)) continue;
    const value = String(row[i] == null ? '' : row[i]).trim();
    if (!value) continue;
    const label = labelText(labels[i]);
    // With no header there is nothing to call the column, and an unlabelled
    // stray number ("6", "11") is exactly the bye-week noise we don't want.
    if (!label) {
      if (/^[-+$]?\d{1,4}(\.\d+)?%?$/.test(value)) continue;
      out.push(value);
      continue;
    }
    out.push(label + ': ' + value);
  }
  return out;
}

// Infer columns from the DATA when there's no recognizable header row — a
// spreadsheet range pasted without its header, e.g. "1 | Jahmyr Gibbs | RB |
// DET | 6 | $60". Each column is scored by what its cells actually look like,
// using the canonical name/position/team helpers (never a second name engine).
function inferColumns(dataRows) {
  const sample = dataRows.slice(0, 40);
  const width = sample.reduce((w, r) => Math.max(w, r.length), 0);
  const map = { name: -1, pos: -1, team: -1, rank: -1, auction: -1, notes: -1, bye: -1, labels: [] };
  if (!width) return map;

  const cells = (i) => sample.map((r) => String(r[i] == null ? '' : r[i]).trim());
  const share = (list, fn) => {
    const filled = list.filter((c) => c !== '');
    return filled.length ? filled.filter(fn).length / filled.length : 0;
  };
  const isInt = (c) => /^\d{1,4}$/.test(c);
  // A name cell: has letters, and isn't a lone position/team token.
  const isNameish = (c) => /[a-z]{2}/i.test(c) && !players.isPosition(c) && !players.teamFromToken(c) &&
    !/^\$/.test(c) && c.split(/\s+/).length <= 6;

  const cols = [];
  for (let i = 0; i < width; i++) {
    const list = cells(i);
    cols.push({
      i,
      list,
      pos: share(list, (c) => players.isPosition(c)),
      team: share(list, (c) => !!players.teamFromToken(c)),
      money: share(list, (c) => /^\$/.test(c)),
      int: share(list, isInt),
      nameish: share(list, isNameish),
      multiword: share(list, (c) => /[a-z]{2}/i.test(c) && c.split(/\s+/).length >= 2),
      longtext: share(list, (c) => c.split(/\s+/).length >= 4),
    });
  }
  const taken = new Set();
  const claim = (key, candidates) => {
    const best = candidates.filter((c) => !taken.has(c.i))[0];
    if (best) { map[key] = best.i; taken.add(best.i); }
  };
  const by = (fn) => cols.slice().sort((a, b) => fn(b) - fn(a));

  claim('pos', by((c) => c.pos).filter((c) => c.pos >= 0.6));
  claim('team', by((c) => c.team).filter((c) => c.team >= 0.6));
  // The name column is the most multi-word text column left.
  claim('name', by((c) => c.multiword * 2 + c.nameish).filter((c) => c.nameish >= 0.6 && c.multiword >= 0.4));
  if (map.name < 0) claim('name', by((c) => c.nameish).filter((c) => c.nameish >= 0.6));
  claim('auction', by((c) => c.money).filter((c) => c.money >= 0.5));
  // Rank = the leftmost all-integer column (bye weeks and projections sit to
  // the right of the name; the rank column is the one before it).
  claim('rank', cols.filter((c) => !taken.has(c.i) && c.int >= 0.8 && (map.name < 0 || c.i < map.name)));
  // Notes = a leftover wordy column (4+ words on most rows).
  claim('notes', by((c) => c.longtext).filter((c) => c.longtext >= 0.5));
  return map;
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
    // No recognizable header. Multi-column data still tells us what each column
    // is; a single-column file is a bare one-name-per-line list.
    dataRows = table;
    map = table.some((r) => r.length > 1)
      ? inferColumns(table)
      : { name: 0, pos: -1, team: -1, rank: -1, auction: -1, notes: -1, bye: -1, labels: [] };
    if (map.name < 0) map = Object.assign(map, { name: 0 });
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
    // The note is the source's own comment column plus every other column it
    // published (auction rank, tier, ADP…), labelled. Bye week is dropped.
    const noteParts = [];
    if (map.notes >= 0) {
      const note = String(r[map.notes] || '').trim();
      if (note) noteParts.push(note);
    }
    for (const extra of extraNotes(r, map)) noteParts.push(extra);
    if (noteParts.length) out.notes = noteParts.join(' · ');
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
  if (mapping.notes >= 0) out.push('notes');
  return out;
}

module.exports = { importCsv, parseTable, detectColumns, inferColumns, extraNotes, detectedFields };
