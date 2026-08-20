// Pulling a JSON array out of model text.
//
// Every "ask Claude for structured data" path in the app says "return ONLY a
// JSON array", and every one of them has to cope with the same two realities:
// the model sometimes wraps the array in prose or markdown fences, and a long
// answer can hit the output-token ceiling mid-array. Throwing away a read that
// returned 90 good rows because the 91st was cut off would be the worst
// possible outcome, so we walk the text and salvage every COMPLETE element.
//
// String-aware: brackets and braces inside a player's name (or any string
// value) must not be counted as structure.

// text -> { items, truncated }. Throws when there is no array at all, or when
// not even one element completed.
function parseFirstArray(text) {
  const s = String(text || '').replace(/```(?:json)?/gi, '');
  const start = s.indexOf('[');
  if (start === -1) throw new Error('No JSON array in the model response.');

  let depth = 0, inStr = false, esc = false, end = -1, lastElementEnd = -1;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '[' || c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 1) lastElementEnd = i; }
    else if (c === ']') { depth--; if (!depth) { end = i; break; } }
  }

  let truncated = false;
  let json;
  if (end !== -1) {
    json = s.slice(start, end + 1);
  } else if (lastElementEnd !== -1) {
    // Ran out mid-array: close it after the last element that finished.
    json = `${s.slice(start, lastElementEnd + 1)}]`;
    truncated = true;
  } else {
    throw new Error('Unterminated JSON array in the model response.');
  }

  const items = JSON.parse(json);
  if (!Array.isArray(items)) throw new Error('Model response was not an array.');
  return { items, truncated };
}

module.exports = { parseFirstArray };
