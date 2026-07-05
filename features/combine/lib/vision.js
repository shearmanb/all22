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
const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';
const DEFAULT_MODEL = 'claude-sonnet-5';
const MAX_TOKENS = 16000;
const TIMEOUT_MS = 90 * 1000;

function available() {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

const PROMPT = `This image is a screenshot of a fantasy football ranking list.
Extract EVERY player row, top to bottom, in the exact order shown.

Return ONLY a JSON array — no prose, no markdown fences. One object per row:
  {"rank": <the printed rank number, or null if none is visible>,
   "name": "<player name exactly as printed>",
   "position": "<QB|RB|WR|TE|K|DST or empty string if not shown>",
   "team": "<NFL team abbreviation as printed, or empty string>"}

Rules:
- Include every player visible, even partially cut-off rows you can still read.
- A row that is just an NFL team (e.g. "Philadelphia Eagles", "Cowboys DST") is
  a team defense: use the team name as "name" and "DST" as position.
- Do not invent players. If a name is unreadable, skip that row.
- Ignore headers, ads, navigation, tier labels and other non-player rows.
- Copy names as printed (keep suffixes like Jr./III); do not "correct" them.`;

// Split a data URL into { mediaType, base64 }; accepts raw base64 as PNG.
function splitDataUrl(image) {
  const m = /^data:([^;]+);base64,(.*)$/s.exec(String(image || ''));
  if (m) return { mediaType: m[1], base64: m[2].replace(/\s+/g, '') };
  const s = String(image || '').replace(/\s+/g, '');
  if (/^[A-Za-z0-9+/=]+$/.test(s) && s.length > 100) {
    return { mediaType: 'image/png', base64: s };
  }
  throw new Error('Expected an image data URL.');
}

// Pull the first JSON array out of model text (tolerates stray prose/fences).
function extractRows(text) {
  const s = String(text || '').replace(/```(?:json)?/gi, '');
  const start = s.indexOf('[');
  if (start === -1) throw new Error('No JSON array in the model response.');
  // Walk to the matching close bracket so trailing prose doesn't break parsing.
  let depth = 0, inStr = false, esc = false, end = -1;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '[') depth++;
    else if (c === ']') { depth--; if (!depth) { end = i; break; } }
  }
  if (end === -1) throw new Error('Unterminated JSON array in the model response.');
  const arr = JSON.parse(s.slice(start, end + 1));
  if (!Array.isArray(arr)) throw new Error('Model response was not an array.');
  const rows = [];
  for (const r of arr) {
    if (!r || typeof r !== 'object') continue;
    const name = String(r.name || '').trim();
    if (!name) continue;
    const rank = Number.isFinite(Number(r.rank)) && r.rank !== null && r.rank !== ''
      ? Number(r.rank) : null;
    rows.push({
      rank,
      name,
      position: String(r.position || '').toUpperCase().replace(/[^A-Z/]/g, '').replace('D/ST', 'DST'),
      team: String(r.team || '').toUpperCase().replace(/[^A-Z]/g, ''),
    });
  }
  return rows;
}

// image (data URL) -> rows. opts.model overrides the settings-driven model.
async function imageToRows(image, opts = {}) {
  if (!available()) throw new Error('ANTHROPIC_API_KEY is not set.');
  const { mediaType, base64 } = splitDataUrl(image);
  const model = opts.model || DEFAULT_MODEL;
  const res = await fetch(API_URL, {
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
          { type: 'text', text: PROMPT },
        ],
      }],
    }),
  });
  if (!res.ok) {
    let detail = `${res.status}`;
    try {
      const body = await res.json();
      if (body && body.error && body.error.message) detail = `${res.status}: ${body.error.message}`;
    } catch (e) { /* keep the bare status */ }
    throw new Error(`Anthropic API error ${detail}`);
  }
  const body = await res.json();
  const text = (body.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
  return { rows: extractRows(text), model };
}

module.exports = { available, imageToRows, extractRows, splitDataUrl, DEFAULT_MODEL };
