// designc-mcp.js with no app: the four read tools served from the registry on disk, same names, schemas and text as the app.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Headless = require('../headless/index.js');
const Core = require('../renderer/core.js');

const APP = path.resolve(__dirname, '..');
const SAMPLE = path.join(APP, 'sample-registry');
const FULLSTACK = path.join(APP, 'fixtures/fullstack');

// agent.js needs the DOM, so read its TOOLS lines and evaluate them with the same `obj` and LOCATOR helpers.
function appTools() {
  const src = fs.readFileSync(path.join(APP, 'renderer/agent.js'), 'utf8');
  const pick = n => src.split('\n').find(l => l.startsWith(`  ${n}: { d:`));
  const obj = (props, req = []) => ({ type: 'object', properties: props, required: req, additionalProperties: false });
  return new Function('obj', `return {${['read_model', 'get_findings', 'get_gate', 'get_code_map'].map(pick).join('\n')}}`)(obj);
}

test('headless tool definitions equal the app\'s TOOLS (names, descriptions, schemas)', () => {
  const app = appTools();
  const list = Headless.mcpTools();
  assert.deepEqual(list.map(t => t.name), ['read_model', 'get_findings', 'get_gate', 'get_code_map']);
  for (const t of list) { assert.equal(t.description, app[t.name].d); assert.deepEqual(t.inputSchema, app[t.name].p); }
});

test('get_gate equals the app handler on the same state (sample-registry)', () => {
  const s = Headless.checkState(SAMPLE);
  const g = Core.gate; assert.equal(typeof g, 'function');
  const appText = JSON.stringify({ ready: s.gate.ready, blocking: s.gate.clauses.map(c => ({ kind: c.kind, text: c.text, line: c.line })) });
  const r = Headless.callTool(SAMPLE, 'get_gate');
  assert.equal(r.isError, false);
  assert.equal(r.text, appText);
  const rep = Headless.check(SAMPLE).report; // and it agrees with `designc check --json`
  assert.equal(JSON.parse(r.text).ready, rep.gate.ready);
  assert.deepEqual(JSON.parse(r.text).blocking.map(c => c.text), rep.gate.clauses.map(c => c.text));
  assert.ok(JSON.parse(r.text).blocking.length > 0);
});

test('get_findings has the app format', () => {
  const s = Headless.checkState(SAMPLE);
  const expect = s.diags.map(f => ({ code: f.code, severity: f.sev, where: f.loc.label, line: f.loc.line, message: f.msg, hint: f.hint, unknownProperty: f.unknown || undefined, suppressed: f.suppressed || undefined }));
  const out = JSON.parse(Headless.callTool(SAMPLE, 'get_findings').text);
  assert.deepEqual(out, JSON.parse(JSON.stringify(expect)));
  assert.ok(out.length > 0 && 'severity' in out[0] && 'where' in out[0]);
});

test('read_model numbers lines and honours from/to', () => {
  const all = Headless.callTool(SAMPLE, 'read_model').text.split('\n');
  assert.match(all[0], /^ {3}1  workspace /);
  const part = Headless.callTool(SAMPLE, 'read_model', { from: 2, to: 3 }).text.split('\n');
  assert.equal(part.length, 2);
  assert.match(part[0], /^ {3}2  /); assert.match(part[1], /^ {3}3  /);
});

test('get_code_map: the app\'s "not extracted" text, and the map from asbuilt/facts.json', () => {
  assert.equal(Headless.callTool(SAMPLE, 'get_code_map').text, 'The codebase has not been extracted yet. Ask the user to run Extract Code Map.');
  const r = Headless.callTool(FULLSTACK, 'get_code_map');
  assert.equal(r.isError, false);
  const m = JSON.parse(r.text);
  const facts = JSON.parse(fs.readFileSync(path.join(FULLSTACK, 'asbuilt/facts.json'), 'utf8'));
  assert.equal(m.repo, facts.repo);
  assert.deepEqual(m.elements.map(e => e.name), facts.elements.map(e => e.name));
  for (const k of ['dependencies', 'drift', 'declaredIntent', 'codeAreas', 'unresolved']) assert.ok(k in m, k);
});

test('any other tool says the app is not running (never an empty result)', () => {
  for (const name of ['list_decisions', 'mint_decision', 'nope']) {
    const r = Headless.callTool(SAMPLE, name);
    assert.equal(r.isError, true);
    assert.equal(r.text, `designc app not running: ${name} needs the designc app open on this registry`);
  }
});

