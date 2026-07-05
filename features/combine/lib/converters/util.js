// Shared CSV helpers for the converters. Plain RFC-4180-ish CSV that opens
// cleanly in Excel and Google Sheets (no xlsx library — owner chose CSV).

function csvEscape(value) {
  const s = value === null || value === undefined ? '' : String(value);
  if (/[",\r\n]/.test(s)) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

// rows: array of arrays. Returns a CSV string with a trailing newline.
// A leading BOM makes Excel open UTF-8 names (e.g. accents) correctly.
function toCsv(headers, rows) {
  const lines = [];
  if (headers && headers.length) lines.push(headers.map(csvEscape).join(','));
  for (const row of rows) lines.push(row.map(csvEscape).join(','));
  return '﻿' + lines.join('\r\n') + '\r\n';
}

// Split a display name into first / last for sites that want separate columns.
// Single-token names (e.g. a defense like "49ers") go entirely in "last".
function splitName(name) {
  const parts = String(name || '').trim().split(/\s+/);
  if (parts.length <= 1) return { first: '', last: parts[0] || '' };
  return { first: parts[0], last: parts.slice(1).join(' ') };
}

module.exports = { csvEscape, toCsv, splitName };
