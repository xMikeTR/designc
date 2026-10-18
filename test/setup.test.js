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

// ---- providers: anthropic (a local API key) beside the OpenAI-compatible gateway ----
const ANT = { provider: 'anthropic', model: 'claude-sonnet-5-5' };

test('anthropic reads ANTHROPIC_API_KEY by default and needs no base URL', () => {
  assert.deepEqual(Setup.envNames({ llm: ANT }), ['ANTHROPIC_API_KEY']);
  assert.deepEqual(Setup.envNames({ llm: { ...ANT, apiKeyEnv: 'MY_K' } }), ['MY_K']);
  assert.deepEqual(Setup.envNames({ llm: { model: 'm' } }), ['DESIGNC_LLM_API_KEY'], 'no provider is the gateway, as before');
  assert.deepEqual(Setup.validate({ llm: ANT }), []);
});

test('validate names an unknown provider and checks an anthropic base URL like any other', () => {
  assert.equal(Setup.validate({ llm: { provider: 'bedrock' } })[0].field, 'llm.provider');
  assert.equal(Setup.validate({ llm: { ...ANT, baseUrl: 'http://example.com' } })[0].field, 'llm.baseUrl');
});

test('probe for anthropic goes to api.anthropic.com with the key in x-api-key and one token', () => {
  const p = Setup.probe('llm', { llm: ANT }, { ANTHROPIC_API_KEY: 'sk-1' });
  assert.equal(p.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(p.init.headers['x-api-key'], 'sk-1');
  assert.equal(JSON.parse(p.init.body).max_tokens, 1);
  assert.equal(JSON.parse(p.init.body).model, 'claude-sonnet-5-5');
  assert.equal(Setup.probe('llm', { llm: ANT }, {}).error, 'missing');
  assert.equal(Setup.probe('llm', { llm: { provider: 'anthropic' } }, { ANTHROPIC_API_KEY: 'k' }).error, 'incomplete');
});

test('hostOf gives the host a section talks to, so Test connection knows what is already saved', () => {
  assert.equal(Setup.hostOf('llm', ANT), 'api.anthropic.com');
  assert.equal(Setup.hostOf('llm', { baseUrl: 'https://gw.example.com/v1' }), 'gw.example.com');
  assert.equal(Setup.hostOf('llm', { provider: 'anthropic', baseUrl: 'http://localhost:9' }), 'localhost:9');
  assert.equal(Setup.hostOf('llm', undefined), null);
});

test('verdict names the provider it talked to', () => {
  assert.deepEqual(Setup.verdict('llm', { llm: ANT }, { status: 200, body: { model: 'claude-x' } }), { ok: true, detail: 'The Anthropic API answered as claude-x.' });
  assert.match(Setup.verdict('llm', { llm: ANT }, { status: 401, body: {} }).error, /^The Anthropic API refused the key/);
  assert.match(Setup.verdict('llm', { llm: ANT }, { status: 404, body: { error: { message: 'model: nope' } } }).hint, /model name/);
});

test('merge sets provider, and drops it when the gateway is chosen so older files stay as they were', () => {
  assert.deepEqual(Setup.merge({}, { llm: { provider: 'anthropic', model: 'm', baseUrl: '', apiKeyEnv: '' } }), { llm: { provider: 'anthropic', model: 'm' } });
  assert.deepEqual(Setup.merge({ llm: { provider: 'anthropic', model: 'm' } }, { llm: { provider: 'openai', baseUrl: 'https://g/v1', model: 'm' } }), { llm: { baseUrl: 'https://g/v1', model: 'm' } });
});

// ---- vertex: Claude on Vertex AI with Application Default Credentials ----
const VTX = { provider: 'vertex', project: 'my-proj', region: 'europe-west1', model: 'claude-sonnet-4-5@20250929' };

test('vertex reads no key variable and checks project and region', () => {
  assert.deepEqual(Setup.envNames({ llm: VTX }), []);
  assert.deepEqual(Setup.validate({ llm: VTX }), []);
  assert.equal(Setup.validate({ llm: { ...VTX, project: 'a/b' } })[0].field, 'llm.project');
  assert.equal(Setup.validate({ llm: { ...VTX, region: 'x.evil.com' } })[0].field, 'llm.region');
});

test('probe for vertex gives the URL for the confirm and says what is missing', () => {
  const p = Setup.probe('llm', { llm: VTX }, {});
  assert.match(p.url, /^https:\/\/europe-west1-aiplatform\.googleapis\.com\//);
  assert.equal(p.vertex, true);
  assert.equal(Setup.probe('llm', { llm: { ...VTX, project: '' } }, {}).error, 'incomplete');
  assert.match(Setup.probe('llm', { llm: { ...VTX, project: '' } }, {}).hint, /project/);
  assert.equal(Setup.probe('llm', { llm: { ...VTX, model: '' } }, {}).error, 'incomplete');
});

test('hostOf for vertex is the regional Vertex host, and global has none in front', () => {
  assert.equal(Setup.hostOf('llm', VTX), 'europe-west1-aiplatform.googleapis.com');
  assert.equal(Setup.hostOf('llm', { provider: 'vertex', project: 'p' }), 'aiplatform.googleapis.com');
});

test('verdict for vertex points at gcloud and the project, not a key', () => {
  assert.deepEqual(Setup.verdict('llm', { llm: VTX }, { status: 200, body: { model: 'claude-x' } }), { ok: true, detail: 'Vertex AI answered as claude-x.' });
  const v = Setup.verdict('llm', { llm: VTX }, { status: 403, body: {} });
  assert.match(v.error, /^Vertex AI refused/); assert.match(v.hint, /gcloud auth application-default login/); assert.match(v.hint, /my-proj/);
  assert.match(Setup.verdict('llm', { llm: VTX }, { status: 404, body: {} }).hint, /region/);
});

test('merge keeps project and region for vertex', () => {
  assert.deepEqual(Setup.merge({}, { llm: { provider: 'vertex', project: 'p', region: '', model: 'm', apiKeyEnv: '' } }), { llm: { provider: 'vertex', project: 'p', model: 'm' } });
});

test('llmReady says whether designc.json names enough to call a model, per provider', () => {
  assert.equal(Setup.llmReady({ baseUrl: 'https://g/v1', model: 'm' }), true);
  assert.equal(Setup.llmReady({ model: 'm' }), false, 'a gateway needs a base URL');
  assert.equal(Setup.llmReady({ provider: 'anthropic', model: 'm' }), true);
  assert.equal(Setup.llmReady({ provider: 'vertex', project: 'p', model: 'm' }), true);
  assert.equal(Setup.llmReady({ provider: 'vertex', model: 'm' }), false);
  assert.equal(Setup.llmReady(undefined), false);
});

test('kind: design when absent, study and factory by name, anything else is design with a problem', () => {
  assert.deepEqual(Setup.kind({}), { kind: 'design', problem: null });
  assert.deepEqual(Setup.kind(null), { kind: 'design', problem: null });
  assert.deepEqual(Setup.kind({ kind: 'study' }), { kind: 'study', problem: null });
  assert.deepEqual(Setup.kind({ kind: 'factory' }), { kind: 'factory', problem: null });
  assert.deepEqual(Setup.kind({ kind: 'notes' }), { kind: 'design', problem: 'designc.json kind is notes. Use design, study, factory or domain; it is read as design.' });
});

test('a study notebook draft writes kind study and no model', () => {
  assert.deepEqual(Setup.merge({ registries: { x: '../x' } }, { kind: 'study', model: '', llm: null, langfuse: null }), { registries: { x: '../x' }, kind: 'study' });
  assert.deepEqual(Setup.merge({ kind: 'study' }, { kind: 'design', model: 'model/workspace.dsl', llm: null, langfuse: null }), { model: 'model/workspace.dsl' });
});
