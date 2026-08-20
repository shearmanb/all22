// vision.js — screenshot -> structured ranking rows via Claude vision
// (the PRD's "top-notch imaging" path). Called with a data-URL image; returns
// [{ rank, name, position, team }] straight from the model, which then goes
// through the SAME players_master matching pipeline as pasted text.
//
// No SDK dependency: Node 20's global fetch talks to the Messages API
// directly. The API key lives in ANTHROPIC_API_KEY on the server (Railway env
// var) and never reaches the browser. When the key is missing or a call fails,
// the caller falls back to the bundled Tesseract pipeline (lib/ocr.js) so
// ingestion always works — just less accurately.
const { parseFirstArray } = require('../../../lib/json-array');

const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';
const DEFAULT_MODEL = 'claude-sonnet-5';
const MAX_TOKENS = 16000;
const TIMEOUT_MS = 90 * 1000;
// Transient API conditions (rate limit, overload, gateway hiccup) — worth a
// second try before we drop to the much weaker offline reader.
const RETRY_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504, 529]);
const MAX_ATTEMPTS = 3;
// What the Messages API accepts. A phone screenshot saved as HEIC would be
// rejected outright, so we say so in words the owner can act on.
const SUPPORTED_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function available() {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

const PROMPT = `This image is a screenshot of a fantasy football ranking list.
Extract EVERY player row, top to bottom, in the exact order shown.

Return ONLY a JSON array — no prose, no markdown fences. One object per row:
  {"rank": <the printed rank number, or null if none is visible>,
   "name": "<player name exactly as printed>",
   "position": "<QB|RB|WR|TE|K|DST or empty string if not shown>",
   "team": "<NFL team abbreviation as printed, or empty string>",
   "auction_value": <the auction dollar value as a number if the list shows one, else null>}

Rules:
- Include every player visible, even partially cut-off rows you can still read.
- A row that is just an NFL team (e.g. "Philadelphia Eagles", "Cowboys DST") is
  a team defense: use the team name as "name" and "DST" as position.
- Only set "auction_value" when the list actually prints a dollar/auction value
  (e.g. "$45", "42"). Use the number only (no "$"). If there is no auction
  column, set it to null for every row — do NOT use the rank as a value.
- Do not invent players. If a name is unreadable, skip that row.
- Ignore headers, ads, navigation, tier labels and other non-player rows.
- Copy names as printed (keep suffixes like Jr./III); do not "correct" them.`;

// Split a data URL into { mediaType, base64 }; accepts raw base64 as PNG.
function splitDataUrl(image) {
  const m = /^data:([^;]+);base64,(.*)$/s.exec(String(image || ''));
  if (m) return { mediaType: m[1].toLowerCase() === 'image/jpg' ? 'image/jpeg' : m[1].toLowerCase(), base64: m[2].replace(/\s+/g, '') };
  const s = String(image || '').replace(/\s+/g, '');
  if (/^[A-Za-z0-9+/=]+$/.test(s) && s.length > 100) {
    return { mediaType: 'image/png', base64: s };
  }
  throw new Error('Expected an image data URL.');
}

// Model text -> ranking rows. The array-walking (fences, trailing prose,
// salvaging a truncated array) is shared in lib/json-array.js; what belongs
// here is what a RANKING row means.
function parseRows(text) {
  const { items: arr, truncated } = parseFirstArray(text);
  const rows = [];
  for (const r of arr) {
    if (!r || typeof r !== 'object') continue;
    const name = String(r.name || '').trim();
    if (!name) continue;
    const rank = Number.isFinite(Number(r.rank)) && r.rank !== null && r.rank !== ''
      ? Number(r.rank) : null;
    // Auction value: keep only a real positive number; a bare "$" or blank => null.
    const av = r.auction_value;
    const auctionValue = (av !== null && av !== undefined && av !== '' &&
      Number.isFinite(Number(String(av).replace(/[$,]/g, ''))))
      ? Number(String(av).replace(/[$,]/g, '')) : null;
    rows.push({
      rank,
      name,
      position: String(r.position || '').toUpperCase().replace(/[^A-Z/]/g, '').replace('D/ST', 'DST'),
      team: String(r.team || '').toUpperCase().replace(/[^A-Z]/g, ''),
      auction_value: auctionValue,
    });
  }
  return { rows, truncated };
}

// Back-compat helper (and the shape the golden tests use): rows only.
function extractRows(text) {
  return parseRows(text).rows;
}

// One Messages API call. Throws an Error carrying .status/.retryable so the
// caller can tell "try again" apart from "this will never work".
async function callApi(mediaType, base64, model, prompt) {
  let res;
  try {
    res = await fetch(API_URL, {
      method: 'POST',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        'content-type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': API_VERSION,
      },
      body: JSON.stringify({
        model,
        max_tokens: MAX_TOKENS,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
            { type: 'text', text: prompt },
          ],
        }],
      }),
    });
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    const e = new Error(timedOut
      ? `Anthropic API did not answer within ${Math.round(TIMEOUT_MS / 1000)}s`
      : `Could not reach the Anthropic API (${err && err.message ? err.message : 'network error'})`);
    e.retryable = true;
    throw e;
  }
  if (!res.ok) {
    let detail = `${res.status}`;
    try {
      const body = await res.json();
      if (body && body.error && body.error.message) detail = `${res.status}: ${body.error.message}`;
    } catch (e) { /* keep the bare status */ }
    const e = new Error(`Anthropic API error ${detail}`);
    e.status = res.status;
    e.retryable = RETRY_STATUS.has(res.status);
    throw e;
  }
  return res.json();
}

