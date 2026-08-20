// Shared frontend helpers. Every page has an #error-banner element;
// all API failures must surface there — never fail silently.
// One copy of everything: pages must use these, never re-declare their own.

function $(id) { return document.getElementById(id); }

// HTML-escape untrusted text for the few places that build markup strings.
// Prefer textContent when creating nodes; use esc() inside template literals.
function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// The banner lives at the top of the page, so an error raised while the owner
// is scrolled down would otherwise look like "nothing happened". Always bring
// it into view, and flash it when it's already showing the same message.
function showError(message) {
  var banner = $('error-banner');
  if (!banner) return;
  banner.textContent = message;
  banner.classList.add('visible');
  try {
    banner.scrollIntoView({ behavior: 'smooth', block: 'center' });
  } catch (e) {
    banner.scrollIntoView();
  }
  banner.classList.remove('flash');
  void banner.offsetWidth; // restart the animation
  banner.classList.add('flash');
}

function clearError() {
  var banner = $('error-banner');
  if (!banner) return;
  banner.textContent = '';
  banner.classList.remove('visible');
}

// fetch wrapper for /api/* endpoints: resolves with `data` on success,
// shows the error banner and rejects on any failure.
async function apiFetch(url, options) {
  clearError();
  var body;
  try {
    var res = await fetch(url, options);
    body = await res.json();
  } catch (err) {
    showError('Could not reach the server. Check your connection and try again.');
    throw err;
  }
  if (!body.ok) {
    showError(body.error || 'Something went wrong.');
    // Carry the response along on the error. Some endpoints answer a rejection
    // with useful payload — a conflict returns the authoritative current state
    // — and a caller that wants it shouldn't have to re-fetch or bypass this
    // helper. Callers that only care about the message are unaffected.
    var err = new Error(body.error || 'API error');
    err.data = body.data;
    err.status = res.status;
    throw err;
  }
  return body.data;
}

// JSON-POST sugar for the common case.
function apiPost(url, payload, method) {
  return apiFetch(url, {
    method: method || 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload || {}),
  });
}

// Download a file the API builds (CSV exports). Any JSON error body is
// surfaced in the banner like apiFetch would.
async function apiDownload(url) {
  clearError();
  var res;
  try {
    res = await fetch(url);
  } catch (err) {
    showError('Could not reach the server. Check your connection and try again.');
    throw err;
  }
  if (!res.ok) {
    var msg = 'Download failed.';
    try { var body = await res.json(); if (body && body.error) msg = body.error; } catch (e) { /* not JSON */ }
    showError(msg);
    throw new Error(msg);
  }
  var blob = await res.blob();
  var dispo = res.headers.get('Content-Disposition') || '';
  var m = /filename="?([^";]+)"?/.exec(dispo);
  triggerDownload(blob, m ? m[1] : 'download.csv');
}

// Hand the browser a blob as a named download.
function triggerDownload(blob, filename) {
  var a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}

// "3h ago" style relative time for freshness displays.
function timeAgo(value) {
  if (!value) return '';
  var then = new Date(value).getTime();
  if (isNaN(then)) return '';
  var secs = Math.round((Date.now() - then) / 1000);
  if (secs < 60) return 'just now';
  var mins = Math.round(secs / 60);
  if (mins < 60) return mins + 'm ago';
  var hrs = Math.round(mins / 60);
  if (hrs < 24) return hrs + 'h ago';
  var days = Math.round(hrs / 24);
  if (days < 30) return days + 'd ago';
  return new Date(value).toLocaleDateString();
}

// Small success toast (bottom center, auto-hides).
var _toastTimer = null;
function toast(message) {
  var el = document.querySelector('.toast');
  if (!el) {
    el = document.createElement('div');
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.classList.add('visible');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(function () { el.classList.remove('visible'); }, 2600);
}
