const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fsp = require('fs').promises;
const csharp = require('../extract/csharp.js');

const FIXTURE = path.join(__dirname, '..', 'fixtures', 'fullstack', 'api');
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

async function scanFixture() {
  const files = await walk(FIXTURE);
  const rel = f => path.relative(FIXTURE, f).split(path.sep).join('/');
  const read = f => fsp.readFile(f, 'utf8');
  return csharp.scan({ repo: FIXTURE, files, rel, read, opts: {} });
}

test('resolves minimal API, controller and Functions routes', async () => {
  const r = await scanFixture();
  const api = keyOf('Shop.Api');
  const fn = keyOf('Shop.Functions');
  const httpProvides = r.provides.filter(p => p.kind === 'http');

  assert.ok(httpProvides.some(p => p.owner === api && p.key === '/api/v1/orders/{}'), 'missing Shop.Api /api/v1/orders/{}');
  assert.ok(httpProvides.some(p => p.owner === api && p.key === '/api/v1/orders'), 'missing Shop.Api /api/v1/orders');
  assert.ok(httpProvides.some(p => p.owner === api && p.key === '/api/v1/customers/{}'), 'missing Shop.Api /api/v1/customers/{}');
  assert.ok(httpProvides.some(p => p.owner === fn && p.key === '/api/v1/orders/{}'), 'missing Shop.Functions /api/v1/orders/{}');
});

test('resolves Service Bus attributes and catalogue stores through library closures', async () => {
  const r = await scanFixture();
  const api = keyOf('Shop.Api');
  const fn = keyOf('Shop.Functions');

  const queueConsumes = r.consumes.filter(c => c.kind === 'queue' && c.owner === fn);
  const queueProvides = r.provides.filter(p => p.kind === 'queue' && p.owner === fn);
  assert.ok(queueConsumes.some(c => c.key === 'orders'), 'missing Shop.Functions consume of queue "orders"');
  assert.ok(queueProvides.some(p => p.key === 'orders'), 'missing Shop.Functions provide of queue "orders"');

  const snowflake = r.elements.filter(e => e.name === 'Snowflake');
  assert.equal(snowflake.length, 1, 'Snowflake should appear exactly once');
  assert.equal(snowflake[0].kind, 'store');
  assert.ok(r.edges.some(e => e.from === api && e.to === keyOf('Snowflake') && e.kind === 'data'), 'missing Shop.Api -> Snowflake edge');
  assert.ok(r.edges.some(e => e.from === fn && e.to === keyOf('Snowflake') && e.kind === 'data'), 'missing Shop.Functions -> Snowflake edge');

  const entra = r.elements.find(e => e.name === 'Entra ID');
  assert.ok(entra, 'Entra ID external missing');
  assert.equal(entra.kind, 'external');
  assert.ok(r.edges.some(e => e.from === api && e.to === keyOf('Entra ID')), 'missing Shop.Api -> Entra ID edge');
});
