// ecr.js — the mini-ECR blender: mesh selected ranking sets into one
// consensus list, FantasyPros-ECR style but with the owner's dials.
//
// Pure logic (no DB): takes fully-loaded sets (store.getSetRows shape) so it's
// golden-testable. All dials arrive as options; their live values come from
// the settings table / the page — never hardcoded here (CLAUDE.md).
//
// Scope rules (the non-negotiable part):
//   - OVERALL consensus averages overall ranks, so only sets with
//     ranking_scope 'overall' vote in it. A positional set's stored rank is
//     just paste order — letting it vote overall would be silent cross-position
//     blending, which the PRD flags as an open decision. Excluded, visibly.
//   - PER-POSITION consensus averages rank-within-position, which is derived
//     for every set (both scopes), so ALL selected sets vote there.
//
// Dials:
//   unranked      'exclude' (default): a set that omits a player simply doesn't
//                 vote on him — avg over the sets that ranked him.
//                 'penalty': an omitting set votes "just past the end of its
//                 own list" (list length + penalty_extra) — omission reads as
//                 "very low", not "no opinion". PRD §17.6 is an open decision;
//                 both semantics are offered, neither is silently picked.
//   penalty_extra how far past the end an omission votes (penalty mode only).
//   min_sets      hide players ranked by fewer than N sets (exclude mode's
//                 guard against one ranker's deep-sleeper tail dominating).
//   outlier       'none' (default) or 'trim': with 4+ votes, drop the single
//                 highest and single lowest vote before averaging (a light
//                 trimmed mean — PRD §8's outlier tamping, mildest version).
//
// Stats honesty: min/max/stdev/n always describe REAL votes (ranks that were
// actually published). In penalty mode the average can sit outside [min, max]
// because synthetic omission votes pull it — the UI explains that via n.

const DEFAULTS = {
  unranked: 'exclude',
  penalty_extra: 10,
  min_sets: 1,
  outlier: 'none',
};

function cleanOptions(opts) {
  const o = Object.assign({}, DEFAULTS, opts || {});
  o.unranked = o.unranked === 'penalty' ? 'penalty' : 'exclude';
  o.penalty_extra = Number.isFinite(Number(o.penalty_extra)) ? Math.max(0, Number(o.penalty_extra)) : DEFAULTS.penalty_extra;
  o.min_sets = Number.isFinite(Number(o.min_sets)) ? Math.max(1, Math.round(Number(o.min_sets))) : DEFAULTS.min_sets;
  o.outlier = o.outlier === 'trim' ? 'trim' : 'none';
  return o;
}

function setWeight(set) {
  const w = Number(set.weight);
  return Number.isFinite(w) && w > 0 ? w : (set.weight === undefined || set.weight === null ? 1 : 0);
}

// Weighted mean with the trim dial applied. Votes: [{ value, weight }].
function aggregate(votes, outlier) {
  let used = votes;
  if (outlier === 'trim' && votes.length >= 4) {
    let lo = 0, hi = 0;
    for (let i = 1; i < votes.length; i++) {
      if (votes[i].value < votes[lo].value) lo = i;
      if (votes[i].value > votes[hi].value) hi = i;
    }
    used = votes.filter((_, i) => i !== lo && i !== hi);
  }
  let sw = 0, swv = 0;
  for (const v of used) { sw += v.weight; swv += v.weight * v.value; }
  return sw > 0 ? swv / sw : null;
}

// Unweighted population stdev over real votes — describes ranker disagreement.
function stdev(values) {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const varsum = values.reduce((a, b) => a + (b - mean) * (b - mean), 0) / values.length;
  return Math.sqrt(varsum);
}

// One scope's consensus. voters: [{ set, sizeByKey, votesByPlayer }] where
// votesByPlayer maps player_id -> best (lowest) vote value in that set.
function consensus(voters, identity, opts) {
  // Universe: every player any voter ranked.
  const universe = new Set();
  for (const v of voters) for (const pid of v.votesByPlayer.keys()) universe.add(pid);

  const out = [];
  for (const pid of universe) {
    const real = [];        // actual published ranks
    const forAvg = [];      // ranks the average uses (may add penalty votes)
    const votes = {};       // set_id -> published rank (for the per-set columns)
    for (const v of voters) {
      const w = setWeight(v.set);
      if (w <= 0) continue;
      const rank = v.votesByPlayer.get(pid);
      if (rank !== undefined) {
        real.push(rank);
        forAvg.push({ value: rank, weight: w });
        votes[v.set.id] = rank;
      } else if (opts.unranked === 'penalty') {
        forAvg.push({ value: v.size + opts.penalty_extra, weight: w });
      }
    }
    if (real.length < opts.min_sets) continue;
    const avg = aggregate(forAvg, opts.outlier);
    if (avg === null) continue;
    const id = identity.get(pid) || {};
    out.push({
      player_id: pid,
      name: id.name || '',
      position: id.position || '',
      team: id.team || '',
      avg: Math.round(avg * 100) / 100,
      min: Math.min(...real),
      max: Math.max(...real),
      stdev: Math.round(stdev(real) * 100) / 100,
      n: real.length,
      votes,
    });
  }
  out.sort((a, b) =>
    (a.avg - b.avg) ||
    (b.n - a.n) ||
    (a.min - b.min) ||
    String(a.name).localeCompare(String(b.name))
  );
  out.forEach((row, i) => { row.rank = i + 1; });
  return out;
}

