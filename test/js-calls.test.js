const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const jsCalls = require('../extract/js-calls.js');

const FIXTURE = path.join(__dirname, '..', 'fixtures', 'fullstack');
const UI_DIR = path.join(FIXTURE, 'ui');
const keyOf = s => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');

async function walk(dir, out = []) {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await walk(p, out);
    else out.push(p);
  }
  return out;
}

async function buildUiCtxAndPackages() {
  const files = await walk(FIXTURE);
  const rel = f => path.relative(FIXTURE, f).split(path.sep).join('/');
  const read = f => fsp.readFile(f, 'utf8');
  const ctx = { repo: FIXTURE, files, rel, read, opts: {} };
  const uiFiles = files.filter(f => f.startsWith(UI_DIR + path.sep) && /\.(ts|tsx|js|jsx)$/i.test(f));
  const packages = [{ key: keyOf('ui'), name: 'ui', dir: UI_DIR, kind: 'spa', deps: [], files: uiFiles }];
  return { ctx, packages };
}

test('resolves wrapper base, env fallback and dev proxy onto http consumes', async () => {
  const { ctx, packages } = await buildUiCtxAndPackages();
  const r = await jsCalls.scan(ctx, packages);
  const owner = keyOf('ui');
  const httpConsumes = r.consumes.filter(c => c.kind === 'http' && c.owner === owner);

  const getOrder = httpConsumes.find(c => c.key === '/api/v1/orders/{}');
  assert.ok(getOrder, 'missing /api/v1/orders/{}');
  assert.equal(getOrder.env, 'VITE_API_BASE_URL');
  assert.equal(getOrder.devTarget, 'http://localhost:5010');

  const createOrder = httpConsumes.find(c => c.key === '/api/v1/orders');
  assert.ok(createOrder, 'missing /api/v1/orders');
  assert.equal(createOrder.env, 'VITE_API_BASE_URL');
  assert.equal(createOrder.devTarget, 'http://localhost:5010');

  const getCustomer = httpConsumes.find(c => c.key === '/api/v1/customers/{}');
  assert.ok(getCustomer, 'missing /api/v1/customers/{}');
  assert.equal(getCustomer.env, undefined, 'raw fetch call should not carry env');
  assert.equal(getCustomer.devTarget, 'http://localhost:5010');
});

test('maps SignalR, MSAL and New Relic through the shared catalogue', async () => {
  const { ctx, packages } = await buildUiCtxAndPackages();
  const r = await jsCalls.scan(ctx, packages);
  const owner = keyOf('ui');

  const hubConsumes = r.consumes.filter(c => c.kind === 'hub' && c.owner === owner);
  assert.equal(hubConsumes.length, 1, 'expected exactly one hub consume');
  assert.equal(hubConsumes[0].env, 'VITE_HUB_URL');
  assert.equal(hubConsumes[0].key, null);
  assert.equal(r.edges.some(e => e.kind === 'hub' || (e.from === owner && e.to === null)), false, 'no key-less edge should be created for the hub consume');

  const entra = r.elements.find(e => e.name === 'Entra ID');
  assert.ok(entra, 'Entra ID external missing');
  assert.equal(entra.kind, 'external');

  const newRelic = r.elements.find(e => e.name === 'New Relic');
  assert.ok(newRelic, 'New Relic external missing');
  assert.equal(newRelic.kind, 'external');

  assert.ok(r.edges.some(e => e.from === owner && e.to === keyOf('Entra ID')), 'missing edge to Entra ID');
  assert.ok(r.edges.some(e => e.from === owner && e.to === keyOf('New Relic')), 'missing edge to New Relic');
});

test('unresolvable fetch goes to unresolved, not to an edge', async () => {
  const fakeFile = path.join(UI_DIR, 'src', 'api', '__virtual-unresolvable.ts');
  const content = "export function callIt(someDynamicValue) {\n  return fetch(someDynamicValue);\n}\n";
  const ctx = {
    repo: FIXTURE,
    files: [fakeFile],
    rel: f => path.relative(FIXTURE, f).split(path.sep).join('/'),
    read: async f => (f === fakeFile ? content : fsp.readFile(f, 'utf8')),
    opts: {},
  };
  const packages = [{ key: keyOf('ui'), name: 'ui', dir: UI_DIR, kind: 'spa', deps: [], files: [fakeFile] }];
  const r = await jsCalls.scan(ctx, packages);

  assert.equal(r.unresolved.length, 1, 'expected exactly one unresolved entry');
  assert.equal(r.unresolved[0].file, 'ui/src/api/__virtual-unresolvable.ts');
  assert.equal(typeof r.unresolved[0].line, 'number');
  assert.equal(r.consumes.length, 0, 'no consume should be produced for an unresolvable fetch argument');
});
