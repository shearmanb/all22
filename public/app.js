// Shared frontend helpers. Every page has an #error-banner element;
// all API failures must surface there — never fail silently.

function showError(message) {
  var banner = document.getElementById('error-banner');
  if (!banner) return;
  banner.textContent = message;
  banner.classList.add('visible');
}

function clearError() {
  var banner = document.getElementById('error-banner');
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
    throw new Error(body.error || 'API error');
  }
  return body.data;
}