// Ask Claude to read an image, with the retry / model-fallback / size-guard
// behaviour every vision call in the app needs. The PROMPT is the caller's
// business; getting an answer out of the API is this function's.
//
// Returns { text, model, stopReason, notes } — `notes` is owner-facing prose
// about anything worked around on the way (a retry, a model substitution).
// Shared with War Room's draft-board reader (features/warroom/lib/boardvision.js)
// so there is one implementation of talking to the Messages API, not two.
async function readImage(image, opts = {}) {
  if (!available()) throw new Error('ANTHROPIC_API_KEY is not set on the server.');
  const { mediaType, base64 } = splitDataUrl(image);
  if (!SUPPORTED_TYPES.has(mediaType)) {
    throw new Error(`Claude cannot read ${mediaType} images (only JPEG, PNG, GIF and WebP). Re-save the picture as a JPEG or PNG.`);
  }
  const bytes = Math.floor(base64.length * 3 / 4);
  if (bytes > MAX_IMAGE_BYTES) {
    throw new Error(`That image is ${(bytes / 1024 / 1024).toFixed(1)}MB — over the 5MB the API accepts. Crop it or save it smaller.`);
  }

  const prompt = opts.prompt || PROMPT;
  const notes = [];
  let model = opts.model || DEFAULT_MODEL;
  let body;
  for (let attempt = 1; ; attempt++) {
    try {
      body = await callApi(mediaType, base64, model, prompt);
      break;
    } catch (err) {
      // A bad model name in settings never fixes itself — say so and use the default.
      if (err.status === 404 && model !== DEFAULT_MODEL) {
        notes.push(`The OCR model in Settings ("${model}") is not available to this API key — used ${DEFAULT_MODEL} instead.`);
        model = DEFAULT_MODEL;
        continue;
      }
      if (!err.retryable || attempt >= MAX_ATTEMPTS) throw err;
      await sleep(500 * (2 ** (attempt - 1)));
      notes.push(`Anthropic was busy (${err.message}) — retried.`);
    }
  }

  const text = (body.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
  return { text, model, stopReason: body.stop_reason, notes };
}

// image (data URL) -> ranking rows. opts.model overrides the settings-driven
// model. Returns { rows, model, truncated, note }.
async function imageToRows(image, opts = {}) {
  const read = await readImage(image, { model: opts.model, prompt: PROMPT });
  const notes = read.notes.slice();
  const { rows, truncated } = parseRows(read.text);
  const cut = Boolean(truncated || read.stopReason === 'max_tokens');
  if (cut) {
    notes.push(`This screenshot has more rows than one read can return — kept the first ${rows.length}. Split it into shorter screenshots to get the rest.`);
  }
  return { rows, model: read.model, truncated: cut, note: notes.join(' ') };
}

module.exports = { available, imageToRows, readImage, extractRows, parseRows, splitDataUrl, DEFAULT_MODEL };
