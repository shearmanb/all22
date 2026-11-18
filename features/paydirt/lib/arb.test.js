// Tests for the FanDuel vs DraftKings comparison. Run with: node --test
const test = require('node:test');
const assert = require('node:assert');
const { compare, theilSen, median } = require('./arb');

test('median and theilSen ignore a single outlier', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
  const pts = [[5000, 3000], [6000, 3800], [7000, 4600], [8000, 5400], [9000, 6200], [6500, 7000]]
    .map(([x, y]) => ({ x, y }));
  const fit = theilSen(pts);
  assert.ok(Math.abs(fit.slope - 0.8) < 1e-9);
  assert.ok(Math.abs(fit.intercept - -1000) < 1e-9);
  assert.equal(theilSen([{ x: 1, y: 1 }, { x: 1, y: 2 }]), null);
});

const FD =
  'Position,Nickname,Team,Opponent,Salary,Injury Indicator\n' +
  'WR,Ja\'Marr Chase,CIN,BAL,9000,\n' +
  'WR,Puka Nacua,LAR,SF,8000,Q\n' +
  'WR,Nico Collins,HOU,TEN,7000,\n' +
  'WR,Hollywood Brown,KC,LV,6000,\n' +
  'WR,Jaxon Smith-Njigba,SEA,ARI,6500,\n' +
  'WR,Tony Brown,TEN,HOU,5000,\n' +
  'QB,Lamar Jackson,BAL,CIN,9200,\n' +
  'D,Baltimore Ravens,BAL,CIN,4200,\n' +
  'RB,Only Onfanduel,DET,NO,5500,\n';
const DK =
  'Position,Name,Salary,TeamAbbrev\n' +
  'WR,Ja\'Marr Chase,6200,CIN\n' +
  'WR,Puka Nacua,5400,LAR\n' +
  'WR,Nico Collins,4600,HOU\n' +
  'WR,Marquise Brown,3800,KC\n' +
  'WR,Jaxon Smith-Njigba,7000,SEA\n' +
  'WR,Tony Brown,3000,TEN\n' +
  'QB,Lamar Jackson,7100,BAL\n' +
  'DST,Ravens ,3300,BAL\n' +
  'TE,Only Ondraftkings,2500,NO\n';

test('compare: per-position exchange rate, edge = DK price minus what FanDuel predicts', () => {
  const out = compare(FD, DK, { rows: [{ fd_idx: 0, fpts: 22.1 }] });
  const by = new Map(out.rows.map((r) => [r.name, r]));
  // WRs: DK = 0.8 x FD - 1000 for everyone but JSN.
  assert.deepEqual(out.fits.WR, { slope: 0.8, intercept: -1000, n: 6, pooled: false });
  assert.equal(by.get('Puka Nacua').edge, 0);
  assert.equal(by.get('Puka Nacua').cheaper_on, null);
  const jsn = by.get('Jaxon Smith-Njigba');
  assert.equal(jsn.dk_expected, 4200);
  assert.equal(jsn.edge, 2800);
  assert.equal(jsn.edge_pct, 66.7);
  assert.equal(jsn.cheaper_on, 'FD');
  // Biggest gap first.
  assert.equal(out.rows[0].name, 'Jaxon Smith-Njigba');
  // A projection rides along where the projections join had one.
  assert.equal(by.get('Ja\'Marr Chase').fpts, 22.1);
  assert.equal(by.get('Nico Collins').fpts, null);
  // FanDuel's nickname resolves through the alias table, and DK's name shows.
  assert.equal(by.get('Hollywood Brown').dk_salary, 3800);
  assert.equal(by.get('Hollywood Brown').dk_name, 'Marquise Brown');
  // Cap share on each site.
  assert.equal(by.get('Ja\'Marr Chase').fd_pct, 15);
  assert.equal(by.get('Ja\'Marr Chase').dk_pct, 12.4);
  // Too few QBs / defenses to fit their own line: borrow the pooled one, say so.
  assert.equal(out.fits.QB.pooled, true);
  assert.equal(by.get('Baltimore Ravens').dk_salary, 3300);
  // Both one-site lists are reported.
  assert.deepEqual(out.fd_only.map((r) => r.name), ['Only Onfanduel']);
  assert.deepEqual(out.dk_only.map((r) => r.name), ['Only Ondraftkings']);
});

test('compare says plainly when the DraftKings file has no salaries', () => {
  assert.throws(() => compare(FD, 'just words\n', null), /DraftKings/);
});
