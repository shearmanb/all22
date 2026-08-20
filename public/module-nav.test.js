// Tests for the nav/tile enhancer's route mapping (public/module-nav.js). The
// DOM enhancement needs a browser, but idFor — the piece that decides which nav
// link/card maps to which module — is pure and covered here, cross-checked
// against the real module registry so a renamed route or module fails loudly.
const test = require('node:test');
const assert = require('node:assert');
const nav = require('./module-nav');
const MI = require('./module-icon');

test('idFor: every app route maps to a module that actually exists', () => {
  const routes = {
    '/': 'hub',
    '/combine.html': 'combine',
    '/myrankings.html': 'myrankings',
    '/boards.html': 'bigboard',
    '/auction.html': 'warchest',
    '/drafts.html': 'playbook',
    '/warroom.html': 'warroom',
    '/adp.html': 'edgerush',
    '/players.html': 'playerdb',
    '/notes.html': 'notes',
    '/wire.html': 'thewire',
    '/settings.html': 'settings',
  };
  for (const [href, id] of Object.entries(routes)) {
    assert.strictEqual(nav.idFor(href), id, `${href} -> ${id}`);
    assert.strictEqual(MI.byId(id).id, id, `${id} is a real module`);
  }
  // All 11 modules are reachable from some route.
  assert.strictEqual(new Set(Object.values(routes)).size, MI.MODULES.length);
});

test('idFor: tolerant of absolute URLs, query/hash, index.html and Playbook sub-pages', () => {
  assert.strictEqual(nav.idFor('https://all22.example/combine.html'), 'combine');
  assert.strictEqual(nav.idFor('/combine.html?tab=review'), 'combine');
  assert.strictEqual(nav.idFor('/adp.html#board'), 'edgerush');
  assert.strictEqual(nav.idFor('/index.html'), 'hub');
  assert.strictEqual(nav.idFor('/drafts-new.html'), 'playbook');
  assert.strictEqual(nav.idFor('/warroom-draft.html'), 'warroom');
  assert.strictEqual(nav.idFor('/draft-detail.html'), 'playbook');
});

test('idFor: non-module links (brand, logout, the gallery) map to nothing', () => {
  assert.strictEqual(nav.idFor(''), null);
  assert.strictEqual(nav.idFor(null), null);
  assert.strictEqual(nav.idFor('/logout'), null);
  assert.strictEqual(nav.idFor('/module-icon.html'), null);
});

test('HREF_TO_ID: no dangling targets — every mapped id is in the registry', () => {
  for (const id of Object.values(nav.HREF_TO_ID)) {
    assert.doesNotThrow(() => MI.byId(id), `${id} must be a real module`);
  }
});
