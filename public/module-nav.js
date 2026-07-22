// ModuleIcon nav + Hub-tile enhancer. Loaded on every page after module-icon.js.
//
// Upgrades the existing text nav links and the Hub launcher cards IN PLACE with
// ModuleIcon glyphs — no per-page markup changes. It maps each link/card to a
// module by its href, so one script works on any page's nav (the same approach
// theme.js uses to inject the team picker everywhere).
//
//   - Nav links  -> app-bar chips: glyph mono in --abi, or the --pop pill/glyph
//                   when the link is the active page. (The nav IS the team app
//                   bar, so module hues never appear there — chrome stays team-owned.)
//   - Hub tiles  -> the launcher card's <h2> becomes a hued module chip, where the
//                   permanent module hue lives (content, not chrome).
//
// UMD-wrapped like auction-math.js so idFor() is unit-testable in Node; the DOM
// work no-ops when there's no document.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ModuleNav = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Which module each page route belongs to. Keys are the site's real page paths.
  var HREF_TO_ID = {
    '/': 'hub',
    '/combine.html': 'combine',
    '/myrankings.html': 'myrankings',
    '/boards.html': 'bigboard',
    '/auction.html': 'warchest',
    '/drafts.html': 'playbook',
    '/adp.html': 'edgerush',
    '/players.html': 'playerdb',
    '/notes.html': 'notes',
    '/wire.html': 'thewire',
    '/settings.html': 'settings',
  };

  // Route -> moduleId, tolerant of absolute URLs, query/hash, and /index.html.
  // Playbook's sub-pages (drafts-new, draft-detail) still belong to Playbook.
  function idFor(href) {
    if (!href) return null;
    var path = String(href).replace(/^[a-z]+:\/\/[^/]+/i, '').split(/[?#]/)[0];
    if (path === '' || path === '/index.html') path = '/';
    if (path === '/drafts-new.html' || path === '/draft-detail.html') path = '/drafts.html';
    return HREF_TO_ID[path] || null;
  }

  // Replace a nav link's text with an app-bar chip (mono glyph, --pop when active).
  function enhanceNav(doc, MI) {
    var links = doc.querySelectorAll('nav a[href]');
    for (var i = 0; i < links.length; i++) {
      var a = links[i];
      if (a.getAttribute('data-modicon')) continue;   // idempotent
      var id = idFor(a.getAttribute('href'));
      if (!id) continue;                               // brand, logout, unknown -> left alone
      a.textContent = '';
      a.appendChild(MI.create({
        moduleId: id, variant: 'chip', context: 'appbar',
        active: a.classList.contains('active'), showDescriptor: false,
      }));
      a.classList.add('mod-navlink');
      a.setAttribute('data-modicon', '1');
    }
  }

  // Replace each Hub launcher card's <h2> with a hued module chip.
  function enhanceTiles(doc, MI) {
    var tiles = doc.querySelectorAll('.tiles a.tile[href]');
    for (var i = 0; i < tiles.length; i++) {
      var t = tiles[i];
      if (t.getAttribute('data-modicon')) continue;
      var id = idFor(t.getAttribute('href'));
      if (!id) continue;                               // e.g. the "War Room" coming-soon card (no href)
      var h = t.querySelector('h2');
      if (!h) continue;
      h.textContent = '';
      h.appendChild(MI.create({ moduleId: id, variant: 'chip', showDescriptor: false })); // module hue
      t.setAttribute('data-modicon', '1');
    }
  }

  function enhance() {
    if (typeof document === 'undefined' || typeof ModuleIcon === 'undefined') return;
    enhanceNav(document, ModuleIcon);
    enhanceTiles(document, ModuleIcon);
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', enhance);
    else enhance();
  }

  return { HREF_TO_ID: HREF_TO_ID, idFor: idFor, enhance: enhance };
});
