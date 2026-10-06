// Setup: the pure part of "Set up this folder". Env var names only, never values; a merge that keeps unknown keys;
// connection probes built from the draft and the environment, with plain verdicts.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Setup = require('../renderer/setup.js');

const LLM = { baseUrl: 'https://gateway.example.com/v1/', model: 'claude-sonnet', apiKeyEnv: 'MY_LLM_KEY' };
const LF = { baseUrl: 'https://cloud.langfuse.com', publicKeyEnv: 'LF_PK', secretKeyEnv: 'LF_SK' };

test('envStatus says only whether each well-formed name is set, never its value', () => {
  const env = { MY_LLM_KEY: 'sk-secret', EMPTY: '', PATH: '/bin' };
  const s = Setup.envStatus(['MY_LLM_KEY', 'EMPTY', 'MISSING', 'lower', 'A-B', '', 'PATH'], env);
  assert.deepEqual(s, { MY_LLM_KEY: true, EMPTY: false, MISSING: false, PATH: true });
  assert.ok(!JSON.stringify(s).includes('sk-secret'));
});

test('envNames lists the names a draft depends on, with the defaults for blank fields', () => {
  assert.deepEqual(Setup.envNames({ llm: LLM, langfuse: LF }), ['MY_LLM_KEY', 'LF_PK', 'LF_SK']);
  assert.deepEqual(Setup.envNames({ llm: { baseUrl: 'x' }, langfuse: {} }), ['DESIGNC_LLM_API_KEY', 'LANGFUSE_PUBLIC_KEY', 'LANGFUSE_SECRET_KEY']);
  assert.deepEqual(Setup.envNames({ llm: null, langfuse: null }), []);
});

test('validate refuses bad env names, non-https remote URLs and model paths outside the folder', () => {
  assert.deepEqual(Setup.validate({ model: 'model/workspace.dsl', llm: LLM, langfuse: LF }), []);
  assert.deepEqual(Setup.validate({ llm: { ...LLM, baseUrl: 'http://localhost:4000/v1' }, langfuse: { ...LF, baseUrl: 'http://127.0.0.1:3000' } }), [], 'http is fine on this machine');
  const fields = d => Setup.validate(d).map(e => e.field);
  assert.deepEqual(fields({ llm: { ...LLM, apiKeyEnv: 'sk-ant-abc123' } }), ['llm.apiKeyEnv'], 'a pasted key is not a name');
  assert.deepEqual(fields({ llm: { ...LLM, baseUrl: 'http://gateway.example.com' } }), ['llm.baseUrl']);
  assert.deepEqual(fields({ langfuse: { ...LF, baseUrl: 'ftp://x' } }), ['langfuse.baseUrl']);
  assert.deepEqual(fields({ langfuse: { ...LF, secretKeyEnv: 'lf sk' } }), ['langfuse.secretKeyEnv']);
  for (const model of ['../x.dsl', '/etc/x.dsl', 'model/x.txt', 'a/../../x.dsl']) assert.deepEqual(fields({ model }), ['model'], model);
  assert.ok(Setup.validate({ llm: { ...LLM, apiKeyEnv: 'sk-1' } })[0].msg.includes('name of an environment variable'));
});

test('merge writes only the sections given, keeps every key it does not own, and drops blank fields', () => {
  const current = { model: 'm.dsl', codebase: '../repo', llm: { baseUrl: 'old', litellmMetadata: true }, langfuse: { baseUrl: 'old', tags: ['x'], sampleFile: 's.json' } };
  const out = Setup.merge(current, { llm: { ...LLM, apiKeyEnv: '' }, langfuse: null });
  assert.deepEqual(out, { model: 'm.dsl', codebase: '../repo', llm: { baseUrl: LLM.baseUrl, model: 'claude-sonnet', litellmMetadata: true }, langfuse: current.langfuse });
  assert.equal(current.llm.baseUrl, 'old', 'the current settings are not mutated');
  assert.deepEqual(Setup.merge({}, { model: 'model/workspace.dsl', langfuse: LF }), { model: 'model/workspace.dsl', langfuse: LF });
  assert.deepEqual(Setup.merge(null, {}), {});
  assert.deepEqual(Setup.merge({}, { llm: { baseUrl: '', model: '' }, langfuse: { baseUrl: ' ' } }), {}, 'a section left blank is not written');
  assert.deepEqual(Setup.merge({ llm: { baseUrl: 'x' } }, { llm: { baseUrl: '' } }), {}, 'clearing every field removes the section');
});

