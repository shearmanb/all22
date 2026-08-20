// Golden tests for the ModuleIcon wayfinding component (public/module-icon.js).
// The DOM-building helpers (create/render) need a browser; everything testable
// in Node — the module registry, the luminance ink rule, the SVG wrapper, prop
// resolution and the markup string — is covered here.
const test = require('node:test');
const assert = require('node:assert');
const MI = require('./module-icon');

test('MODULES: 12 modules, unique ids, well-formed hex hues + required fields', () => {
  assert.strictEqual(MI.MODULES.length, 12);
  const ids = MI.MODULES.map((m) => m.id);
  assert.strictEqual(new Set(ids).size, 12, 'ids must be unique');
  const hex = /^#[0-9A-Fa-f]{6}$/;
  for (const m of MI.MODULES) {
    assert.ok(m.name && m.descriptor && m.glyph, `${m.id} needs name/descriptor/glyph`);
    assert.match(m.hue, hex, `${m.id}.hue is a 6-digit hex`);
    assert.match(m.hueLight, hex, `${m.id}.hueLight is a 6-digit hex`);
  }
});

test('MODULES: the exact 12 ids the app ships, in order', () => {
  assert.deepStrictEqual(MI.MODULES.map((m) => m.id), [
    'hub', 'combine', 'myrankings', 'bigboard', 'warchest',
    'playbook', 'edgerush', 'warroom', 'playerdb', 'notes', 'thewire', 'settings',
  ]);
});

test('byId: looks up a module; unknown id throws a helpful error', () => {
  assert.strictEqual(MI.byId('combine').name, 'Combine');
  assert.throws(() => MI.byId('nope'), /unknown moduleId "nope"/);
  assert.throws(() => MI.byId(undefined), /Known ids:/);
});

test('ink: dark ink on light, white on dark, at the 0.45 luminance threshold', () => {
  assert.strictEqual(MI.ink('#FFFFFF'), '#141824');
  assert.strictEqual(MI.ink('#F3F4F8'), '#141824'); // Balanced page
  assert.strictEqual(MI.ink('#000000'), '#FFFFFF');
  assert.strictEqual(MI.ink('#0B162A'), '#FFFFFF'); // a dark team primary
  // Mid greys straddle the threshold the same way theme.js's --pop-ink does.
  assert.strictEqual(MI.ink('#B8B8B8'), '#141824', 'lum > 0.45 -> dark');
  assert.strictEqual(MI.ink('#6E6E6E'), '#FFFFFF', 'lum < 0.45 -> white');
});

test('svg: wraps the glyph in a 24x24 currentColor stroke SVG', () => {
  const s = MI.svg('hub');
  assert.match(s, /viewBox="0 0 24 24"/);
  assert.match(s, /stroke="currentColor"/);
  assert.match(s, /stroke-width="1.8"/);
  assert.match(s, /fill="none"/);
  assert.match(s, /aria-hidden="true"/);
  assert.ok(s.includes(MI.byId('hub').glyph), 'glyph markup injected verbatim');
});

test('My Rankings star keeps fill="currentColor" so the solid shape follows the stroke', () => {
  // Guards the one glyph that mixes a stroked list with a solid star.
  assert.ok(MI.byId('myrankings').glyph.includes('fill="currentColor"'));
  assert.ok(MI.svg('myrankings').includes('fill="currentColor"'));
});

test('resolveOptions: defaults — chip / balanced / content / no descriptor', () => {
  const r = MI.resolveOptions({ moduleId: 'notes' });
  assert.strictEqual(r.variant, 'chip');
  assert.strictEqual(r.mode, 'balanced'); // no DOM in Node -> ambient falls back to balanced
  assert.strictEqual(r.modeLocked, false);
  assert.strictEqual(r.context, 'content');
  assert.strictEqual(r.active, false);
  assert.strictEqual(r.showDescriptor, false);
});

test('resolveOptions: tile shows the descriptor by default; either variant can override', () => {
  assert.strictEqual(MI.resolveOptions({ moduleId: 'notes', variant: 'tile' }).showDescriptor, true);
  assert.strictEqual(MI.resolveOptions({ moduleId: 'notes', variant: 'tile', showDescriptor: false }).showDescriptor, false);
  assert.strictEqual(MI.resolveOptions({ moduleId: 'notes', showDescriptor: true }).showDescriptor, true);
});

test('resolveOptions: an explicit mode locks the instance; junk falls back to ambient', () => {
  assert.deepStrictEqual(
    [MI.resolveOptions({ moduleId: 'notes', mode: 'takeover' }).mode,
     MI.resolveOptions({ moduleId: 'notes', mode: 'takeover' }).modeLocked],
    ['takeover', true]
  );
  const junk = MI.resolveOptions({ moduleId: 'notes', mode: 'neon' });
  assert.strictEqual(junk.mode, 'balanced');
  assert.strictEqual(junk.modeLocked, false);
});

test('resolveOptions: unknown variant/context coerce to the safe defaults', () => {
  const r = MI.resolveOptions({ moduleId: 'notes', variant: 'blob', context: 'sidebar' });
  assert.strictEqual(r.variant, 'chip');
  assert.strictEqual(r.context, 'content');
});

test('markup: chip carries hue vars, module id, state attrs, and the name', () => {
  const html = MI.markup({ moduleId: 'combine' });
  assert.match(html, /class="mod-icon mod-icon--chip"/);
  assert.match(html, /data-module="combine"/);
  assert.match(html, /data-mode="balanced"/);
  assert.match(html, /data-context="content"/);
  assert.match(html, /--mi-hue:#F2A33C;--mi-hue-light:#F6BE74/);
  assert.match(html, /<span class="mod-name">Combine<\/span>/);
  assert.ok(!html.includes('mod-descriptor'), 'chip omits the descriptor by default');
  assert.ok(!html.includes('data-mi-lock'), 'ambient (unlocked) icon has no lock attr');
});

test('markup: tile stacks name + descriptor and marks a locked mode', () => {
  const html = MI.markup({ moduleId: 'warchest', variant: 'tile', mode: 'takeover' });
  assert.match(html, /class="mod-icon mod-icon--tile"/);
  assert.match(html, /data-mode="takeover"/);
  assert.match(html, /data-mi-lock=""/);
  assert.match(html, /<span class="mod-name">War Chest<\/span>/);
  assert.match(html, /<span class="mod-descriptor">Auction budget<\/span>/);
});

test('markup: appbar context and active state flip the right hooks', () => {
  const bar = MI.markup({ moduleId: 'hub', context: 'appbar' });
  assert.match(bar, /data-context="appbar"/);

  const active = MI.markup({ moduleId: 'hub', active: true });
  assert.match(active, /class="mod-icon mod-icon--chip is-active"/);
});

test('markup: the descriptor text is present raw (CSS handles the uppercasing)', () => {
  // "Blend & weight" also checks the & is HTML-escaped, not left bare.
  const html = MI.markup({ moduleId: 'myrankings', showDescriptor: true });
  assert.ok(html.includes('Blend &amp; weight'));
  assert.ok(!html.includes('Blend & weight'));
});

test('markup: unknown module throws (never renders a blank/guessed icon)', () => {
  assert.throws(() => MI.markup({ moduleId: 'sideline' }), /unknown moduleId/);
});
