// boarddiff.js — compare what the camera saw on the wall against what the app
// has recorded, and say exactly where they disagree.
//
// Pure: cells in, verdicts out. No database, no network — so the rules that
// decide "these are the same player" are testable, which matters because this
// is the check the owner trusts to catch a mis-recorded pick.
//
// Verdicts, per board position:
//   ok                 board and app agree
//   mismatch           both have someone here, and they are different people
//   missing_from_app   the board has a pick here, the app does not
//   missing_from_board this position is recorded but no photo showed it
//   unreadable         a cell was photographed but could not be read
//   unplaced           a cell was read but its round/slot could not be worked out
//
// "missing_from_board" is deliberately NOT an error on its own: the owner may
// simply not have photographed that part of the board. The report says how much
// of the board the photos covered so a wall of them means "take more photos",
// not "the app is wrong".
const players = require('../../../lib/players');

// Merge cells from several photos into one board, keyed by round/slot.
// Later photos win over earlier ones ONLY when they are more informative — a
// second, blurrier shot of a cell must not undo a first, clear read.
function mergeCells(cells) {
  const byKey = new Map();
  const unplaced = [];
  for (const cell of cells || []) {
    if (!cell) continue;
    if (!cell.round || !cell.slot) { unplaced.push(cell); continue; }
    const key = cell.round + ':' + cell.slot;
    const prior = byKey.get(key);
    if (!prior) { byKey.set(key, cell); continue; }
    // A readable cell always beats an unreadable one.
    if (cell.readable && !prior.readable) { byKey.set(key, cell); continue; }
    if (!cell.readable && prior.readable) continue;
    // Two readable photos that disagree about the same square: keep the first
    // and flag it, rather than silently trusting whichever came last.
    if (cell.readable && prior.readable && !samePlayer(prior, cell)) {
      prior.photo_conflict = cell.name;
    }
  }
  return { placed: byKey, unplaced };
}

// Do these two refer to the same player? Ids when both sides have one (the
// only certain answer); otherwise the canonical name key, which is what the
// whole app uses to decide name identity.
function samePlayer(a, b) {
  if (!a || !b) return false;
  if (a.player_id && b.player_id) return a.player_id === b.player_id;
  const ka = players.key(a.matched_name || a.name || a.player_name || '');
  const kb = players.key(b.matched_name || b.name || b.player_name || '');
  return Boolean(ka) && ka === kb;
}

function pickLabelFor(round, slot) {
  return { round: round, slot: slot };
}

// cells: resolved cells from one or more photos (boardvision.resolveCells).
// picks: the recorded picks ({ round, draft_slot, player_id, player_name, ... }).
// Returns { findings, summary }.
function diffBoard(cells, picks) {
  const { placed, unplaced } = mergeCells(cells);
  const byPosition = new Map();
  for (const p of picks || []) {
    if (!p || !p.round || !p.draft_slot) continue;
    byPosition.set(p.round + ':' + p.draft_slot, p);
  }

  const findings = [];
  const seen = new Set();

  for (const [key, cell] of placed) {
    seen.add(key);
    const pick = byPosition.get(key);
    const where = pickLabelFor(cell.round, cell.slot);

    if (!cell.readable || !cell.name) {
      findings.push(Object.assign({
        verdict: 'unreadable',
        board_name: cell.name || '',
        app_name: pick ? (pick.player_name || '') : '',
        pick_id: pick ? pick.id : null,
      }, where));
      continue;
    }
    if (!pick) {
      findings.push(Object.assign({
        verdict: 'missing_from_app',
        board_name: cell.name,
        board_player_id: cell.player_id || null,
        board_suggestion: cell.player_id ? '' : (cell.matched_name || ''),
        app_name: '',
        pick_id: null,
      }, where));
      continue;
    }
    const agree = samePlayer(
      { player_id: cell.player_id, matched_name: cell.matched_name, name: cell.name },
      { player_id: pick.player_id, name: pick.player_name }
    );
    findings.push(Object.assign({
      verdict: agree ? 'ok' : 'mismatch',
      board_name: cell.name,
      board_player_id: cell.player_id || null,
      board_suggestion: cell.player_id ? '' : (cell.matched_name || ''),
      app_name: pick.player_name || '',
      pick_id: pick.id,
      photo_conflict: cell.photo_conflict || '',
    }, where));
  }

  // Recorded picks the photos never showed.
  for (const [key, pick] of byPosition) {
    if (seen.has(key)) continue;
    findings.push({
      verdict: 'missing_from_board',
      round: pick.round,
      slot: pick.draft_slot,
      board_name: '',
      app_name: pick.player_name || '',
      pick_id: pick.id,
    });
  }

  for (const cell of unplaced) {
    findings.push({
      verdict: 'unplaced',
      round: null,
      slot: null,
      board_name: cell.name || '',
      app_name: '',
      pick_id: null,
    });
  }

  findings.sort((a, b) =>
    (a.round === null) - (b.round === null) ||
    (a.round - b.round) || (a.slot - b.slot));

  const summary = { ok: 0, mismatch: 0, missing_from_app: 0, missing_from_board: 0, unreadable: 0, unplaced: 0 };
  for (const f of findings) summary[f.verdict]++;
  summary.cells_seen = placed.size;
  summary.picks_recorded = byPosition.size;
  // Anything the owner actually has to look at.
  summary.problems = summary.mismatch + summary.missing_from_app;
  return { findings, summary };
}

module.exports = { diffBoard, mergeCells, samePlayer };
