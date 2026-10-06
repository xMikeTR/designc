// LlmNet: the anthropic provider against a local scripted server (main-process side of renderer/llm.js).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const LlmNet = require('../llm-net.js');

let server, port, seen;
const sse = evs => evs.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
before(async () => {
  server = http.createServer((req, res) => {
    let b = ''; req.on('data', c => (b += c)); req.on('end', () => {
      const body = JSON.parse(b || '{}'); seen = { url: req.url, headers: req.headers, body };
      if (req.headers['x-api-key'] === 'bad') { res.writeHead(401, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } })); }
      if (body.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        return res.end(sse([
          { type: 'message_start', message: { model: 'claude-x', usage: { input_tokens: 3 } } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hi' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '!' } },
          { type: 'message_delta', delta: {}, usage: { output_tokens: 2 } },
        ]));
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ model: 'claude-x', content: [{ type: 'text', text: 'Hello' }], usage: { input_tokens: 4, output_tokens: 1 } }));
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r)); port = server.address().port;
});
after(() => server.close());

const cfg = () => ({ provider: 'anthropic', baseUrl: `http://127.0.0.1:${port}` });
const args = over => ({ model: 'claude-x', messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'hi' }], env: { ANTHROPIC_API_KEY: 'k1' }, ...over });

test('non-streaming call returns an OpenAI-shaped message and usage', async () => {
  const r = await LlmNet.call(cfg(), args({}));
  assert.equal(seen.url, '/v1/messages');
  assert.equal(seen.headers['x-api-key'], 'k1');
  assert.equal(seen.body.system, 's');
  assert.equal(r.message.content, 'Hello');
  assert.deepEqual(r.usage, { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 });
});

test('streaming call reports each text delta and returns the assembled message', async () => {
  const deltas = [];
  const r = await LlmNet.call(cfg(), args({ stream: true, onText: t => deltas.push(t) }));
  assert.deepEqual(deltas, ['Hi', '!']);
  assert.equal(r.message.content, 'Hi!');
  assert.deepEqual(r.usage, { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 });
  assert.equal(r.model, 'claude-x');
});

test('errors keep the renderer vocabulary: no_key, not_configured, http with the provider message, network', async () => {
  assert.deepEqual(await LlmNet.call(cfg(), args({ env: {} })), { error: 'no_key', env: 'ANTHROPIC_API_KEY' });
  assert.deepEqual(await LlmNet.call(cfg(), args({ model: '' })), { error: 'not_configured' });
  const h = await LlmNet.call(cfg(), args({ env: { ANTHROPIC_API_KEY: 'bad' } }));
  assert.deepEqual(h, { error: 'http', status: 401, message: 'invalid x-api-key', model: 'claude-x' });
  const n = await LlmNet.call({ provider: 'anthropic', baseUrl: 'http://127.0.0.1:1' }, args({}));
  assert.equal(n.error, 'network');
});

test('an abort is reported as cancelled', async () => {
  const ac = new AbortController(); ac.abort();
  assert.deepEqual(await LlmNet.call(cfg(), args({ signal: ac.signal })), { cancelled: true });
});

// ---- vertex: Application Default Credentials through the gcloud the person runs ----
test('adcToken runs gcloud, trims the token and caches it for 50 minutes', async () => {
  let runs = 0, t = 1000;
  const a = LlmNet.adc({ run: async () => { runs++; return { stdout: 'ya29.tok\n' }; }, now: () => t });
  assert.deepEqual(await a.token(), { token: 'ya29.tok' });
  t += 49 * 60000; await a.token(); assert.equal(runs, 1);
  t += 2 * 60000; await a.token(); assert.equal(runs, 2);
});

test('adcToken says gcloud is missing, or that ADC is not set up, with the command to run', async () => {
  const none = LlmNet.adc({ run: async () => { const e = new Error('spawn gcloud ENOENT'); e.code = 'ENOENT'; throw e; } });
  const r1 = await none.token();
  assert.equal(r1.error, 'no_gcloud'); assert.match(r1.hint, /Install the Google Cloud CLI/);
  const out = LlmNet.adc({ run: async () => { const e = new Error('x'); e.code = 1; e.stderr = 'Could not automatically determine credentials'; throw e; } });
  const r2 = await out.token();
  assert.equal(r2.error, 'no_adc'); assert.match(r2.hint, /gcloud auth application-default login/);
  assert.equal((await out.token()).error, 'no_adc', 'a failure is not cached');
});

test('a vertex call sends the ADC token to the Vertex URL and returns the same shapes', async () => {
  const seenReq = [];
  const fakeFetch = async (url, init) => { seenReq.push({ url, init }); return { ok: true, headers: { get: () => 'application/json' }, json: async () => ({ model: 'claude-v', content: [{ type: 'text', text: 'Hi' }], usage: { input_tokens: 1, output_tokens: 1 } }) }; };
  const a = LlmNet.adc({ run: async () => ({ stdout: 'tok\n' }) });
  const r = await LlmNet.call({ provider: 'vertex', project: 'p1', region: 'europe-west1' }, args({ adc: a, fetch: fakeFetch }));
  assert.equal(r.message.content, 'Hi');
  assert.match(seenReq[0].url, /^https:\/\/europe-west1-aiplatform\.googleapis\.com\/v1\/projects\/p1\/locations\/europe-west1\/publishers\/anthropic\/models\/claude-x:rawPredict$/);
  assert.equal(seenReq[0].init.headers.authorization, 'Bearer tok');
});

test('a vertex call with no gcloud or no project returns that error without calling the network', async () => {
  const noG = LlmNet.adc({ run: async () => { const e = new Error('x'); e.code = 'ENOENT'; throw e; } });
  const never = async () => { throw new Error('should not be called'); };
  assert.equal((await LlmNet.call({ provider: 'vertex', project: 'p' }, args({ adc: noG, fetch: never }))).error, 'no_gcloud');
  assert.equal((await LlmNet.call({ provider: 'vertex' }, args({ adc: LlmNet.adc({ run: async () => ({ stdout: 't' }) }), fetch: never, env: {} }))).error, 'no_project');
});
