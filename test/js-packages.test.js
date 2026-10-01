const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const { extract } = require('../extract.js');
const js = require('../extract/js.js');

const FIXTURE = path.join(__dirname, '..', 'fixtures', 'fullstack');
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

async function buildCtx(repo) {
  const files = await walk(repo);
  const rel = f => path.relative(repo, f).split(path.sep).join('/');
  const read = f => fsp.readFile(f, 'utf8');
  return { repo, files, rel, read, opts: {} };
}

test('classifies SPA, Node API and library packages', async () => {
  const ctx = await buildCtx(FIXTURE);
  const r = await js.scan(ctx);

  const ui = r.elements.find(e => e.name === 'ui');
  assert.ok(ui, 'ui element missing');
  assert.equal(ui.kind, 'container');
  assert.equal(ui.tech, 'React SPA (Vite)');

  const api = r.elements.find(e => e.name === 'node-api');
  assert.ok(api, 'node-api element missing');
  assert.equal(api.kind, 'container');
  assert.equal(api.tech, 'Node.js (Express)');

  assert.equal(r.elements.some(e => e.name === 'shared-lib'), false, 'shared-lib should not be an element');
  const sharedProject = r.projects.find(p => p.name === 'shared-lib');
  assert.ok(sharedProject, 'shared-lib missing from projects');
  assert.equal(sharedProject.kind, 'library');
});

test('resolves express router prefixes into provided routes', async () => {
  const ctx = await buildCtx(FIXTURE);
  const r = await js.scan(ctx);
  const owner = keyOf('node-api');
  const httpProvides = r.provides.filter(p => p.kind === 'http' && p.owner === owner);

  const getInvoice = httpProvides.find(p => p.key === '/api/v2/invoices/{}');
  assert.ok(getInvoice, 'missing GET /api/v2/invoices/{}');
  assert.match(getInvoice.evidence.file, /routes\/invoices\.js$/);
  assert.equal(typeof getInvoice.evidence.line, 'number');

  const postInvoices = httpProvides.find(p => p.key === '/api/v2/invoices');
  assert.ok(postInvoices, 'missing POST /api/v2/invoices');
  assert.match(postInvoices.evidence.file, /routes\/invoices\.js$/);

  assert.equal(httpProvides.length, 2, 'no spurious duplicate/unmounted routes expected');
});

test('extracting the fullstack fixture end to end surfaces ui and node-api as elements', async () => {
  const r = await extract(FIXTURE);
  assert.equal('error' in r, false, r.error);
  assert.ok(r.facts.elements.some(e => e.name === 'ui' && e.kind === 'container'), 'ui missing from facts.elements');
  assert.ok(r.facts.elements.some(e => e.name === 'node-api' && e.kind === 'container'), 'node-api missing from facts.elements');
  assert.equal(r.facts.elements.some(e => e.name === 'shared-lib'), false, 'shared-lib should not appear as an element');
});
