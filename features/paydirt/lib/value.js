// Pay Dirt — projected fantasy points per FanDuel dollar.
//
// Two inputs, both re-supplied every week:
//   1. Fantasy Points' weekly projections export — the SAME file the Underdog
//      quick upload takes (two-row header, "Player Details" group label, an
//      FPTS column under "Projection"). Read through Combine's csv-import so
//      there is one answer to "which column is the name / position / team".
//   2. FanDuel's salaries — the "Download players list" CSV from a contest's
//      lobby (Id, Position, First Name, Nickname, Last Name, FPPG, Played,
//      Salary, Game, Team, Opponent, Injury Indicator, ...), or a pasted list
//      with one "Name POS TEAM $9,200" per line.
//
// Names are matched with Underdog's strict resolver (underdog-ids): a full-name
// hit is the identity, a last-name-anchored hit must also agree on first name
// and position. A FanDuel slate is a small pool, so a unique surname proves
// nothing — and a wrong match here would put one player's salary next to
// another's projection, which is worse than a visible miss. Defenses match on
// team, since the two sites name them differently ("Ravens D/ST" vs
// "Baltimore Ravens").
const csvImport = require('../../combine/lib/csv-import');
const underdogIds = require('../../combine/lib/underdog-ids');
const players = require('../../../lib/players');

function normPos(p) {
  const s = String(p || '').trim().toUpperCase().replace(/\d+$/, '');
  if (s === 'D' || s === 'DEF' || s === 'D/ST' || s === 'DST') return 'DST';
  if (s === 'PK') return 'K';
  return s;
}

function num(raw) {
  const s = String(raw == null ? '' : raw).replace(/[$,\s]/g, '');
  if (s === '') return null;
  const v = Number(s);
  return Number.isFinite(v) ? v : null;
}

// The team a defense row stands for: its team column, else its name.
function defenseTeam(row) {
  return players.primaryTeam(row.team || '') || players.teamDefenseFromLine(row.name || '') || '';
}

// Fantasy Points export -> [{ rank, name, position, team, opp, fpts }] in rank
// order. Throws a readable error when the file has no projection column,
// because points-per-dollar without points is nothing at all.
function parseProjections(text) {
  const raw = String(text || '');
  if (!raw.trim()) throw new Error('The Fantasy Points file is empty.');
  const table = csvImport.importCsv(raw);
  if (!table.headerFound) {
    throw new Error('The Fantasy Points file needs its header row (NAME, POS, FPTS …). Upload the export as downloaded rather than a pasted list.');
  }
  const map = table.mapping;
  const labels = (map.labels || []).map((l) => String(l || '').trim().toLowerCase());
  // Prefer the column literally called FPTS (Fantasy Points' weekly export),
  // then any projection-ish label. "FPTS/G" is a per-game average, not this.
  let fptsCol = labels.findIndex((l) => l === 'fpts');
  if (fptsCol < 0) fptsCol = labels.findIndex((l) => /^(proj(ected)?\.?( ?(pts|points|fpts))?|projection|fantasy ?points|fpts|pts|points|fp)$/.test(l));
  if (fptsCol < 0) {
    throw new Error('No projected-points column was found in the Fantasy Points file (looked for a column headed "FPTS"). Is this the weekly projections export?');
  }
  const oppCol = labels.findIndex((l) => /^opp(onent)?$/.test(l));

  const out = [];
  (table.dataRows || []).forEach((r, i) => {
    const rawName = String(r[map.name] || '').trim();
    let name = players.display(rawName);
    if (!name || /^(player|name)\b/i.test(name)) return;
    const fpts = num(r[fptsCol]);
    if (fpts === null) return;
    const rankCell = map.rank >= 0 ? parseInt(String(r[map.rank] || '').replace(/[^0-9]/g, ''), 10) : NaN;
    const position = normPos(map.pos >= 0 ? r[map.pos] : '') || (players.teamDefenseFromLine(rawName) ? 'DST' : '');
    let team = map.team >= 0 ? (players.primaryTeam(r[map.team]) || String(r[map.team] || '').trim().toUpperCase()) : '';
    if (position === 'DST') {
      // "Ravens D/ST" -> "Baltimore Ravens", the way FanDuel lists it.
      team = team || players.teamDefenseFromLine(rawName);
      name = players.teamDefenseName(team) || rawName;
    }
    out.push({
      order: i,
      rank: Number.isFinite(rankCell) ? rankCell : null,
      name,
      position,
      team,
      opp: oppCol >= 0 ? String(r[oppCol] || '').trim().toUpperCase() : '',
      fpts,
    });
  });
  if (!out.length) throw new Error('No players with a projection were found in the Fantasy Points file.');
  if (out.every((p) => p.rank !== null)) out.sort((a, b) => (a.rank - b.rank) || (a.order - b.order));
  return out.map((p, i) => ({ rank: p.rank !== null ? p.rank : i + 1, name: p.name, position: p.position, team: p.team, opp: p.opp, fpts: p.fpts }));
}

