// Playbook draft analysis (Phase 3) — pure math, no DB, golden-tested.
//
// Compares where each pick actually went against where the market (ADP) and
// the owner's own rankings (My Rankings run) had the player. Sign convention:
//   value = overall_pick - adp
// Positive = the player FELL past his ADP before being taken (a discount);
// negative = taken ahead of ADP (a reach). Same convention for my_value
// against the owner's rank.
//
// Steal/reach thresholds are DIALS (CLAUDE.md: every dial lives in settings —
// stored under 'playbook.analysis', editable on the draft page). A pick tags
// as a steal when it beats BOTH an absolute floor (picks) and a relative one
// (% of ADP) — late-round ADP is noisy, so "3 picks late" at pick 160 means
// nothing while 15% does; early on, the absolute floor keeps round-1 noise
// from tagging. Defaults are provisional, not gospel.

const DEFAULTS = {
  steal_picks: 5,   // min picks past ADP to call a steal…
  steal_pct: 10,    // …and min % of ADP (both must hold)
  reach_picks: 5,   // same, ahead of ADP
  reach_pct: 10,
};

const round1 = (n) => Math.round(n * 10) / 10;

function cleanOptions(options) {
  const out = Object.assign({}, DEFAULTS);
  for (const k of Object.keys(DEFAULTS)) {
    const v = options && Number(options[k]);
    if (Number.isFinite(v) && v >= 0) out[k] = v;
  }
  return out;
}

function tagFor(value, adp, opts) {
  if (value == null || adp == null) return null;
  const stealAt = Math.max(opts.steal_picks, adp * (opts.steal_pct / 100));
  const reachAt = Math.max(opts.reach_picks, adp * (opts.reach_pct / 100));
  if (value >= stealAt) return 'steal';
  if (-value >= reachAt) return 'reach';
  return null;
}

// analyze({ picks, adp, myRanks, mySlot, options })
//   picks   — [{ overall_pick, round, player_name, position, nfl_team,
//               draft_slot, is_my_pick, player_id }] (player_id may be null)
//   adp     — [{ player_id, adp }] from the chosen adp_history snapshot
//   myRanks — [{ player_id, rank }] from a My Rankings run (may be empty)
//   mySlot  — the owner's draft slot (fallback when picks lack is_my_pick)
function analyze({ picks = [], adp = [], myRanks = [], mySlot = null, options = {} } = {}) {
  const opts = cleanOptions(options);
  const adpBy = new Map();
  for (const a of adp) if (a && a.player_id != null && a.adp != null) adpBy.set(a.player_id, Number(a.adp));
  const rankBy = new Map();
  for (const r of myRanks) if (r && r.player_id != null && r.rank != null) rankBy.set(r.player_id, Number(r.rank));

  const rows = picks.map((p) => {
    const pid = p.player_id == null ? null : p.player_id;
    const a = pid != null && adpBy.has(pid) ? adpBy.get(pid) : null;
    const value = a == null ? null : round1(p.overall_pick - a);
    const myRank = pid != null && rankBy.has(pid) ? rankBy.get(pid) : null;
    return {
      overall_pick: p.overall_pick,
      round: p.round,
      player_name: p.player_name,
      position: p.position || '',
      nfl_team: p.nfl_team || '',
      draft_slot: p.draft_slot == null ? null : p.draft_slot,
      is_my_pick: !!p.is_my_pick,
      player_id: pid,
      matched: pid != null,
      adp: a,
      value,
      tag: tagFor(value, a, opts),
      my_rank: myRank,
      my_value: myRank == null ? null : round1(p.overall_pick - myRank),
    };
  });

  const mine = rows.filter((r) => r.is_my_pick);
  const valued = mine.filter((r) => r.value != null);
  let best = null, worst = null, total = 0;
  for (const r of valued) {
    total += r.value;
    if (!best || r.value > best.value) best = r;
    if (!worst || r.value < worst.value) worst = r;
  }

  // Positional balance of MY roster: how many, which rounds, ADP value spent.
  const byPos = {};
  for (const r of mine) {
    const pos = r.position || 'Other';
    const b = byPos[pos] || (byPos[pos] = { count: 0, rounds: [], value: 0 });
    b.count++;
    b.rounds.push(r.round);
    if (r.value != null) b.value = round1(b.value + r.value);
  }

  // Every team's total ADP value — a draft-room leaderboard. Slots with no
  // valued picks (all unmatched) are left out rather than shown as zero.
  const bySlot = new Map();
  for (const r of rows) {
    if (r.draft_slot == null || r.value == null) continue;
    const t = bySlot.get(r.draft_slot) || { slot: r.draft_slot, value: 0, picks: 0 };
    t.value = round1(t.value + r.value);
    t.picks++;
    bySlot.set(r.draft_slot, t);
  }
  const teams = Array.from(bySlot.values()).sort((a, b) => b.value - a.value);
  teams.forEach((t, i) => {
    t.rank = i + 1;
    t.is_me = mySlot != null && Number(t.slot) === Number(mySlot);
  });

  return {
    options: opts,
    rows,
    summary: {
      my_picks: mine.length,
      matched: mine.filter((r) => r.matched).length,
      unmatched: mine.filter((r) => !r.matched).length,
      no_adp: mine.filter((r) => r.matched && r.value == null).length,
      total_value: round1(total),
      steals: mine.filter((r) => r.tag === 'steal').length,
      reaches: mine.filter((r) => r.tag === 'reach').length,
      best_pick: best ? { player_name: best.player_name, overall_pick: best.overall_pick, adp: best.adp, value: best.value } : null,
      worst_pick: worst ? { player_name: worst.player_name, overall_pick: worst.overall_pick, adp: worst.adp, value: worst.value } : null,
    },
    positions: byPos,
    teams,
  };
}

module.exports = { analyze, DEFAULTS, tagFor, cleanOptions };
