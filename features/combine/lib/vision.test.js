// Golden tests for the vision-response parser: the model is told to return a
// bare JSON array, but the extractor must survive fences, prose and junk rows.
const test = require('node:test');
const assert = require('node:assert');
const vision = require('./vision');
const { extractRows, splitDataUrl } = vision;

test('extractRows parses a clean JSON array', () => {
  const rows = extractRows('[{"rank":1,"name":"Ja\'Marr Chase","position":"WR","team":"CIN"}]');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, "Ja'Marr Chase");
  assert.equal(rows[0].position, 'WR');
  assert.equal(rows[0].team, 'CIN');
  assert.equal(rows[0].rank, 1);
});

test('extractRows survives markdown fences and surrounding prose', () => {
  const text = 'Here are the rows:\n```json\n[{"rank":1,"name":"Bijan Robinson","position":"rb","team":"atl"}]\n```\nDone!';
  const rows = extractRows(text);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].position, 'RB');    // upper-cased
  assert.equal(rows[0].team, 'ATL');
});

test('extractRows keeps brackets inside player names intact', () => {
  const rows = extractRows('[{"rank":null,"name":"Odell Beckham [IR]","position":"WR","team":""}]');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].rank, null);
  assert.equal(rows[0].name, 'Odell Beckham [IR]');
});

test('extractRows drops nameless rows and rejects non-arrays', () => {
  const rows = extractRows('[{"rank":2,"name":""},{"rank":3,"name":"Saquon Barkley"}]');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'Saquon Barkley');
  assert.throws(() => extractRows('{"name":"not an array"}'));
  assert.throws(() => extractRows('no json here'));
});

test('extractRows parses auction values and defaults to null', () => {
  const rows = extractRows('[{"rank":1,"name":"Bijan Robinson","position":"RB","team":"ATL","auction_value":"$52"},{"rank":2,"name":"Saquon Barkley","position":"RB","team":"PHI"}]');
  assert.equal(rows[0].auction_value, 52);   // "$" stripped, numeric
  assert.equal(rows[1].auction_value, null);  // absent -> null, never the rank
});

test('splitDataUrl handles data URLs and rejects garbage', () => {
  const { mediaType, base64 } = splitDataUrl('data:image/jpeg;base64,aGVsbG8=');
  assert.equal(mediaType, 'image/jpeg');
  assert.equal(base64, 'aGVsbG8=');
  assert.throws(() => splitDataUrl('not-an-image'));
});

test('parseRows salvages complete rows from a truncated array', () => {
  const out = vision.parseRows('[{"rank":1,"name":"Ja\'Marr Chase","position":"WR","team":"CIN"},{"rank":2,"name":"Bijan Robinson","position":"RB","team":"ATL"},{"rank":3,"name":"Justin Jeff');
  assert.equal(out.truncated, true);
  assert.equal(out.rows.length, 2);
  assert.equal(out.rows[1].name, 'Bijan Robinson');
});

test('parseRows reports complete arrays as not truncated', () => {
  const out = vision.parseRows('[{"rank":1,"name":"Ja\'Marr Chase","position":"WR","team":"CIN"}]');
  assert.equal(out.truncated, false);
  assert.equal(out.rows.length, 1);
});

test('parseRows still throws when nothing complete was returned', () => {
  assert.throws(() => vision.parseRows('[{"rank":1,"name":"Ja'), /Unterminated/);
  assert.throws(() => vision.parseRows('sorry, I cannot read that'), /No JSON array/);
});

test('splitDataUrl normalises the media type', () => {
  assert.equal(vision.splitDataUrl('data:IMAGE/JPG;base64,AAAA').mediaType, 'image/jpeg');
  assert.equal(vision.splitDataUrl('data:image/PNG;base64,AAAA').mediaType, 'image/png');
});

// --- request shape ---------------------------------------------------------
// The body IS the API contract, so it gets pinned. Effort in the wrong place
// (top-level rather than inside output_config) is silently ignored by the API,
// which would look like "the expensive setting did nothing".
const requestBody = vision.requestBody;
const IMG = 'AAAA';

test('a plain read sends no effort and no fallbacks — Combine is unchanged', () => {
  const body = requestBody('image/png', IMG, 'claude-sonnet-5', 'do it');
  assert.equal(body.model, 'claude-sonnet-5');
  assert.equal(body.output_config, undefined);
  assert.equal(body.fallbacks, undefined);
  assert.equal(body.thinking, undefined, 'thinking is never configured — effort is the dial');
  assert.equal(body.content, undefined);
  assert.equal(body.messages[0].content[0].type, 'image');
  assert.equal(body.messages[0].content[1].text, 'do it');
});