// FanDuel salaries -> [{ name, position, team, opp, salary, injury }].
// A header with a Salary column is read by label; anything else is a pasted
// list, one player per line, with the salary as the $-figure (or the 4-5
// digit number) on the line.
function parseSalaries(text) {
  const raw = String(text || '');
  if (!raw.trim()) throw new Error('The FanDuel salaries are empty.');
  const table = csvImport.parseTable(raw);
  let headerIdx = -1;
  for (let i = 0; i < Math.min(5, table.length); i++) {
    if (table[i].some((c) => /^salary$/i.test(String(c).trim()))) { headerIdx = i; break; }
  }
  const out = [];
  if (headerIdx >= 0) {
    const h = table[headerIdx].map((c) => String(c).trim().toLowerCase());
    const col = (re) => h.findIndex((l) => re.test(l));
    const c = {
      nick: col(/^nickname$/), first: col(/^first ?name$/), last: col(/^last ?name$/),
      name: col(/^(name|player|player ?name)$/), pos: col(/^(position|pos)$/), team: col(/^(team|tm)$/),
      opp: col(/^opp(onent)?$/), salary: col(/^salary$/), injury: col(/^injury ?indicator$/),
    };
    for (const r of table.slice(headerIdx + 1)) {
      const cell = (i) => (i >= 0 ? String(r[i] == null ? '' : r[i]).trim() : '');
      const first = cell(c.first), last = cell(c.last);
      // Nickname is the name FanDuel shows in the lobby ("Hollywood Brown").
      const name = players.display(cell(c.nick) || cell(c.name) || [first, last].filter(Boolean).join(' '));
      const salary = num(cell(c.salary));
      if (!name || salary === null || salary <= 0) continue;
      out.push({
        name, position: normPos(cell(c.pos)),
        team: players.primaryTeam(cell(c.team)) || cell(c.team).toUpperCase(),
        opp: cell(c.opp).toUpperCase(), salary, injury: cell(c.injury).toUpperCase(),
      });
    }
  } else {
    for (const line of raw.split(/\r?\n/)) {
      const m = /\$\s?(\d{1,2},?\d{3})\b|\b(\d{1,2},\d{3}|\d{4,5})\b/.exec(line);
      if (!m) continue;
      const salary = num(m[1] || m[2]);
      if (!salary || salary < 1000) continue;
      const rest = (line.slice(0, m.index) + ' ' + line.slice(m.index + m[0].length))
        .replace(/^\s*\d+[.)]?\s+/, '').trim();
      const tokens = rest.split(/[\s,|\t]+/).filter(Boolean);
      const position = normPos(players.findPosition(tokens));
      const teamTok = tokens.find((t) => players.primaryTeam(t) && t === t.toUpperCase());
      const nameTokens = tokens.filter((t) => !players.isPosition(t) && t !== teamTok && !/^\$?[\d.]+$/.test(t));
      const name = players.display(nameTokens.join(' '));
      if (!name) continue;
      out.push({ name, position, team: teamTok ? players.primaryTeam(teamTok) : '', opp: '', salary, injury: '' });
    }
  }
  if (!out.length) throw new Error('No players with a salary were found in the FanDuel file. It needs a Salary column (FanDuel\'s "Download players list" CSV) or one "Name $9,200" per line.');
  return out;
}

// Points per $1,000 of salary — the DFS convention, so 3.0 reads as "3x value".
function perK(fpts, salary) {
  if (!salary) return null;
  return Math.round((fpts / (salary / 1000)) * 100) / 100;
}

// Join the two lists. Returns
//   { rows: [{ rank, name, position, team, opp, fpts, salary, value, injury, fd_name }],
//     no_salary: [{ rank, name, position, team, fpts }],   projected, not on the slate
//     no_projection: [{ name, position, team, salary }] }  on the slate, not projected
function build(projectionsText, salariesText) {
  const proj = parseProjections(projectionsText);
  const fd = parseSalaries(salariesText);
  const index = underdogIds.buildIndex(fd);
  const fdDefense = new Map();
  fd.forEach((r, i) => { if (r.position === 'DST') { const t = defenseTeam(r); if (t && !fdDefense.has(t)) fdDefense.set(t, i); } });

  const taken = new Set();
  const rows = [];
  const noSalary = [];
  for (const p of proj) {
    let idx = null;
    if (p.position === 'DST') {
      const t = defenseTeam(p);
      if (t && fdDefense.has(t)) idx = fdDefense.get(t);
    } else {
      const hit = underdogIds.resolveRow(index, fd, p);
      if (hit && fd[hit.idx].position !== 'DST') idx = hit.idx;
    }
    // One salary, one player: a second projection resolving to the same FanDuel
    // row is the lower-ranked one and is reported rather than doubled up.
    if (idx === null || taken.has(idx)) {
      noSalary.push({ rank: p.rank, name: p.name, position: p.position, team: p.team, fpts: p.fpts });
      continue;
    }
    taken.add(idx);
    const s = fd[idx];
    rows.push({
      rank: p.rank, name: p.name, position: p.position || s.position, team: p.team || s.team,
      opp: s.opp || p.opp, fpts: p.fpts, salary: s.salary, value: perK(p.fpts, s.salary),
      injury: s.injury, fd_name: players.key(s.name) === players.key(p.name) ? null : s.name,
    });
  }
  const noProjection = fd
    .filter((_, i) => !taken.has(i))
    .sort((a, b) => b.salary - a.salary)
    .map((s) => ({ name: s.name, position: s.position, team: s.team, salary: s.salary }));
  return { rows, no_salary: noSalary, no_projection: noProjection };
}

module.exports = { parseProjections, parseSalaries, perK, build, normPos };
