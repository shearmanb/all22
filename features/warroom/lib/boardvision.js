// boardvision.js — a photo of the physical draft board -> the cells Claude can
// read in it.
//
// The board on the wall is the source of truth; the app is a transcription of
// it. This is how the owner checks the transcription: photograph the board,
// read the stickers, and (in boarddiff.js) compare cell by cell against what
// was recorded.
//
// Transport, retries, model fallback and the size guard are Combine's
// readImage — one implementation of talking to the Messages API, not two. What
// lives here is what a BOARD CELL means, which is nothing like a ranking row:
// a cell has a position on a grid, and a cell we cannot read must say so
// rather than be dropped (a silently missing cell would read as "the app has a
// pick the board doesn't", which is exactly the wrong alarm).
const vision = require('../../combine/lib/vision');
const { parseFirstArray } = require('../../../lib/json-array');
const master = require('../../../lib/players-master');
const players = require('../../../lib/players');

const PROMPT = `This photo shows a physical fantasy football draft board: a grid
of sticker or card labels on a wall. COLUMNS are teams (draft slots, numbered
left to right). ROWS are rounds (numbered top to bottom). The photo may show
only part of the board.

Return ONLY a JSON array — no prose, no markdown fences. One object per cell
that has anything written in it:
  {"round": <the round number for this cell, or null if you cannot tell>,
   "slot": <the team/column number for this cell, or null if you cannot tell>,
   "name": "<the player name as written, or empty string if unreadable>",
   "position": "<QB|RB|WR|TE|K|DST, or empty string if not written>",
   "readable": <true if you are confident of the name, false if you can see
                writing but cannot make it out>}

Rules:
- Work out round and slot from the printed row/column headers when they are
  visible. If the headers are cropped out of this photo, count from what you
  CAN see; if you still cannot tell, use null rather than guessing a number.
- Include a cell you can see writing in but cannot read: set "readable": false
  and put whatever you can make out (or "") in "name". Do NOT omit it.
- Do NOT include empty cells — a blank spot on the board is simply absent.
- Do not invent players and do not "correct" what is written: copy the name as
  it appears, including nicknames, abbreviations and misspellings.
- Ignore anything that is not a draft cell: team names in the header row,
  timers, logos, hands, glare.`;

function available() {
  return vision.available();
}

// Model text -> cells. Coercion only: a cell's identity is resolved separately
// (resolveCells) because that needs the database.
function parseCells(text) {
  const { items, truncated } = parseFirstArray(text);
  const cells = [];
  for (const c of items) {
    if (!c || typeof c !== 'object') continue;
    const name = String(c.name == null ? '' : c.name).trim();
    const readable = c.readable !== false && Boolean(name);
    // A cell with neither a usable name nor a place on the grid tells us
    // nothing at all — there is no way to line it up with a recorded pick.
    const round = intOrNull(c.round);
    const slot = intOrNull(c.slot);
    if (!name && round === null && slot === null) continue;
    cells.push({ round, slot, name, position: cleanPos(c.position), readable });
  }
  return { cells, truncated };
}

function intOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : null;
}

function cleanPos(v) {
  return String(v == null ? '' : v).toUpperCase().replace(/[^A-Z/]/g, '').replace('D/ST', 'DST');
}

// Attach an identity to each readable cell. High-confidence matches get a
// player_id; anything less is reported as a suggestion the owner confirms —
// the never-silently-guess invariant applies to a photo exactly as it does to
// a paste, and a wrong auto-match here would "verify" a pick that is wrong.
async function resolveCells(cells) {
  const index = await master.getIndex();
  return cells.map((cell) => {
    if (!cell.name) return Object.assign({}, cell, { player_id: null, matched_name: '', confidence: 'none' });
    const dst = players.teamDefenseFromLine(cell.name);
    const lookup = dst ? players.teamDefenseName(dst) : cell.name;
    const m = players.findNameDetailed(lookup, index);
    const hit = m.entry;
    return Object.assign({}, cell, {
      player_id: (hit && m.confidence === 'high') ? hit.player_id : null,
      matched_name: hit ? hit.name : '',
      confidence: hit ? m.confidence : 'none',
    });
  });
}

// One photo -> resolved cells. Returns { cells, model, truncated, note }.
async function readBoard(image, opts = {}) {
  const read = await vision.readImage(image, { model: opts.model, prompt: PROMPT });
  const notes = read.notes.slice();
  const { cells, truncated } = parseCells(read.text);
  const cut = Boolean(truncated || read.stopReason === 'max_tokens');
  if (cut) {
    notes.push(`That photo has more cells than one read can return — kept the first ${cells.length}. Photograph the board in sections to get the rest.`);
  }
  const resolved = await resolveCells(cells);
  return { cells: resolved, model: read.model, truncated: cut, note: notes.join(' ') };
}

module.exports = { available, readBoard, parseCells, resolveCells, PROMPT };
