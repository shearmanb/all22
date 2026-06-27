// Build the self-contained "All22 → Yahoo" bookmarklet.
//
// A bookmarklet is a `javascript:` URL the owner keeps on his bookmarks bar.
// Clicking it on Yahoo's "Edit Pre-Draft Player Rankings" page runs our engine
// against that page. We make it SELF-CONTAINED (no external <script> or fetch)
// for two reasons: it keeps working offline/forever, and it sidesteps Yahoo's
// Content-Security-Policy, which can block an injected remote script.
//
// What gets inlined, in order, inside one IIFE:
//   1. lib/players.js  — the CANONICAL name matcher, wrapped in a tiny CommonJS
//      shim so its `module.exports` resolves in the browser. We never re-implement
//      name logic here; we embed the real module's source verbatim.
//   2. ALL22Players / ALL22Names globals — the matcher exports and the owner's
//      ranked names.
//   3. yahoo-prerank-engine.js — the page-driving engine (serialized from its
//      real function source).
const fs = require('fs');
const path = require('path');

const PLAYERS_SRC_PATH = path.join(__dirname, '..', '..', '..', 'lib', 'players.js');
const engineFn = require('./yahoo-prerank-engine');

// Read the canonical matcher's source once at startup. If it ever fails we throw
// at build time with a clear message rather than emitting a broken bookmarklet.
let playersSrc = null;
function loadPlayersSrc() {
  if (playersSrc == null) {
    playersSrc = fs.readFileSync(PLAYERS_SRC_PATH, 'utf8');
  }
  return playersSrc;
}

// Shrink inlined source for the bookmarklet WITHOUT a minifier dependency.
// Deliberately conservative: drop only whole-line `//` comments and blank lines,
// and never alter the CONTENT of a kept line. Newlines are preserved, so
// automatic-semicolon-insertion is unchanged, and (unlike trimming indentation)
// this can't corrupt a multi-line template literal a future edit might add.
function stripForEmbed(src) {
  return String(src)
    .split('\n')
    .filter((line) => line.trim() && !line.trim().startsWith('//'))
    .join('\n');
}

// Reduce the owner's list to just what the engine needs, in rank order.
function slimList(list) {
  return (Array.isArray(list) ? list : [])
    .filter((p) => p && (p.name || '').trim())
    .map((p) => ({
      name: String(p.name).trim(),
      position: (p.position || '').toString().toUpperCase().replace(/\./g, ''),
      team: (p.team || '').toString().toUpperCase().replace(/\./g, ''),
      rank: p.rank || null,
    }));
}

// Build the raw (decoded) JavaScript program the bookmarklet runs.
function buildProgram(list) {
  const names = slimList(list);
  const src = stripForEmbed(loadPlayersSrc());
  const engine = stripForEmbed('(' + engineFn.toString() + ')();');
  return (
    '(function(){' +
      'try{' +
        'var module={exports:{}};\n' +
        src + '\n' +
        'var ALL22Players=module.exports;' +
        'var ALL22Names=' + JSON.stringify(names) + ';\n' +
        engine +
      '\n}catch(e){alert("All22 bookmarklet error: "+(e&&e.message?e.message:e));}' +
    '})();'
  );
}

// Build the `javascript:` bookmarklet URL. encodeURIComponent keeps quotes,
// spaces, newlines and unicode intact through the address/bookmark layer.
function build(list) {
  const program = buildProgram(list);
  const href = 'javascript:' + encodeURIComponent(program);
  return {
    href,
    count: slimList(list).length,
    bytes: Buffer.byteLength(href, 'utf8'),
  };
}

module.exports = { build, buildProgram, slimList };
