// ModuleIcon — All22's wayfinding identity layer. One file, no build step, no deps.
//
// Each of the 11 modules owns a PERMANENT hue that never re-themes per team.
// The NFL team theme (public/theme.js) owns chrome/nav/active-state; module hues
// are wayfinding ONLY, drawn as tinted duotone chips — never large background
// fills — so the theme's "max 1-2 background colors" rule stays intact.
//
// Shared verbatim by the browser (pages load /module-icon.js) and Node (tests
// require it), like features/auction/public/auction-math.js — hence the UMD
// wrapper. The pure surface (MODULES, byId, ink, svg, markup, resolveOptions)
// runs in Node; create()/render() need a DOM.
//
// Coloring is CSS-driven: each instance carries its hue on --mi-hue/--mi-hue-light
// (inline) and its state on data-mode / data-context / .is-active; app.css turns
// those into the per-mode duotone recipe with color-mix(). This file only builds
// the markup and keeps unlocked icons in sync when the team theme flips modes.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ModuleIcon = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ------------------------------------------------------------------ module data
  // id, name, descriptor, hue (permanent), hueLight (lightened hue for the dark
  // Takeover chassis), glyph (inner SVG markup for a 0 0 24 24 viewBox, drawn
  // fill=none stroke=currentColor stroke-width=1.8 round caps/joins). Solid shapes
  // (the My Rankings star) use fill="currentColor" so they follow the stroke color.
  var MODULES = [
    { id: 'hub',        name: 'Hub',         descriptor: 'Home base',       hue: '#5B8DEF', hueLight: '#8FB3F5', glyph: `<path d="M4 11.2 12 5l8 6.2"/><path d="M6 10v9h12v-9"/><path d="M10 19v-4.5h4V19"/>` },
    { id: 'combine',    name: 'Combine',     descriptor: 'Ingest rankings', hue: '#F2A33C', hueLight: '#F6BE74', glyph: `<path d="M9.4 3h5.2M12 3v2.2"/><circle cx="12" cy="13.6" r="7"/><path d="M12 9v6M9.3 12.5l2.7 2.8 2.7-2.8"/>` },
    { id: 'myrankings', name: 'My Rankings', descriptor: 'Blend & weight',  hue: '#9F7BEA', hueLight: '#BBA0F1', glyph: `<path d="M4 6.5h9M4 12h9M4 17.5h6"/><path d="M18 3.6l1.1 2.3 2.5.3-1.8 1.7.45 2.5-2.25-1.2-2.25 1.2.45-2.5L14.4 6.2l2.5-.3z" fill="currentColor" stroke="none"/>` },
    { id: 'bigboard',   name: 'Big Board',   descriptor: 'Hand-built lists', hue: '#3FC9A6', hueLight: '#6FDBBE', glyph: `<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 3.2h6v3H9z"/><path d="M8.5 11h7M8.5 15h5"/>` },
    { id: 'warchest',   name: 'War Chest',   descriptor: 'Auction budget',  hue: '#E4C24C', hueLight: '#ECD277', glyph: `<rect x="3" y="4.2" width="9" height="3.2" rx="1.4"/><path d="M6 4.2v3.2M9 4.2v3.2"/><path d="M7.5 7.4v6.4"/><rect x="3" y="14.4" width="9" height="2.6" rx="1.1"/><path d="M18 8.8v9.4"/><path d="M20 10.6c0-.9-.9-1.5-2-1.5s-2 .6-2 1.5.8 1.3 2 1.6 2 .7 2 1.6-.9 1.5-2 1.5-2-.6-2-1.5"/>` },
    { id: 'playbook',   name: 'Playbook',    descriptor: 'Draft log',       hue: '#E06B5B', hueLight: '#EB8F83', glyph: `<circle cx="6" cy="6" r="2.3"/><path d="M6 8.4c0 5.6 11 2.3 11 9.4"/><path d="M14 15.5l3 3 3-3"/><path d="M3.4 20l2.6-2.6M6 20l-2.6-2.6"/>` },
    { id: 'edgerush',   name: 'Edge Rush',   descriptor: 'ADP intel',       hue: '#3ECFE8', hueLight: '#71DEF0', glyph: `<path d="M13.5 2.5 5.5 13h5l-2 8.5L18.5 10h-5z"/>` },
    { id: 'warroom',    name: 'War Room',    descriptor: 'Live draft',      hue: '#D96BA8', hueLight: '#E495C1', glyph: `<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M3.5 9.5h17M9.2 9.5v10M14.8 9.5v10"/><circle cx="6.4" cy="14" r="1.3" fill="currentColor" stroke="none"/>` },
    { id: 'playerdb',   name: 'Player DB',   descriptor: 'Player registry', hue: '#7E8CE0', hueLight: '#A2ADEB', glyph: `<ellipse cx="12" cy="5.5" rx="7.5" ry="2.8"/><path d="M4.5 5.5v13c0 1.6 3.4 2.9 7.5 2.9s7.5-1.3 7.5-2.9v-13"/><path d="M4.5 12c0 1.6 3.4 2.9 7.5 2.9s7.5-1.3 7.5-2.9"/>` },
    { id: 'notes',      name: 'Notes',       descriptor: 'Scratchpad',      hue: '#8BC96A', hueLight: '#A9D98F', glyph: `<path d="M5.5 3.5H15l4 4V20.5H5.5z"/><path d="M15 3.5v4h4"/><path d="M8.5 12h7M8.5 15.5h5"/>` },
    { id: 'thewire',    name: 'The Wire',    descriptor: 'News desk',       hue: '#E8965C', hueLight: '#EEB185', glyph: `<path d="M12 13v8"/><circle cx="12" cy="10" r="1.8"/><path d="M8.2 13.8a5.5 5.5 0 0 1 0-7.6M15.8 6.2a5.5 5.5 0 0 1 0 7.6M5.8 16.2a9 9 0 0 1 0-12.4M18.2 3.8a9 9 0 0 1 0 12.4"/>` },
    { id: 'settings',   name: 'Settings',    descriptor: 'Preferences',     hue: '#8A97AD', hueLight: '#AEB8C7', glyph: `<circle cx="12" cy="12" r="3.2"/><path d="M19.4 13a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2v.2a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-2.9-1.2l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0-1.2-2.9H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.2-2.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 2.9 1.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>` },
  ];

  var BY_ID = {};
  MODULES.forEach(function (m) { BY_ID[m.id] = m; });

  function byId(id) {
    var m = BY_ID[id];
    if (!m) {
      throw new Error('ModuleIcon: unknown moduleId "' + id + '". Known ids: ' +
        MODULES.map(function (x) { return x.id; }).join(', '));
    }
    return m;
  }

  // ------------------------------------------------------------------ color math
  // Same WCAG relative-luminance ink rule public/theme.js uses for --pop-ink:
  // wherever a hue backs text, dark ink on light, white on dark (threshold 0.45).
  // The chip/tile labels sit on the CHASSIS (not the hue), so their color is the
  // mode's fixed chassis ink (#161A26 / #fff) in app.css — this helper is for any
  // consumer that puts text directly on a module hue.
  function rgb(h) {
    h = String(h).replace('#', '');
    if (h.length === 3) h = h.split('').map(function (c) { return c + c; }).join('');
    return [0, 2, 4].map(function (i) { return parseInt(h.slice(i, i + 2), 16); });
  }
  function lum(h) {
    var c = rgb(h).map(function (v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  }
  function ink(h) { return lum(h) > 0.45 ? '#141824' : '#FFFFFF'; }

  // ------------------------------------------------------------------ markup
  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // Wrap a module's inner glyph markup in a sized SVG. Size comes from CSS
  // (.mod-icon--chip / --tile set --mi-svg), so one string serves both variants.
  // glyph is trusted (this file's own constant), so injecting it as markup is safe.
  function svgMarkup(glyph) {
    return '<svg class="mod-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor"' +
      ' stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"' +
      ' aria-hidden="true" focusable="false">' + glyph + '</svg>';
  }

  function svg(moduleId) { return svgMarkup(byId(moduleId).glyph); }

  // The active team theme's mode, read from <html data-mode> (set by theme.js).
  function ambientMode() {
    if (typeof document === 'undefined' || !document.documentElement) return 'balanced';
    return document.documentElement.getAttribute('data-mode') === 'takeover' ? 'takeover' : 'balanced';
  }

  // Normalize raw props into the resolved shape the markup + tests rely on.
  // mode: an explicit 'balanced'|'takeover' LOCKS the instance (it ignores later
  // theme flips); anything else falls back to the live ambient mode.
  function resolveOptions(opts) {
    opts = opts || {};
    var mod = byId(opts.moduleId);
    var variant = opts.variant === 'tile' ? 'tile' : 'chip';
    var lockedMode = (opts.mode === 'balanced' || opts.mode === 'takeover') ? opts.mode : null;
    var context = opts.context === 'appbar' ? 'appbar' : 'content';
    var showDescriptor = (opts.showDescriptor === undefined || opts.showDescriptor === null)
      ? (variant === 'tile')            // tiles show the descriptor by default; chips don't
      : !!opts.showDescriptor;
    return {
      module: mod,
      variant: variant,
      mode: lockedMode || ambientMode(),
      modeLocked: !!lockedMode,
      context: context,
      active: !!opts.active,
      showDescriptor: showDescriptor,
    };
  }

  // Build the component's HTML string. Structure is identical for chip and tile;
  // app.css lays chip out as a row (glyph + name inline) and tile as a centered
  // column (glyph over stacked name + descriptor).
  function markup(opts) {
    var r = resolveOptions(opts);
    var m = r.module;
    var cls = 'mod-icon mod-icon--' + r.variant + (r.active ? ' is-active' : '');
    var lock = r.modeLocked ? ' data-mi-lock=""' : '';
    return '<span class="' + cls + '" data-module="' + esc(m.id) + '"' +
      ' data-mode="' + r.mode + '" data-context="' + r.context + '"' +
      ' style="--mi-hue:' + esc(m.hue) + ';--mi-hue-light:' + esc(m.hueLight) + '"' + lock + '>' +
        '<span class="mod-glyph">' + svgMarkup(m.glyph) + '</span>' +
        '<span class="mod-label">' +
          '<span class="mod-name">' + esc(m.name) + '</span>' +
          (r.showDescriptor ? '<span class="mod-descriptor">' + esc(m.descriptor) + '</span>' : '') +
        '</span>' +
      '</span>';
  }

  // ------------------------------------------------------------------ DOM (browser)
  // Keep unlocked icons following the live team theme: when theme.js rewrites
  // <html data-mode>, mirror it onto every icon that didn't lock a mode.
  var observing = false;
  function ensureObserver() {
    if (observing || typeof MutationObserver === 'undefined' || typeof document === 'undefined') return;
    observing = true;
    var mo = new MutationObserver(function () {
      var mode = ambientMode();
      var icons = document.querySelectorAll('.mod-icon:not([data-mi-lock])');
      for (var i = 0; i < icons.length; i++) icons[i].setAttribute('data-mode', mode);
    });
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-mode'] });
  }

  // Return a detached DOM node for the icon. The <template> parse gives the inner
  // <svg> its correct namespace for free.
  function create(opts) {
    if (typeof document === 'undefined') throw new Error('ModuleIcon.create requires a DOM (browser only).');
    var tpl = document.createElement('template');
    tpl.innerHTML = markup(opts).trim();
    ensureObserver();
    return tpl.content.firstElementChild;
  }

  // Convenience: build the icon and append it into target (a node or selector).
  function render(target, opts) {
    if (typeof document === 'undefined') throw new Error('ModuleIcon.render requires a DOM (browser only).');
    var host = typeof target === 'string' ? document.querySelector(target) : target;
    if (!host) return null;
    var el = create(opts);
    host.appendChild(el);
    return el;
  }

  return {
    MODULES: MODULES,
    byId: byId,
    lum: lum,
    ink: ink,
    svg: svg,
    ambientMode: ambientMode,
    resolveOptions: resolveOptions,
    markup: markup,
    create: create,
    render: render,
  };
});
