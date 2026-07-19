// All22 — NFL team color themes. One file, no build step, no deps.
//
// Picks any of the 32 teams (or RANDOM / re-roll) and re-skins the whole app by
// setting CSS custom properties on <html>. Two intensity modes: "balanced"
// (neutral base, team accents) and "takeover" (full team-color immersion).
// Every component reads var(--…) from app.css; this file only computes and
// applies the values. Selection persists in localStorage.
//
// Loaded in <head> on every page so vars land before first paint (no flash of
// the fallback theme). DOM injection (picker, footer stripe) waits for the body.
//
// Programmatic control lives on window.All22Theme (used by tests/screenshots).
(function () {
  'use strict';

  // ---------------------------------------------------------------- color math
  // (drop-in helpers — hex/rgb, channel mix, WCAG relative luminance, auto ink)
  const rgb  = h => { h = String(h).replace('#', ''); if (h.length === 3) h = [...h].map(c => c + c).join(''); return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16)); };
  const hex  = r => '#' + r.map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
  const mix  = (a, b, t) => { const A = rgb(a), B = rgb(b); return hex([0, 1, 2].map(i => A[i] + (B[i] - A[i]) * t)); };
  const lum  = h => { const [r, g, b] = rgb(h).map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const ink  = h => lum(h) > 0.45 ? '#141824' : '#FFFFFF';          // readable text on a bg
  const rgba = (h, a) => { const [r, g, b] = rgb(h); return `rgba(${r},${g},${b},${a})`; };
  const sat  = h => { const [r, g, b] = rgb(h).map(v => v / 255), mx = Math.max(r, g, b), mn = Math.min(r, g, b); return mx === 0 ? 0 : (mx - mn) / mx; };

  // Most vivid non-white color to use as the accent (--pop).
  function pickPop(t) {
    const cands = [t.secondary, ...t.hi, t.primary].filter(c => c && c.toUpperCase() !== '#FFFFFF');
    let best = cands[0], bs = -1;
    for (const c of cands) { const l = lum(c), score = sat(c) * (1 - Math.abs(l - 0.55)) * (l > 0.03 ? 1 : 0.4); if (score > bs) { bs = score; best = c; } }
    return best || t.secondary;
  }

  // ----------------------------------------------------------------- the teams
  // primary = the DOMINANT strong color (not literal "primary"); hi = extra
  // highlight colors (helmet-stripe footer, swatches, multi-color emblems);
  // motif = which CSS emblem to draw.
  const TEAMS = [
    ['Arizona', 'Cardinals', '#97233F', '#000000', ['#FFB612', '#FFFFFF'], 'feather'],
    ['Atlanta', 'Falcons', '#A71930', '#000000', ['#A5ACAF', '#FFFFFF'], 'feather'],
    ['Baltimore', 'Ravens', '#241773', '#000000', ['#9E7C0C', '#C60C30'], 'feather'],
    ['Buffalo', 'Bills', '#00338D', '#C60C30', ['#FFFFFF'], 'horns'],
    ['Carolina', 'Panthers', '#0085CA', '#101820', ['#BFC0BF', '#FFFFFF'], 'claw'],
    ['Chicago', 'Bears', '#0B162A', '#C83803', ['#FFFFFF'], 'claw'],
    ['Cincinnati', 'Bengals', '#FB4F14', '#000000', ['#FFFFFF'], 'stripe'],
    ['Cleveland', 'Browns', '#311D00', '#FF3C00', ['#FFFFFF'], 'stripe'],
    ['Dallas', 'Cowboys', '#003594', '#869397', ['#FFFFFF', '#041E42'], 'star'],
    ['Denver', 'Broncos', '#FB4F14', '#002244', ['#FFFFFF'], 'horns'],
    ['Detroit', 'Lions', '#0076B6', '#B0B7BC', ['#000000', '#FFFFFF'], 'claw'],
    ['Green Bay', 'Packers', '#203731', '#FFB612', ['#FFFFFF'], 'GB'],
    ['Houston', 'Texans', '#03202F', '#A71930', ['#FFFFFF'], 'horns'],
    ['Indianapolis', 'Colts', '#002C5F', '#A2AAAD', ['#FFFFFF'], 'horseshoe'],
    ['Jacksonville', 'Jaguars', '#006778', '#101820', ['#D7A22A', '#9F792C'], 'claw'],
    ['Kansas City', 'Chiefs', '#E31837', '#FFB81C', ['#FFFFFF'], 'arrow'],
    ['Las Vegas', 'Raiders', '#000000', '#A5ACAF', ['#FFFFFF'], 'shield'],
    ['Los Angeles', 'Chargers', '#0080C6', '#FFC20E', ['#002A5E', '#FFFFFF'], 'bolt'],
    ['Los Angeles', 'Rams', '#003594', '#FFA300', ['#FFD100', '#FFFFFF'], 'horns'],
    ['Miami', 'Dolphins', '#008E97', '#FC4C02', ['#005778', '#FFFFFF'], 'wave'],
    ['Minnesota', 'Vikings', '#4F2683', '#FFC62F', ['#FFFFFF'], 'horns'],
    ['New England', 'Patriots', '#002244', '#C60C30', ['#B0B7BC', '#FFFFFF'], 'star'],
    ['New Orleans', 'Saints', '#101820', '#D3BC8D', ['#FFFFFF'], 'fleur'],
    ['New York', 'Giants', '#0B2265', '#A71930', ['#A5ACAF', '#FFFFFF'], 'shield'],
    ['New York', 'Jets', '#125740', '#FFFFFF', ['#000000'], 'stripe'],
    ['Philadelphia', 'Eagles', '#004C54', '#A5ACAF', ['#000000', '#ACC0C6'], 'feather'],
    ['Pittsburgh', 'Steelers', '#101820', '#FFB612', ['#C60C30', '#00539B', '#FFB612'], 'stars3'],
    ['San Francisco', '49ers', '#AA0000', '#B3995D', ['#FFFFFF'], 'shield'],
    ['Seattle', 'Seahawks', '#002244', '#69BE28', ['#A5ACAF', '#FFFFFF'], 'feather'],
    ['Tampa Bay', 'Buccaneers', '#D50A0A', '#34302B', ['#FF7900', '#B1BABF'], 'flag'],
    ['Tennessee', 'Titans', '#0C2340', '#4B92DB', ['#C8102E', '#A2AAAD'], 'stars3'],
    ['Washington', 'Commanders', '#5A1414', '#FFB612', ['#FFFFFF'], 'WAS'],
  ].map(a => ({ city: a[0], name: a[1], primary: a[2], secondary: a[3], hi: a[4], motif: a[5] }));

  // ------------------------------------------------------------ team emblems
  // Monochrome, original silhouettes that evoke the helmet — NOT official logos.
  // Returned as a data:image/svg+xml URI for background-image.
  function starPath(cx, cy, o, i, rot = 0) { let p = '', a = rot - Math.PI / 2; for (let k = 0; k < 10; k++) { const r = k % 2 ? i : o; p += (k ? 'L' : 'M') + (cx + Math.cos(a) * r).toFixed(1) + ',' + (cy + Math.sin(a) * r).toFixed(1); a += Math.PI / 5; } return p + 'Z'; }

  function emblem(m, g, ac, hi) {                       // g=glyph color, ac=accent, hi=highlight array
    hi = hi || [];
    switch (m) {
      case 'star':      return `<path d="${starPath(50, 50, 32, 13)}" fill="${g}"/>`;
      case 'stars3':    return [[32, 44], [50, 38], [68, 44]].map((p, i) => `<path d="${starPath(p[0], p[1], 13, 5.5)}" fill="${hi[i] || g}"/>`).join('');
      case 'horns':     return `<path d="M50,74 C30,74 16,52 20,28 C34,40 42,52 50,52 C58,52 66,40 80,28 C84,52 70,74 50,74 Z" fill="${g}"/>`;
      case 'horseshoe': return `<path d="M30,26 A24,28 0 1 0 70,26 L60,28 A15,19 0 1 1 40,28 Z" fill="${g}"/>`;
      case 'arrow':     return `<path d="M50,18 L80,66 L50,55 L20,66 Z" fill="${g}"/>`;
      case 'bolt':      return `<path d="M58,16 L32,54 L47,54 L40,84 L70,44 L53,44 Z" fill="${g}"/>`;
      case 'wave':      return `<path d="M12,58 Q26,42 40,58 T68,58 T96,58" stroke="${g}" stroke-width="9" fill="none" stroke-linecap="round"/><path d="M12,72 Q26,56 40,72 T68,72 T96,72" stroke="${ac}" stroke-width="6" fill="none" stroke-linecap="round" opacity=".8"/>`;
      case 'claw':      return [0, 1, 2].map(i => `<path transform="rotate(${(i - 1) * 10} 50 50)" d="M${42 + i * 8},22 C${46 + i * 8},44 ${46 + i * 8},60 ${42 + i * 8},80 L${36 + i * 8},74 C${38 + i * 8},58 ${38 + i * 8},42 ${36 + i * 8},26 Z" fill="${i === 1 ? g : (hi[0] || g)}"/>`).join('');
      case 'feather':   return `<path d="M26,32 L74,32 L58,46 L38,46 Z" fill="${g}"/><path d="M32,52 L68,52 L54,64 L44,64 Z" fill="${ac}"/><path d="M40,70 L60,70 L52,80 L46,80 Z" fill="${g}"/>`;
      case 'shield':    return `<path d="M50,18 L78,26 L78,50 C78,68 66,79 50,84 C34,79 22,68 22,50 L22,26 Z" fill="${g}"/><path d="M50,30 L66,35 L66,50 C66,61 59,68 50,72 C41,68 34,61 34,50 L34,35 Z" fill="${ac}"/>`;
      case 'flag':      return `<rect x="33" y="18" width="4" height="64" fill="${g}"/><path d="M37,22 L78,32 L37,44 Z" fill="${g}"/>`;
      case 'fleur':     return `<path d="M50,16 C44,30 40,34 40,46 C40,56 47,58 50,54 C53,58 60,56 60,46 C60,34 56,30 50,16 Z" fill="${g}"/><path d="M30,44 C30,58 42,64 50,60 C42,56 40,48 42,42 C36,40 30,40 30,44 Z" fill="${g}"/><path d="M70,44 C70,58 58,64 50,60 C58,56 60,48 58,42 C64,40 70,40 70,44 Z" fill="${g}"/><rect x="46" y="58" width="8" height="20" fill="${g}"/><rect x="38" y="66" width="24" height="5" rx="2" fill="${ac}"/>`;
      case 'stripe':    return `<rect x="43" y="16" width="14" height="68" fill="${g}"/><rect x="31" y="16" width="6" height="68" fill="${ac}"/><rect x="63" y="16" width="6" height="68" fill="${ac}"/>`;
      default:          return `<text x="50" y="53" text-anchor="middle" dominant-baseline="middle" font-family="Oswald,Arial,sans-serif" font-weight="700" font-size="34" fill="${g}">${m}</text>`; // monogram (GB, WAS)
    }
  }

  function badgeUri(t) {
    const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><rect x='3' y='3' width='94' height='94' rx='22' fill='${t.primary}'/><rect x='4.5' y='4.5' width='91' height='91' rx='20' fill='none' stroke='${t.secondary}' stroke-width='3'/>${emblem(t.motif, ink(t.primary), t.secondary, t.hi)}</svg>`;
    return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
  }
  function watermarkUri(t, light) {                    // light=true → light glyph (for dark hero bg)
    const c = light ? 'rgba(255,255,255,0.9)' : ink(t.primary);
    return `url("data:image/svg+xml,${encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'>${emblem(t.motif, c, c, t.hi)}</svg>`)}")`;
  }

  // -------------------------------------------------------- theme variable sets
  // Balanced: light neutral page, white cards, team drives nav/accents.
  // Takeover: radial team gradient page, dark glass cards, white text, team pops.
  // --pg-solid is an internal helper: a SOLID page color for inputs/dropzones,
  // since --pg itself is a gradient string in Takeover mode.
  function balancedVars(t) {
    const P = t.primary, S = t.secondary, inkP = ink(P), pop = pickPop(t), inkPop = ink(pop);
    return {
      '--tp': P, '--ts': S, '--tink': inkP,
      '--pop': pop, '--pop-ink': inkPop,
      '--pop-solid': lum(pop) > 0.6 ? mix(pop, '#000', 0.28) : pop,
      '--pg': '#F3F4F8', '--pg-solid': '#F3F4F8',
      '--cd': '#FFFFFF', '--cdb': 'rgba(20,24,40,.09)',
      '--tx': '#161A26', '--tb': '#3A4050', '--tm': '#7C8290',
      '--ab': P, '--abi': inkP,
      '--link': lum(P) > 0.6 ? mix(P, '#000', 0.4) : P,
      '--chip': mix(pop, '#FFF', 0.86),
      '--hero1': P, '--hero2': mix(P, '#000', 0.38),
    };
  }
  function takeoverVars(t) {
    const P = t.primary, S = t.secondary, inkP = ink(P), pop = pickPop(t), inkPop = ink(pop);
    return {
      '--tp': lum(P) > 0.7 ? P : mix(P, '#FFF', 0.06), '--ts': S, '--tink': inkP,
      '--pop': pop, '--pop-ink': inkPop,
      '--pop-solid': lum(pop) > 0.55 ? pop : mix(pop, '#FFF', 0.25),
      '--pg': `radial-gradient(1200px 640px at 12% -12%, ${mix(P, '#FFF', 0.14)} 0%, ${mix(P, '#000', 0.42)} 52%, ${mix(P, '#000', 0.72)} 100%)`,
      '--pg-solid': mix(P, '#000', 0.5),
      '--cd': 'rgba(255,255,255,0.055)', '--cdb': 'rgba(255,255,255,0.14)',
      '--tx': '#FFFFFF', '--tb': 'rgba(255,255,255,0.84)', '--tm': 'rgba(255,255,255,0.52)',
      '--ab': mix(P, '#000', 0.5), '--abi': '#FFFFFF',
      '--link': lum(pop) > 0.55 ? pop : mix(pop, '#FFF', 0.3),
      '--chip': 'rgba(255,255,255,0.1)',
      '--hero1': mix(P, '#000', 0.12), '--hero2': mix(P, '#000', 0.55),
    };
  }

  // ----------------------------------------------------------------- state
  const LS_TEAM = 'all22-team', LS_MODE = 'all22-mode';
  let curTeam = 0, curMode = 'balanced';

  function safeGet(k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } }
  function safeSet(k, v) { try { window.localStorage.setItem(k, v); } catch (e) { /* private mode / disabled */ } }

  function randomIndex(not) { let i = Math.floor(Math.random() * TEAMS.length); if (not != null) { while (i === not) i = Math.floor(Math.random() * TEAMS.length); } return i; }

  function load() {
    const savedTeam = parseInt(safeGet(LS_TEAM), 10);
    curTeam = (Number.isInteger(savedTeam) && savedTeam >= 0 && savedTeam < TEAMS.length) ? savedTeam : randomIndex();
    const savedMode = safeGet(LS_MODE);
    curMode = savedMode === 'takeover' ? 'takeover' : 'balanced';
    save(); // persist the first random pick so it stays stable across pages/reloads
  }
  function save() { safeSet(LS_TEAM, String(curTeam)); safeSet(LS_MODE, curMode); }

  // ----------------------------------------------------------------- apply
  function applyTheme() {
    const t = TEAMS[curTeam];
    const vars = curMode === 'takeover' ? takeoverVars(t) : balancedVars(t);
    const root = document.documentElement;
    for (const k in vars) root.style.setProperty(k, vars[k]);
    root.style.setProperty('--wm', watermarkUri(t, true)); // hero bg is always the dark team gradient
    root.setAttribute('data-team', t.city + ' ' + t.name);
    root.setAttribute('data-mode', curMode);
    syncPicker();
    buildStripe();
  }

  function setTeam(i) { if (i == null) return; curTeam = ((i % TEAMS.length) + TEAMS.length) % TEAMS.length; save(); applyTheme(); }
  function setMode(m) { curMode = m === 'takeover' ? 'takeover' : 'balanced'; save(); applyTheme(); }
  function reroll() { setTeam(randomIndex(curTeam)); }

  // ----------------------------------------------------------------- picker UI
  let els = {}; // cached references to injected picker nodes

  function makeEl(tag, cls, text) { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }

  function teamRow(t, i) {
    const row = makeEl('div', 'team-row');
    row.setAttribute('role', 'option');
    row.dataset.i = String(i);
    const badge = makeEl('span', 'team-badge'); badge.style.backgroundImage = badgeUri(t);
    const name = makeEl('span', 'tr-name');
    name.appendChild(makeEl('span', null, t.city + ' '));
    const strong = document.createElement('b'); strong.textContent = t.name; name.appendChild(strong);
    const sw = makeEl('span', 'tr-swatches');
    [t.primary, t.secondary, ...t.hi].slice(0, 4).forEach(c => { const s = makeEl('span', 'sw'); s.style.background = c; sw.appendChild(s); });
    const chk = makeEl('span', 'tr-check', '✓');
    row.append(badge, name, sw, chk);
    row.addEventListener('click', () => { setTeam(i); closePanel(); });
    return row;
  }

  function buildPicker() {
    const nav = document.querySelector('nav');
    if (!nav || nav.querySelector('.theme-controls')) return; // no nav (login) or already built

    const wrap = makeEl('div', 'theme-controls');

    // Balanced / Takeover segmented toggle
    const toggle = makeEl('div', 'mode-toggle');
    toggle.setAttribute('role', 'group');
    const bBal = makeEl('button', null, 'Balanced'); bBal.type = 'button'; bBal.dataset.mode = 'balanced';
    const bTake = makeEl('button', null, 'Takeover'); bTake.type = 'button'; bTake.dataset.mode = 'takeover';
    bBal.addEventListener('click', () => setMode('balanced'));
    bTake.addEventListener('click', () => setMode('takeover'));
    toggle.append(bBal, bTake);

    // Re-roll (dice) — jumps to a random team different from the current one
    const dice = makeEl('button', 'reroll', '🎲'); dice.type = 'button'; dice.title = 'Random team';
    dice.setAttribute('aria-label', 'Random team');
    dice.addEventListener('click', reroll);

    // Team trigger + dropdown panel
    const picker = makeEl('div', 'team-picker');
    const trigger = makeEl('button', 'team-trigger'); trigger.type = 'button';
    trigger.setAttribute('aria-haspopup', 'listbox'); trigger.setAttribute('aria-expanded', 'false');
    const tBadge = makeEl('span', 'team-badge');
    const tName = makeEl('span', 'team-name');
    const tCity = makeEl('span', 'tt-city'); const tTeam = makeEl('span', 'tt-team');
    tName.append(tCity, document.createTextNode(' '), tTeam);
    const caret = makeEl('span', 'caret', '▾');
    trigger.append(tBadge, tName, caret);
    trigger.addEventListener('click', e => { e.stopPropagation(); togglePanel(); });

    const panel = makeEl('div', 'team-panel hidden'); panel.setAttribute('role', 'listbox');
    // RANDOM row first
    const rnd = makeEl('div', 'team-row random');
    const chip = makeEl('span', 'rnd-chip', '🎲');
    const rndName = makeEl('span', 'tr-name'); const rb = document.createElement('b'); rb.textContent = 'RANDOM'; rndName.appendChild(rb);
    rnd.append(chip, rndName);
    rnd.addEventListener('click', () => { reroll(); closePanel(); });
    panel.appendChild(rnd);
    panel.appendChild(makeEl('div', 'panel-sep'));
    TEAMS.forEach((t, i) => panel.appendChild(teamRow(t, i)));

    picker.append(trigger, panel);
    wrap.append(toggle, dice, picker);

    const form = nav.querySelector('form');
    if (form) nav.insertBefore(wrap, form); else nav.appendChild(wrap);

    els = { toggle, trigger, tBadge, tCity, tTeam, panel, picker };
    syncPicker();
  }

  function syncPicker() {
    if (!els.trigger) return;
    const t = TEAMS[curTeam];
    els.tBadge.style.backgroundImage = badgeUri(t);
    els.tCity.textContent = t.city;
    els.tTeam.textContent = t.name;
    els.toggle.querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.mode === curMode));
    els.panel.querySelectorAll('.team-row[data-i]').forEach(r => r.classList.toggle('active', Number(r.dataset.i) === curTeam));
    const active = els.panel.querySelector('.team-row.active');
    if (active && !els.panel.classList.contains('hidden')) active.scrollIntoView({ block: 'nearest' });
  }

  function openPanel() { if (!els.panel) return; els.panel.classList.remove('hidden'); els.trigger.setAttribute('aria-expanded', 'true'); syncPicker(); }
  function closePanel() { if (!els.panel) return; els.panel.classList.add('hidden'); els.trigger.setAttribute('aria-expanded', 'false'); }
  function togglePanel() { if (!els.panel) return; els.panel.classList.contains('hidden') ? openPanel() : closePanel(); }

  document.addEventListener('click', e => { if (els.picker && !els.picker.contains(e.target)) closePanel(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closePanel(); });

  // ------------------------------------------------------- helmet-stripe footer
  // A thin bar of equal segments from [primary, secondary, ...hi] — where each
  // team's highlight colors show up (Steelers stars, Bucs orange, Titans red).
  function buildStripe() {
    if (!document.body) return;
    let strip = document.querySelector('.helmet-stripe');
    if (!strip) { strip = makeEl('div', 'helmet-stripe'); strip.setAttribute('aria-hidden', 'true'); document.body.appendChild(strip); }
    const t = TEAMS[curTeam];
    const cols = [t.primary, t.secondary, ...t.hi].slice(0, 5);
    strip.textContent = '';
    cols.forEach(c => { const seg = makeEl('span'); seg.style.background = c; strip.appendChild(seg); });
  }

  // ----------------------------------------------------------------- init
  load();
  applyTheme(); // set vars immediately (may run in <head>, before <body> exists)

  function onReady() { buildPicker(); buildStripe(); applyTheme(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', onReady);
  else onReady();

  // Small public API for programmatic control (and screenshot/e2e harnesses).
  window.All22Theme = {
    teams: TEAMS,
    setTeam: setTeam,
    setMode: setMode,
    reroll: reroll,
    badgeUri: badgeUri,
    current: () => ({ team: curTeam, mode: curMode, name: TEAMS[curTeam].city + ' ' + TEAMS[curTeam].name }),
    _vars: (i, m) => (m === 'takeover' ? takeoverVars : balancedVars)(TEAMS[i]),
  };
})();