test('a folder that is not a registry is an error, not an empty answer', () => {
  const r = Headless.callTool(path.join(APP, 'nonexistent-dir'), 'get_gate');
  assert.equal(r.isError, true); assert.match(r.text, /is not a folder/);
});

// ---- the stdio server
const { spawn } = require('child_process');
const net = require('net');
const http = require('http');
const SERVER = path.join(APP, 'designc-mcp.js');

// Runs designc-mcp.js, sends the requests one per line, returns the responses by id.
function rpc(requests, { args = [], env = {}, cwd } = {}) {
  return new Promise((resolve, reject) => {
    const e = { ...process.env, ...env }; if (!('DESIGNC_MCP_URL' in env)) delete e.DESIGNC_MCP_URL;
    const p = spawn(process.execPath, [SERVER, ...args], { env: e, cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = ''; p.stdout.on('data', d => { out += d; if (out.split('\n').filter(Boolean).length >= requests.length) p.stdin.end(); }); // the server exits on stdin end, so end it only once every answer is in
    const timer = setTimeout(() => { p.kill(); reject(new Error('timeout; got ' + out)); }, 15000);
    p.on('close', () => { clearTimeout(timer); const by = {}; for (const l of out.split('\n').filter(Boolean)) { const m = JSON.parse(l); by[m.id] = m; } resolve(by); });
    p.stdin.write(requests.map(r => JSON.stringify({ jsonrpc: '2.0', ...r })).join('\n') + '\n');
  });
}
const REQS = [
  { id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
  { id: 2, method: 'tools/list' },
  { id: 3, method: 'tools/call', params: { name: 'get_gate', arguments: {} } },
  { id: 4, method: 'tools/call', params: { name: 'list_decisions', arguments: {} } },
];

test('stdio, no URL, --registry: initialize, tools/list (4) and get_gate match the core', async () => {
  const r = await rpc(REQS, { args: ['--registry', SAMPLE] });
  assert.match(r[1].result.instructions, /^designc app not running: headless mode/);
  assert.deepEqual(r[2].result.tools.map(t => t.name), ['read_model', 'get_findings', 'get_gate', 'get_code_map']);
  assert.equal(r[3].result.isError, false);
  assert.equal(r[3].result.content[0].text, Headless.callTool(SAMPLE, 'get_gate').text);
  assert.equal(r[4].result.isError, true);
  assert.match(r[4].result.content[0].text, /^designc app not running: list_decisions needs the designc app open/);
});

test('stdio: DESIGNC_REGISTRY and then the cwd choose the registry', async () => {
  const want = Headless.callTool(SAMPLE, 'get_gate').text;
  assert.equal((await rpc(REQS.slice(2, 3), { env: { DESIGNC_REGISTRY: SAMPLE } }))[3].result.content[0].text, want);
  assert.equal((await rpc(REQS.slice(2, 3), { cwd: SAMPLE }))[3].result.content[0].text, want);
});

test('stdio: a URL with nothing listening falls back to headless', async () => {
  const port = await new Promise(res => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
  const r = await rpc(REQS, { args: ['--registry', SAMPLE], env: { DESIGNC_MCP_URL: `http://127.0.0.1:${port}`, DESIGNC_MCP_TOKEN: 't' } });
  assert.match(r[1].result.instructions, /^designc app not running: headless mode/);
  assert.equal(r[2].result.tools.length, 4);
  assert.equal(r[3].result.content[0].text, Headless.callTool(SAMPLE, 'get_gate').text);
});

test('stdio: with an app listening, calls are forwarded unchanged (app mode)', async () => {
  const seen = [];
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', c => (b += c)); req.on('end', () => {
      seen.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(b) });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(req.url === '/tools/list' ? { tools: [{ name: 'only_in_app', description: 'd', inputSchema: { type: 'object' } }] } : { text: 'from the app', isError: false }));
    });
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  try {
    const r = await rpc(REQS, { args: ['--registry', SAMPLE], env: { DESIGNC_MCP_URL: `http://127.0.0.1:${srv.address().port}`, DESIGNC_MCP_TOKEN: 'tok' } });
    assert.doesNotMatch(r[1].result.instructions, /headless/);
    assert.deepEqual(r[2].result.tools.map(t => t.name), ['only_in_app']);
    assert.equal(r[3].result.content[0].text, 'from the app');
    assert.ok(seen.every(s => s.auth === 'Bearer tok'));
    assert.ok(seen.some(s => s.url === '/tools/call' && s.body.name === 'get_gate'));
  } finally { srv.close(); }
});