// sets: [{ id, name, source, native_scoring_format, ranking_scope, weight,
//          rows: store.getSetRows() output }]
function buildEcr(sets, options) {
  const opts = cleanOptions(options);
  const identity = new Map(); // player_id -> { name, position, team }

  const overallVoters = [];
  const positionVoters = new Map(); // pos -> voters array
  const unmatchedSkipped = {};
  const formats = new Set();

  for (const set of sets || []) {
    if (setWeight(set) <= 0) continue;
    formats.add(set.native_scoring_format || 'unknown');
    const rows = set.rows || [];
    let skipped = 0;

    // Overall votes (overall-scope sets only): best rank per player.
    const overallVotes = new Map();
    // Position votes (every set): best position_rank per player, per position.
    const posVotes = new Map(); // pos -> Map(player_id -> best pos rank)
    const posSizes = {};        // pos -> number of rows at that position

    for (const row of rows) {
      if (row.position) posSizes[row.position] = (posSizes[row.position] || 0) + 1;
      if (!row.player_id) { skipped++; continue; }
      if (!identity.has(row.player_id)) {
        identity.set(row.player_id, { name: row.name, position: row.position, team: row.team });
      }
      if (set.ranking_scope !== 'positional') {
        const prev = overallVotes.get(row.player_id);
        if (prev === undefined || row.rank < prev) overallVotes.set(row.player_id, row.rank);
      }
      if (row.position && row.position_rank) {
        if (!posVotes.has(row.position)) posVotes.set(row.position, new Map());
        const m = posVotes.get(row.position);
        const prev = m.get(row.player_id);
        if (prev === undefined || row.position_rank < prev) m.set(row.player_id, row.position_rank);
      }
    }

    if (skipped) unmatchedSkipped[set.id] = skipped;
    if (set.ranking_scope !== 'positional') {
      overallVoters.push({ set, size: rows.length, votesByPlayer: overallVotes });
    }
    for (const [pos, m] of posVotes) {
      if (!positionVoters.has(pos)) positionVoters.set(pos, []);
      positionVoters.get(pos).push({ set, size: posSizes[pos] || m.size, votesByPlayer: m });
    }
  }

  const overall = consensus(overallVoters, identity, opts);
  const positions = {};
  for (const [pos, voters] of positionVoters) {
    positions[pos] = consensus(voters, identity, opts);
  }

  return {
    overall,
    positions,
    meta: {
      options: opts,
      overall_sets: overallVoters.map((v) => v.set.id),
      positional_only_sets: (sets || [])
        .filter((s) => s.ranking_scope === 'positional' && setWeight(s) > 0)
        .map((s) => s.id),
      formats: Array.from(formats),
      mixed_formats: formats.size > 1,
      unmatched_skipped: unmatchedSkipped,
    },
  };
}

// Risers/fallers between two saved runs (or a run and a preview): pairs on
// player_id, sorted by |delta| — the same shape Combine's compare uses.
function compareRankings(aRows, bRows) {
  const byPlayer = new Map();
  for (const r of aRows || []) if (r.player_id) byPlayer.set(r.player_id, { a: r });
  for (const r of bRows || []) {
    if (!r.player_id) continue;
    const e = byPlayer.get(r.player_id);
    if (e) e.b = r; else byPlayer.set(r.player_id, { b: r });
  }
  const pairs = [], onlyA = [], onlyB = [];
  for (const { a, b } of byPlayer.values()) {
    if (a && b) {
      pairs.push({
        player_id: a.player_id, name: a.name || b.name, position: a.position || b.position,
        team: a.team || b.team, rank_a: a.rank, rank_b: b.rank, delta: a.rank - b.rank,
      });
    } else if (a) onlyA.push({ player_id: a.player_id, name: a.name, position: a.position, team: a.team, rank: a.rank });
    else onlyB.push({ player_id: b.player_id, name: b.name, position: b.position, team: b.team, rank: b.rank });
  }
  pairs.sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta));
  onlyA.sort((x, y) => x.rank - y.rank);
  onlyB.sort((x, y) => x.rank - y.rank);
  return { pairs, onlyA, onlyB };
}

module.exports = { buildEcr, compareRankings, cleanOptions, DEFAULTS };
