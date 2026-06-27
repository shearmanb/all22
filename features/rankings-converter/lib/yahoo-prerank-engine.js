// All22 → Yahoo pre-draft rankings ENGINE (runs in the browser, on Yahoo's
// "Edit Pre-Draft Player Rankings" page, via a bookmarklet).
//
// This file is NOT served or required at runtime by the server. The bookmarklet
// builder (lib/yahoo-bookmarklet.js) reads this function's source, inlines it
// together with the canonical matcher (lib/players.js) and the owner's ranked
// names, and hands back a self-contained `javascript:` bookmarklet. Keeping the
// engine as a real function here (instead of a string) means it stays lintable
// and editable; the builder serializes it with Function.prototype.toString().
//
// Two globals are defined by the bookmarklet wrapper before this runs:
//   ALL22Names    Array<{ name, position, team, rank }>  (the owner's list, in rank order)
//   ALL22Players  the exports of lib/players.js (canonical name matching)
//
// Yahoo has no first-party bulk import, and its pre-draft editor is a React app
// whose markup changes over time and isn't visible from the dev environment.
// So the engine is deliberately ADAPTIVE rather than hard-coded to one layout:
//   1. it tries to auto-detect the three columns and each player row;
//   2. if that misses, a "Teach" mode learns the move-to-Preferred control from
//      one example click;
//   3. it always shows the matched list in rank order with a Copy button, so the
//      owner can finish by hand if Yahoo blocks automation entirely;
//   4. a Diagnostics button dumps what it found, so the auto-detection can be
//      finalized against the real page without guesswork.
/* eslint-disable */
function all22YahooPrerankEngine() {
  'use strict';

  // The wrapper provides these; guard so the engine fails loudly, not silently.
  var LIST = (typeof ALL22Names !== 'undefined' && Array.isArray(ALL22Names)) ? ALL22Names : [];
  var MATCH = (typeof ALL22Players !== 'undefined') ? ALL22Players : null;

  // Don't stack overlays if the bookmarklet is clicked twice.
  var existing = document.getElementById('all22-yahoo-panel');
  if (existing) { existing.remove(); }

  // ---- tunables ------------------------------------------------------------
  var CFG = {
    columnTitles: {
      // Header text used to locate each column (case-insensitive "contains").
      preferred: 'Preferred Players',
      defaults: 'Default Player Rankings',
      doNotDraft: 'Do Not Draft',
    },
    scrollStepPx: 320,     // how far to scroll the default list while hunting a row
    scrollMaxLoops: 200,   // safety cap when scrolling a long/virtualized list
    clickDelayMs: 90,      // pause between moves so React can re-render
  };

  // Learned from "Teach" mode (or auto-detection): how to recognize the
  // "move this player to Preferred" control inside a row.
  var learned = { addSignature: null, rowSelector: null };

  // ---- small helpers -------------------------------------------------------
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function txt(el) { return (el && (el.textContent || '')).replace(/\s+/g, ' ').trim(); }
  function lc(s) { return String(s || '').toLowerCase(); }
  function classTokens(el) {
    if (!el || !el.className || typeof el.className !== 'string') return [];
    return el.className.split(/\s+/).filter(Boolean);
  }

  // Fire a click the way a React app expects (pointer + mouse + click).
  function realClick(el) {
    if (!el) return;
    el.scrollIntoView({ block: 'center', inline: 'nearest' });
    var opts = { bubbles: true, cancelable: true, view: window };
    // Pointer/mouse down+up to satisfy handlers that track them, then exactly
    // ONE click via el.click() — dispatching a click too would fire twice and
    // could move a player into Preferred and right back out.
    ['pointerdown', 'mousedown', 'pointerup', 'mouseup'].forEach(function (type) {
      try { el.dispatchEvent(new MouseEvent(type, opts)); } catch (e) { /* best-effort */ }
    });
    try { el.click(); } catch (e) {}
  }

  // Strip the bits Yahoo decorates a row's name with: a leading rank ("25.")
  // and a trailing "Team - POS" tag ("Bijan Robinson Atl - RB" -> "Bijan Robinson").
  function nameFromRowText(t) {
    var s = String(t || '').replace(/\s+/g, ' ').trim();
    s = s.replace(/^\s*\d{1,3}[.)]?\s+/, '');         // leading rank
    s = s.replace(/\s+[A-Za-z]{2,4}\s*[-–]\s*[A-Za-z/]{1,4}\s*$/, ''); // trailing "Atl - RB"
    return s.trim();
  }

  // Best-effort name for a row: prefer an anchor/link (Yahoo links player names),
  // else the de-decorated row text.
  function rowName(rowEl) {
    if (!rowEl) return '';
    var a = rowEl.querySelector('a[href*="players"], a[href*="player"], a');
    var raw = a ? txt(a) : txt(rowEl);
    var n = nameFromRowText(raw);
    // An anchor sometimes still carries the team/pos tail; clean again.
    return nameFromRowText(n);
  }

  // ---- locate the editor ---------------------------------------------------
  // Find the element whose visible text contains one of the column titles, then
  // climb to a container that actually holds the repeated player rows.
  function findColumnByTitle(title) {
    var want = lc(title);
    var all = document.querySelectorAll('h1,h2,h3,h4,h5,div,span,p,th');
    var header = null;
    for (var i = 0; i < all.length; i++) {
      var t = lc(txt(all[i]));
      if (t === want || (t.indexOf(want) >= 0 && t.length <= want.length + 12)) { header = all[i]; break; }
    }
    if (!header) return null;
    // Walk up a few levels; the column container is the ancestor that contains
    // the most "row-like" descendants (links to players or repeated children).
    var node = header, best = header, bestScore = -1;
    for (var up = 0; up < 6 && node; up++) {
      var links = node.querySelectorAll ? node.querySelectorAll('a').length : 0;
      var kids = node.children ? node.children.length : 0;
      var score = links * 2 + kids;
      if (score > bestScore) { bestScore = score; best = node; }
      node = node.parentElement;
    }
    return { header: header, container: best };
  }

  // The scrollable element for a column (so we can hunt rows in a long list).
  function scrollParent(el) {
    var node = el;
    while (node && node !== document.body) {
      var st = getComputedStyle(node);
      if (/(auto|scroll)/.test(st.overflowY) && node.scrollHeight > node.clientHeight + 8) return node;
      node = node.parentElement;
    }
    return el;
  }

  // Candidate row elements inside a column container: direct-ish descendants
  // that carry a player name. Deduped to the nearest repeating ancestor.
  function rowsIn(container) {
    if (!container) return [];
    var anchors = container.querySelectorAll('a[href*="player"], a[href*="players"]');
    var rows = [], seen = new Set();
    function pushRow(r) { if (r && !seen.has(r)) { seen.add(r); rows.push(r); } }
    if (anchors.length) {
      for (var i = 0; i < anchors.length; i++) {
        // Climb to a row: the ancestor that also contains an arrow/button control.
        var node = anchors[i], row = anchors[i];
        for (var up = 0; up < 5 && node && node !== container; up++) {
          if (node.querySelector && node.querySelector('button, [role="button"], svg, [class*="arrow"], [class*="icon"]')) { row = node; break; }
          node = node.parentElement;
        }
        pushRow(row);
      }
    }
    return rows;
  }

  // ---- learn / detect the "move to Preferred" control ----------------------
  // Given a row, find the control that moves the player rightward (to Preferred).
  // Heuristic: among arrow/button-ish controls in the row, pick the right-most
  // (the green ">" sits to the right; red "<" to the left). A learned signature
  // (from Teach mode) overrides the heuristic.
  function addControlIn(rowEl) {
    if (!rowEl) return null;
    var cands = rowEl.querySelectorAll('button, [role="button"], a[role="button"], svg, [class*="arrow"], [class*="chevron"], [class*="icon"]');
    if (learned.addSignature) {
      for (var i = 0; i < cands.length; i++) {
        if (signatureMatches(cands[i], learned.addSignature)) return clickable(cands[i]);
      }
    }
    var list = [];
    for (var j = 0; j < cands.length; j++) {
      var c = cands[j];
      var aria = lc(c.getAttribute && (c.getAttribute('aria-label') || c.getAttribute('title') || ''));
      var t = lc(txt(c));
      var hint = aria + ' ' + t + ' ' + classTokens(c).join(' ').toLowerCase();
      var looksRight = /preferred|add|right|next|»|›|>|forward/.test(hint);
      var looksLeft = /do.?not|exclude|left|back|«|‹|</.test(hint);
      var rect = c.getBoundingClientRect();
      list.push({ el: c, x: rect.left, looksRight: looksRight, looksLeft: looksLeft });
    }
    if (!list.length) return null;
    // Strong textual hint wins.
    var hinted = list.filter(function (o) { return o.looksRight && !o.looksLeft; });
    if (hinted.length) return clickable(hinted.sort(function (a, b) { return b.x - a.x; })[0].el);
    // Otherwise the right-most control that isn't clearly the "left" one.
    var pool = list.filter(function (o) { return !o.looksLeft; });
    if (!pool.length) pool = list;
    pool.sort(function (a, b) { return b.x - a.x; });
    return clickable(pool[0].el);
  }

  // Climb from an icon/svg to the actual clickable (button/role=button) if any.
  function clickable(el) {
    var node = el;
    for (var i = 0; i < 4 && node; i++) {
      if (node.tagName === 'BUTTON' || (node.getAttribute && node.getAttribute('role') === 'button') || node.tagName === 'A') return node;
      node = node.parentElement;
    }
    return el;
  }

  function signatureOf(el) {
    return {
      tag: el.tagName,
      classes: classTokens(el),
      aria: lc(el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('title') || '')),
    };
  }
  function signatureMatches(el, sig) {
    if (!el || !sig) return false;
    if (sig.aria && lc(el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('title') || '')) === sig.aria) return true;
    if (el.tagName !== sig.tag) return false;
    var have = classTokens(el);
    var shared = sig.classes.filter(function (c) { return have.indexOf(c) >= 0; });
    return sig.classes.length > 0 && shared.length >= Math.min(2, sig.classes.length);
  }

  // ---- match the owner's list against the page -----------------------------
  function buildPageIndex() {
    var cols = {
      defaults: findColumnByTitle(CFG.columnTitles.defaults),
      preferred: findColumnByTitle(CFG.columnTitles.preferred),
      doNotDraft: findColumnByTitle(CFG.columnTitles.doNotDraft),
    };
    var container = cols.defaults && cols.defaults.container;
    return { cols: cols, container: container, rows: rowsIn(container) };
  }

  // ---- UI ------------------------------------------------------------------
  var ui = {};
  function buildPanel() {
    var p = document.createElement('div');
    p.id = 'all22-yahoo-panel';
    p.style.cssText = [
      'position:fixed', 'top:16px', 'right:16px', 'width:360px', 'max-height:84vh',
      'overflow:auto', 'z-index:2147483647', 'background:#11161d', 'color:#e8edf2',
      'font:13px/1.45 system-ui,Segoe UI,Arial,sans-serif', 'border:1px solid #2b3543',
      'border-radius:12px', 'box-shadow:0 10px 40px rgba(0,0,0,.5)', 'padding:14px 14px 12px',
    ].join(';');
    p.innerHTML =
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">' +
        '<strong style="font-size:14px">All22 → Yahoo rankings</strong>' +
        '<button id="a22-close" title="Close" style="' + btnStyle('ghost') + '">✕</button>' +
      '</div>' +
      '<p id="a22-status" style="margin:0 0 8px;color:#9fb0c0"></p>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px">' +
        '<button id="a22-run" style="' + btnStyle('primary') + '">▶ Set my rankings</button>' +
        '<button id="a22-teach" style="' + btnStyle('') + '">Teach the ▶ button</button>' +
      '</div>' +
      '<div id="a22-progress" style="height:6px;background:#1d2630;border-radius:4px;overflow:hidden;margin-bottom:8px">' +
        '<div id="a22-bar" style="height:100%;width:0;background:#3ea6ff;transition:width .15s"></div>' +
      '</div>' +
      '<div id="a22-report" style="font-size:12px"></div>' +
      '<details style="margin-top:8px"><summary style="cursor:pointer;color:#9fb0c0">Your list, in order (' + LIST.length + ')</summary>' +
        '<ol id="a22-ordered" style="margin:6px 0 0;padding-left:22px;max-height:180px;overflow:auto"></ol>' +
      '</details>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px">' +
        '<button id="a22-copy" style="' + btnStyle('') + '">Copy list</button>' +
        '<button id="a22-diag" style="' + btnStyle('ghost') + '">Copy diagnostics</button>' +
      '</div>';
    document.body.appendChild(p);

    ui.panel = p;
    ui.status = p.querySelector('#a22-status');
    ui.bar = p.querySelector('#a22-bar');
    ui.report = p.querySelector('#a22-report');
    var ol = p.querySelector('#a22-ordered');
    LIST.forEach(function (it) {
      var li = document.createElement('li');
      li.textContent = it.name + (it.position ? '  (' + it.position + ')' : '');
      ol.appendChild(li);
    });

    p.querySelector('#a22-close').onclick = function () { p.remove(); };
    p.querySelector('#a22-run').onclick = run;
    p.querySelector('#a22-teach').onclick = teach;
    p.querySelector('#a22-copy').onclick = copyList;
    p.querySelector('#a22-diag').onclick = copyDiagnostics;
  }

  function btnStyle(kind) {
    var base = 'border:0;border-radius:8px;padding:7px 10px;font:600 12px system-ui;cursor:pointer;';
    if (kind === 'primary') return base + 'background:#1f7ae0;color:#fff;';
    if (kind === 'ghost') return base + 'background:transparent;color:#9fb0c0;border:1px solid #2b3543;';
    return base + 'background:#27313d;color:#e8edf2;';
  }
  function setStatus(msg) { if (ui.status) ui.status.textContent = msg; }
  function setBar(done, total) { if (ui.bar) ui.bar.style.width = (total ? Math.round(100 * done / total) : 0) + '%'; }

  // ---- actions -------------------------------------------------------------
  var lastDiag = {};

  function copyList() {
    var text = LIST.map(function (it, i) { return (i + 1) + '. ' + it.name; }).join('\n');
    copy(text, 'Copied ' + LIST.length + ' players to the clipboard.');
  }

  function copyDiagnostics() {
    var idx = buildPageIndex();
    var sample = idx.rows.slice(0, 3).map(function (r) {
      return { name: rowName(r), outerHTML: (r.outerHTML || '').slice(0, 600) };
    });
    var diag = {
      url: location.href,
      listCount: LIST.length,
      columnsFound: {
        defaults: !!(idx.cols.defaults && idx.cols.defaults.container),
        preferred: !!(idx.cols.preferred && idx.cols.preferred.container),
        doNotDraft: !!(idx.cols.doNotDraft && idx.cols.doNotDraft.container),
      },
      rowsDetected: idx.rows.length,
      sampleRows: sample,
      lastRun: lastDiag,
      userAgent: navigator.userAgent,
    };
    copy(JSON.stringify(diag, null, 2), 'Diagnostics copied — paste them back to All22 to finish wiring this up.');
  }

  function copy(text, okMsg) {
    function fallback() {
      var ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); } catch (e) {}
      ta.remove();
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { setStatus(okMsg); }, function () { fallback(); setStatus(okMsg); });
    } else { fallback(); setStatus(okMsg); }
  }

  // Teach mode: the owner clicks one player's green ▶ control; we learn its
  // signature and the row container, then everything else uses that.
  function teach() {
    setStatus('Teach mode: click the GREEN ▶ arrow next to any one player (the one that moves them to Preferred).');
    var onClick = function (ev) {
      var el = ev.target;
      // Ignore clicks inside our own panel.
      if (ui.panel.contains(el)) return;
      ev.preventDefault(); ev.stopPropagation();
      var ctl = clickable(el);
      learned.addSignature = signatureOf(el.closest('button,[role="button"],a,svg,[class*="icon"]') || el);
      // The row is the ancestor that also holds a player name.
      var node = el, row = null;
      for (var up = 0; up < 6 && node; up++) {
        if (node.querySelector && node.querySelector('a')) { row = node; break; }
        node = node.parentElement;
      }
      learned.rowSelector = row ? row.tagName : null;
      document.removeEventListener('click', onClick, true);
      setStatus('Learned the ▶ control. Now press "Set my rankings".');
    };
    document.addEventListener('click', onClick, true);
  }

  // Find a row in the default list matching `wantedName`, scrolling the list as
  // needed to surface virtualized rows. Returns the row element or null. Builds
  // one canonical index over all currently-loaded rows and asks for the single
  // best match, so a near-namesake never wins over the real player.
  async function findRow(wantedName, container) {
    function scan() {
      var rows = rowsIn(container);
      var named = [];
      for (var i = 0; i < rows.length; i++) {
        var nm = rowName(rows[i]);
        if (nm) named.push({ name: nm, _i: named.length, row: rows[i] });
      }
      if (!named.length) return null;
      if (!MATCH) {
        for (var j = 0; j < named.length; j++) if (lc(named[j].name) === lc(wantedName)) return named[j].row;
        return null;
      }
      var hit = MATCH.findName(wantedName, MATCH.buildNameIndex(named));
      return (hit && typeof hit._i === 'number') ? named[hit._i].row : null;
    }
    var found = scan();
    if (found) return found;
    if (!container) return null;
    var sc = scrollParent(container);
    sc.scrollTop = 0;
    for (var loop = 0; loop < CFG.scrollMaxLoops; loop++) {
      found = scan();
      if (found) return found;
      var before = sc.scrollTop;
      sc.scrollTop = before + CFG.scrollStepPx;
      await sleep(40);
      if (sc.scrollTop <= before) break; // reached the bottom
    }
    return scan();
  }

  async function run() {
    if (!LIST.length) { setStatus('No players in this list.'); return; }
    var idx = buildPageIndex();
    if (!idx.container) {
      setStatus('Could not find the "Default Player Rankings" list on this page. Open Yahoo → Draft → Edit Pre-Draft Player Rankings, then click here again. If it still fails, use "Copy diagnostics".');
      return;
    }
    setStatus('Setting ' + LIST.length + ' players… leave this tab in front.');
    var matched = [], missed = [];
    for (var i = 0; i < LIST.length; i++) {
      var it = LIST[i];
      setBar(i, LIST.length);
      var row = await findRow(it.name, idx.container);
      if (!row) { missed.push(it.name); continue; }
      var ctl = addControlIn(row);
      if (!ctl) { missed.push(it.name + ' (no ▶ control found)'); continue; }
      realClick(ctl);
      matched.push(it.name);
      await sleep(CFG.clickDelayMs);
    }
    setBar(LIST.length, LIST.length);
    lastDiag = { matched: matched.length, missed: missed.length, missedNames: missed.slice(0, 40) };
    renderReport(matched, missed);
  }

  function renderReport(matched, missed) {
    var html = '<p style="margin:6px 0;color:#7ee0a6">✓ Moved ' + matched.length + ' to Preferred.</p>';
    if (missed.length) {
      html += '<p style="margin:6px 0;color:#ffb86b">⚠ ' + missed.length + ' not matched — fix these by hand:</p>' +
        '<ul style="margin:0;padding-left:18px;max-height:160px;overflow:auto">' +
        missed.map(function (n) { return '<li>' + escapeHtml(n) + '</li>'; }).join('') + '</ul>';
    }
    html += '<p style="margin:8px 0 0;color:#9fb0c0">Check the order in <em>Preferred Players</em>, then click Yahoo\'s <strong>Save Changes</strong>. Nothing is saved until you do.</p>';
    ui.report.innerHTML = html;
    setStatus('Done. Review, then press Save Changes on Yahoo.');
  }

  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // ---- boot ----------------------------------------------------------------
  buildPanel();
  if (!MATCH) {
    setStatus('Heads up: the name matcher did not load — names must match Yahoo exactly. You can still use Copy list.');
  } else {
    var probe = buildPageIndex();
    if (probe.container && probe.rows.length) {
      setStatus('Found the rankings editor (' + probe.rows.length + ' rows visible). Press "Set my rankings".');
    } else {
      setStatus('Open Yahoo → Draft → "Edit Pre-Draft Player Rankings", then press "Set my rankings". If detection fails, use "Teach the ▶ button" or "Copy diagnostics".');
    }
  }
}

module.exports = all22YahooPrerankEngine;
