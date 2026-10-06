// Llm: the pure part of the model providers. The renderer speaks OpenAI-shaped messages; for the anthropic and vertex
// providers they are translated to the Anthropic Messages API and back, and requests are built from designc.json.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Llm = require('../renderer/llm.js');

const TOOLS = [{ type: 'function', function: { name: 'read_model', description: 'Read it', parameters: { type: 'object', properties: { a: { type: 'string' } } } } }, { type: 'function', function: { name: 'get_gate' } }];
const MSGS = [
  { role: 'system', content: 'Be brief.' },
  { role: 'user', content: 'Check the gate' },
  { role: 'assistant', content: 'Looking.', tool_calls: [{ id: 't1', type: 'function', function: { name: 'get_gate', arguments: '{"x":1}' } }, { id: 't2', type: 'function', function: { name: 'read_model', arguments: '' } }] },
  { role: 'tool', tool_call_id: 't1', content: '{"ready":false}' },
  { role: 'tool', tool_call_id: 't2', content: 'model text' },
  { role: 'assistant', content: null, tool_calls: [{ id: 't3', type: 'function', function: { name: 'get_gate', arguments: '{bad' } }] },
];

test('provider defaults to openai and names the others; an unknown provider is reported', () => {
  assert.equal(Llm.provider({}), 'openai');
  assert.equal(Llm.provider(undefined), 'openai');
  assert.equal(Llm.provider({ provider: 'Anthropic' }), 'anthropic');
  assert.equal(Llm.provider({ provider: 'vertex' }), 'vertex');
  assert.equal(Llm.provider({ provider: 'bedrock' }), null);
});

test('toAnthropic lifts system, turns tool calls into tool_use and groups tool results into one user message', () => {
  const b = Llm.toAnthropic(MSGS, TOOLS);
  assert.equal(b.system, 'Be brief.');
  assert.deepEqual(b.messages[0], { role: 'user', content: 'Check the gate' });
  assert.deepEqual(b.messages[1], { role: 'assistant', content: [{ type: 'text', text: 'Looking.' }, { type: 'tool_use', id: 't1', name: 'get_gate', input: { x: 1 } }, { type: 'tool_use', id: 't2', name: 'read_model', input: {} }] });
  assert.deepEqual(b.messages[2], { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: '{"ready":false}' }, { type: 'tool_result', tool_use_id: 't2', content: 'model text' }] });
  assert.deepEqual(b.messages[3].content, [{ type: 'tool_use', id: 't3', name: 'get_gate', input: {} }], 'unparseable arguments become an empty input, not a throw');
  assert.equal(b.messages.length, 4);
  assert.deepEqual(b.tools[0], { name: 'read_model', description: 'Read it', input_schema: { type: 'object', properties: { a: { type: 'string' } } } });
  assert.deepEqual(b.tools[1], { name: 'get_gate', description: '', input_schema: { type: 'object', properties: {} } });
});

test('toAnthropic with no tools or no system leaves those keys out', () => {
  const b = Llm.toAnthropic([{ role: 'user', content: 'hi' }], []);
  assert.equal('system' in b, false);
  assert.equal('tools' in b, false);
  assert.equal(Llm.toAnthropic([{ role: 'system', content: 'a' }, { role: 'system', content: 'b' }, { role: 'user', content: 'x' }]).system, 'a\n\nb');
});