test('effort rides inside output_config, where the API reads it', () => {
  const body = requestBody('image/jpeg', IMG, 'claude-fable-5', 'p', { effort: 'max' });
  assert.deepEqual(body.output_config, { effort: 'max' });
});

test('a bogus effort is dropped rather than sent and rejected', () => {
  assert.equal(requestBody('image/png', IMG, 'claude-fable-5', 'p', { effort: 'turbo' }).output_config, undefined);
  assert.equal(requestBody('image/png', IMG, 'claude-fable-5', 'p', { effort: '' }).output_config, undefined);
});

test('refusal fallbacks are only asked for on models that take them', () => {
  const opts = { fallbacks: true };
  assert.equal(requestBody('image/png', IMG, 'claude-fable-5', 'p', opts).fallbacks, 'default');
  assert.equal(requestBody('image/png', IMG, 'claude-opus-5', 'p', opts).fallbacks, 'default');
  // Asking on a model that doesn't support it would 400 the whole read.
  assert.equal(requestBody('image/png', IMG, 'claude-sonnet-5', 'p', opts).fallbacks, undefined);
  assert.equal(requestBody('image/png', IMG, 'claude-haiku-4-5', 'p', opts).fallbacks, undefined);
});

test('max_tokens defaults but can be raised for a big read', () => {
  assert.equal(requestBody('image/png', IMG, 'm', 'p').max_tokens, 16000);
  assert.equal(requestBody('image/png', IMG, 'm', 'p', { maxTokens: 32000 }).max_tokens, 32000);
});

// --- readImage: the paths that only fire against the real API ---------------
// Stub fetch so refusals, empty answers and a fallback-less account are covered
// here rather than discovered mid-draft.
function withFetch(responses, fn) {
  const realFetch = global.fetch;
  const realKey = process.env.ANTHROPIC_API_KEY;
  const calls = [];
  process.env.ANTHROPIC_API_KEY = 'test-key';
  let i = 0;
  global.fetch = async (url, init) => {
    calls.push(JSON.parse(init.body));
    const r = responses[Math.min(i++, responses.length - 1)];
    return {
      ok: r.status === undefined || r.status === 200,
      status: r.status || 200,
      json: async () => r.body,
    };
  };
  return fn(calls).finally(() => {
    global.fetch = realFetch;
    if (realKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = realKey;
  });
}

const DATA_URL = 'data:image/png;base64,' + 'A'.repeat(200);
const textReply = (t) => ({ body: { content: [{ type: 'text', text: t }], stop_reason: 'end_turn', model: 'claude-fable-5' } });

test('readImage returns the model text and which model answered', async () => {
  await withFetch([textReply('[{"name":"X"}]')], async () => {
    const out = await vision.readImage(DATA_URL, { prompt: 'p', model: 'claude-fable-5' });
    assert.equal(out.text, '[{"name":"X"}]');
    assert.equal(out.model, 'claude-fable-5');
  });
});

test('a safety refusal is reported in words, not as "no JSON array"', async () => {
  await withFetch([{ body: { content: [], stop_reason: 'refusal', stop_details: { explanation: 'no reason given' } } }], async () => {
    await assert.rejects(
      vision.readImage(DATA_URL, { prompt: 'p', model: 'claude-fable-5' }),
      /declined to read that image: no reason given/
    );
  });
});

test('an empty answer says so rather than failing later in the parser', async () => {
  await withFetch([{ body: { content: [], stop_reason: 'end_turn' } }], async () => {
    await assert.rejects(vision.readImage(DATA_URL, { prompt: 'p' }), /returned nothing for that image/);
  });
});

test('an account without the fallback beta drops it and still gets the read', async () => {
  const rejected = { status: 400, body: { error: { message: 'fallbacks: unsupported beta' } } };
  await withFetch([rejected, textReply('[]')], async (calls) => {
    const out = await vision.readImage(DATA_URL, { prompt: 'p', model: 'claude-fable-5' });
    assert.equal(out.text, '[]');
    assert.equal(calls.length, 2, 'retried once');
    assert.equal(calls[0].fallbacks, 'default', 'first try asked for fallbacks');
    assert.equal(calls[1].fallbacks, undefined, 'retry dropped them');
  });
});

test('effort and model reach the wire as the caller set them', async () => {
  await withFetch([textReply('[]')], async (calls) => {
    await vision.readImage(DATA_URL, { prompt: 'p', model: 'claude-fable-5', effort: 'xhigh' });
    assert.equal(calls[0].model, 'claude-fable-5');
    assert.deepEqual(calls[0].output_config, { effort: 'xhigh' });
  });
});
