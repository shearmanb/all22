// FanDuel vs DraftKings — where the two sites price a player differently.
//
// Raw dollars don't compare ($60K cap vs $50K, different salary floors and
// steps), and neither does cap share alone (DK's floor is lower, so a min-price
// player is a smaller share of DK's cap than FanDuel's). So the slate sets its
// own exchange rate: for each position, fit DK salary against FanDuel salary
// across every player on both slates, and a player's EDGE is how far his DK
// price sits from what his FanDuel price predicts. Negative = cheaper on
// DraftKings than the market's own rate says (play him there); positive =
// cheaper on FanDuel.
//
// The fit is Theil–Sen (median of pairwise slopes, median intercept), not least
// squares: the mispriced players ARE the outliers, and least squares would bend
// the line toward them and shrink the very gaps this page exists to show.
// Fitting per position keeps the sites' systematic scoring differences (DK is
// full PPR, FanDuel half) inside the rate, so the edge is the player, not the
// format. A position with too few players to fit borrows the all-positions line
// and says so.
//
// Names are joined with the same strict resolver as the projections join
// (underdog-ids) — a wrong match here would show a phantom arbitrage — and
// defenses join on team.
const underdogIds = require('../../combine/lib/underdog-ids');
const players = require('../../../lib/players');
const value = require('./value');

const FD_CAP = 60000;
const DK_CAP = 50000;
const MIN_FIT = 5;

function median(xs) {
  const s = xs.slice().sort((a, b) => a - b);
  const n = s.length;
  if (!n) return null;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

// Theil–Sen line through points [{x, y}]. null when every x is the same.
function theilSen(pts) {
  const slopes = [];
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      const dx = pts[j].x - pts[i].x;
      if (dx !== 0) slopes.push((pts[j].y - pts[i].y) / dx);
    }
  }
  if (!slopes.length) return null;
  const slope = median(slopes);
  const intercept = median(pts.map((p) => p.y - slope * p.x));
  return { slope, intercept, n: pts.length };
}

// fdText / dkText: the two salary files as stored. built: value.build()'s
// result for the slate (its rows carry fd_idx, so a projection rides along
// where Fantasy Points has one). Returns
//   { rows: [{ name, position, team, opp, injury, fd_salary, dk_salary,
//              fd_pct, dk_pct, dk_expected, edge, edge_pct, cheaper_on, fpts, dk_name }],
//     fits: { QB: { slope, intercept, n, pooled }, ... },
//     fd_only: [{ name, position, team, salary }], dk_only: [...] }
function compare(fdText, dkText, built) {
  const fd = value.parseSalaries(fdText);
  let dk;
  try { dk = value.parseSalaries(dkText); } catch (e) {
    throw new Error('No players with a salary were found in the DraftKings file. It needs a Salary column (DraftKings\' "Export to CSV" from a contest\'s draft page).');
  }
  const fpts = new Map();
  for (const r of (built && built.rows) || []) if (r.fd_idx != null) fpts.set(r.fd_idx, r.fpts);

  const index = underdogIds.buildIndex(dk);
  const dkDefense = new Map();
  dk.forEach((r, i) => { if (r.position === 'DST') { const t = value.defenseTeam(r); if (t && !dkDefense.has(t)) dkDefense.set(t, i); } });

  const taken = new Set();
  const pairs = [];
  const fdOnly = [];
  fd.forEach((f, fi) => {
    let idx = null;
    if (f.position === 'DST') {
      const t = value.defenseTeam(f);
      if (t && dkDefense.has(t)) idx = dkDefense.get(t);
    } else {
      const hit = underdogIds.resolveRow(index, dk, f);
      if (hit && dk[hit.idx].position !== 'DST') idx = hit.idx;
    }
    if (idx === null || taken.has(idx)) { fdOnly.push({ name: f.name, position: f.position, team: f.team, salary: f.salary }); return; }
    taken.add(idx);
    const d = dk[idx];
    pairs.push({
      name: f.name, position: f.position || d.position, team: f.team || d.team, opp: f.opp || d.opp,
      injury: f.injury || d.injury, fd_salary: f.salary, dk_salary: d.salary,
      fd_pct: Math.round((f.salary / FD_CAP) * 1000) / 10,
      dk_pct: Math.round((d.salary / DK_CAP) * 1000) / 10,
      fpts: fpts.has(fi) ? fpts.get(fi) : null,
      dk_name: f.position === 'DST' || players.key(d.name) === players.key(f.name) ? null : d.name,
    });
  });
  const dkOnly = dk.filter((_, i) => !taken.has(i))
    .sort((a, b) => b.salary - a.salary)
    .map((d) => ({ name: d.name, position: d.position, team: d.team, salary: d.salary }));

  // One exchange rate per position, the all-positions line as the fallback.
  const pooled = pairs.length >= 2 ? theilSen(pairs.map((p) => ({ x: p.fd_salary, y: p.dk_salary }))) : null;
  const fits = {};
  const byPos = new Map();
  for (const p of pairs) { if (!byPos.has(p.position)) byPos.set(p.position, []); byPos.get(p.position).push(p); }
  for (const [pos, list] of byPos) {
    const own = list.length >= MIN_FIT ? theilSen(list.map((p) => ({ x: p.fd_salary, y: p.dk_salary }))) : null;
    const fit = own || pooled;
    if (fit) fits[pos || '?'] = { slope: Math.round(fit.slope * 1000) / 1000, intercept: Math.round(fit.intercept), n: list.length, pooled: !own };
    for (const p of list) {
      if (!fit) { p.dk_expected = null; p.edge = null; p.edge_pct = null; p.cheaper_on = null; continue; }
      const expected = fit.slope * p.fd_salary + fit.intercept;
      p.dk_expected = Math.round(expected / 10) * 10;
      p.edge = Math.round(p.dk_salary - expected);
      p.edge_pct = expected > 0 ? Math.round(((p.dk_salary - expected) / expected) * 1000) / 10 : null;
      p.cheaper_on = p.edge < 0 ? 'DK' : p.edge > 0 ? 'FD' : null;
    }
  }
  pairs.sort((a, b) => Math.abs(b.edge_pct || 0) - Math.abs(a.edge_pct || 0));
  return { rows: pairs, fits, fd_only: fdOnly, dk_only: dkOnly, caps: { fd: FD_CAP, dk: DK_CAP } };
}

module.exports = { compare, theilSen, median, FD_CAP, DK_CAP };