test('fromAnthropic gives an OpenAI-shaped message and usage', () => {
  const r = Llm.fromAnthropic({ model: 'claude-x', content: [{ type: 'text', text: 'Hello' }, { type: 'text', text: ' there' }, { type: 'tool_use', id: 'u1', name: 'get_gate', input: { a: 2 } }], usage: { input_tokens: 10, output_tokens: 5 } });
  assert.deepEqual(r.message, { role: 'assistant', content: 'Hello there', tool_calls: [{ id: 'u1', type: 'function', function: { name: 'get_gate', arguments: '{"a":2}' } }] });
  assert.deepEqual(r.usage, { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
  assert.equal(r.model, 'claude-x');
  const none = Llm.fromAnthropic({ content: [] });
  assert.deepEqual(none.message, { role: 'assistant', content: null, tool_calls: undefined });
  assert.equal(none.usage, null);
});

test('the stream reducer returns text deltas as they come and assembles tool calls and usage', () => {
  const s = Llm.anthropicStream();
  const ev = [
    { type: 'message_start', message: { model: 'claude-x', usage: { input_tokens: 12 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hel' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'lo' } },
    { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'u9', name: 'get_gate', input: {} } },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"a"' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: ':1}' } },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 7 } },
    { type: 'message_stop' }, { type: 'ping' },
  ];
  assert.deepEqual(ev.map(e => s.push(e)), ['', '', 'Hel', 'lo', '', '', '', '', '', '']);
  const r = s.result();
  assert.deepEqual(r.message, { role: 'assistant', content: 'Hello', tool_calls: [{ id: 'u9', type: 'function', function: { name: 'get_gate', arguments: '{"a":1}' } }] });
  assert.deepEqual(r.usage, { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 });
  assert.equal(r.model, 'claude-x');
  assert.equal(s.error, null);
});

test('an error event is kept for the caller and a tool call with no arguments gets {}', () => {
  const s = Llm.anthropicStream();
  s.push({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'a', name: 'n', input: {} } });
  assert.equal(s.result().message.tool_calls[0].function.arguments, '{}');
  s.push({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } });
  assert.equal(s.error, 'Overloaded');
});

const BASE = { model: 'claude-sonnet-5-5', messages: [{ role: 'user', content: 'hi' }], tools: [], stream: false };

test('request for anthropic: key from the named variable (default ANTHROPIC_API_KEY), model in the body', () => {
  const r = Llm.request({ provider: 'anthropic' }, { ...BASE, env: { ANTHROPIC_API_KEY: 'sk-ant-1' } });
  assert.equal(r.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(r.headers['x-api-key'], 'sk-ant-1');
  assert.equal(r.headers['anthropic-version'], '2023-06-01');
  assert.equal(r.body.model, 'claude-sonnet-5-5');
  assert.equal(r.body.max_tokens, 4096);
  assert.equal(r.body.stream, undefined);
  assert.equal(Llm.request({ provider: 'anthropic', apiKeyEnv: 'MY_K', baseUrl: 'http://localhost:9/', maxTokens: 100 }, { ...BASE, stream: true, env: { MY_K: 'k' } }).url, 'http://localhost:9/v1/messages');
  const s = Llm.request({ provider: 'anthropic', apiKeyEnv: 'MY_K', maxTokens: 100 }, { ...BASE, stream: true, env: { MY_K: 'k' } });
  assert.equal(s.body.stream, true);
  assert.equal(s.body.max_tokens, 100);
});

test('request for anthropic says what is missing', () => {
  assert.deepEqual(Llm.request({ provider: 'anthropic' }, { ...BASE, env: {} }), { error: 'no_key', env: 'ANTHROPIC_API_KEY' });
  assert.deepEqual(Llm.request({ provider: 'anthropic', apiKeyEnv: 'K2' }, { ...BASE, env: {} }), { error: 'no_key', env: 'K2' });
  assert.deepEqual(Llm.request({ provider: 'anthropic' }, { ...BASE, model: '', env: { ANTHROPIC_API_KEY: 'k' } }), { error: 'not_configured' });
});

test('request for vertex: project and region from settings or the usual variables, token as bearer, model in the URL', () => {
  const r = Llm.request({ provider: 'vertex', project: 'my-proj', region: 'europe-west1' }, { ...BASE, model: 'claude-sonnet-4-5@20250929', token: 'ya29.x', env: {} });
  assert.equal(r.url, 'https://europe-west1-aiplatform.googleapis.com/v1/projects/my-proj/locations/europe-west1/publishers/anthropic/models/claude-sonnet-4-5@20250929:rawPredict');
  assert.equal(r.headers.authorization, 'Bearer ya29.x');
  assert.equal(r.body.anthropic_version, 'vertex-2023-10-16');
  assert.equal('model' in r.body, false);
  const g = Llm.request({ provider: 'vertex' }, { ...BASE, stream: true, token: 't', env: { ANTHROPIC_VERTEX_PROJECT_ID: 'p1' } });
  assert.equal(g.url, 'https://aiplatform.googleapis.com/v1/projects/p1/locations/global/publishers/anthropic/models/claude-sonnet-5-5:streamRawPredict', 'global is the default region');
  assert.equal(Llm.request({ provider: 'vertex' }, { ...BASE, token: 't', env: { GOOGLE_CLOUD_PROJECT: 'p2', CLOUD_ML_REGION: 'us-east5' } }).url.startsWith('https://us-east5-aiplatform.googleapis.com/v1/projects/p2/locations/us-east5/'), true);
});

test('request for vertex refuses a missing project and values that could change the URL', () => {
  assert.deepEqual(Llm.request({ provider: 'vertex' }, { ...BASE, token: 't', env: {} }), { error: 'no_project' });
  assert.equal(Llm.request({ provider: 'vertex', project: 'a/../b' }, { ...BASE, token: 't', env: {} }).error, 'invalid');
  assert.equal(Llm.request({ provider: 'vertex', project: 'p', region: 'x.evil.com/' }, { ...BASE, token: 't', env: {} }).error, 'invalid');
  assert.equal(Llm.request({ provider: 'vertex', project: 'p' }, { ...BASE, model: 'm:rawPredict?x=1', token: 't', env: {} }).error, 'invalid');
});