test('probe builds a one-token chat for the LLM and a one-row read for Langfuse, keys from the environment', () => {
  const env = { MY_LLM_KEY: 'k1', LF_PK: 'pk', LF_SK: 'sk' };
  const l = Setup.probe('llm', { llm: LLM }, env);
  assert.equal(l.url, 'https://gateway.example.com/v1/chat/completions');
  assert.equal(l.init.method, 'POST');
  assert.equal(l.init.headers.authorization, 'Bearer k1');
  assert.deepEqual(JSON.parse(l.init.body), { model: 'claude-sonnet', messages: [{ role: 'user', content: 'Reply with OK.' }], max_tokens: 1 });
  const f = Setup.probe('langfuse', { langfuse: LF }, env);
  assert.equal(f.url, 'https://cloud.langfuse.com/api/public/v2/observations?limit=1&fields=core');
  assert.equal(f.init.headers.authorization, 'Basic ' + Buffer.from('pk:sk').toString('base64'));
});

test('probe says what is missing instead of calling out', () => {
  assert.deepEqual(Setup.probe('llm', { llm: LLM }, {}), { error: 'missing', env: ['MY_LLM_KEY'], hint: 'Set MY_LLM_KEY in your environment, then restart designc.' });
  assert.deepEqual(Setup.probe('langfuse', { langfuse: LF }, { LF_PK: 'pk' }).env, ['LF_SK']);
  assert.equal(Setup.probe('llm', { llm: { ...LLM, model: '' } }, { MY_LLM_KEY: 'k' }).error, 'incomplete');
  assert.equal(Setup.probe('langfuse', { langfuse: { ...LF, baseUrl: '' } }, {}).error, 'incomplete');
  assert.equal(Setup.probe('llm', { llm: { ...LLM, baseUrl: 'http://evil.example.com' } }, { MY_LLM_KEY: 'k' }).error, 'invalid', 'never sends a key over plain http');
  assert.equal(Setup.probe('nope', {}, {}).error, 'invalid');
});

test('verdict turns an HTTP status into a plain result, naming the variable when a key is refused', () => {
  assert.deepEqual(Setup.verdict('llm', { llm: LLM }, { status: 200, body: { model: 'claude-sonnet-5-5' } }), { ok: true, detail: 'The gateway answered as claude-sonnet-5-5.' });
  assert.deepEqual(Setup.verdict('langfuse', { langfuse: LF }, { status: 200, body: { data: [] } }), { ok: true, detail: 'Langfuse accepted the keys.' });
  assert.match(Setup.verdict('llm', { llm: LLM }, { status: 401, body: {} }).hint, /MY_LLM_KEY/);
  assert.match(Setup.verdict('langfuse', { langfuse: LF }, { status: 403, body: {} }).hint, /LF_PK and LF_SK/);
  assert.match(Setup.verdict('llm', { llm: LLM }, { status: 404, body: {} }).hint, /base URL/);
  assert.match(Setup.verdict('llm', { llm: LLM }, { status: 400, body: { error: { message: 'model not found' } } }).error, /model not found/);
  assert.match(Setup.verdict('llm', { llm: LLM }, { network: 'ECONNREFUSED' }).error, /ECONNREFUSED/);
});

test('exportLine shows the line to add to a shell profile, with a placeholder, never a value', () => {
  assert.equal(Setup.exportLine('MY_LLM_KEY'), 'export MY_LLM_KEY="<your key>"');
  assert.equal(Setup.exportLine('bad name'), null);
});

test('the starter model parses with no errors', () => {
  const Core = require('../renderer/core.js');
  const m = Core.parse(Setup.STARTER_MODEL);
  assert.deepEqual(m.errors, []);
});
