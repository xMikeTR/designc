const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { extract } = require('../extract.js');
const link = require('../extract/link.js');

const FIXTURE = path.join(__dirname, '..', 'fixtures', 'fullstack');
const keyOf = s => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');

test('links SPA calls to the C# API across languages with port tie-break', async () => {
  const r = await extract(FIXTURE);
  assert.equal('error' in r, false, r.error);

  const toApi = r.facts.edges.find(e => e.from === 'ui' && e.to === 'Shop.Api' && e.kind === 'sync');
  assert.ok(toApi, 'missing ui -> Shop.Api sync edge');
  assert.ok(toApi.evidence.some(ev => /orders\.ts$/.test(ev.file)), 'evidence should include orders.ts');

  const toFunctions = r.facts.edges.find(e => e.from === 'ui' && e.to === 'Shop.Functions' && e.kind === 'sync');
  assert.equal(toFunctions, undefined, 'the dev-proxy port tie-break should route the call to Shop.Api, not Shop.Functions');

  assert.ok(toApi.evidence.some(ev => ev.text.includes('customers')), 'the /api/v1/customers/{} call should also land on Shop.Api');
});

test('applies designc.json bindings to env-only targets and leaves them unresolved otherwise', async () => {
  const withBinding = await extract(FIXTURE, { bindings: { VITE_HUB_URL: 'Notifications Hub' } });
  const hubEdge = withBinding.facts.edges.find(e => e.from === 'ui' && e.to === 'Notifications Hub' && e.kind === 'realtime');
  assert.ok(hubEdge, 'missing ui -> Notifications Hub realtime edge');
  assert.ok(hubEdge.evidence.some(ev => ev.file === 'designc.json' && /declared in designc\.json/.test(ev.text)));

  const withoutBinding = await extract(FIXTURE);
  assert.equal(withoutBinding.facts.edges.some(e => e.to === 'Notifications Hub'), false, 'no binding means no edge');
  const unresolvedHub = withoutBinding.facts.unresolved.filter(u => u.what.includes('VITE_HUB_URL'));
  assert.equal(unresolvedHub.length, 1, 'exactly one unresolved entry naming the unbound env var');
});

test('ambiguous providers go to unresolved with both candidates named', () => {
  const elements = new Map([
    [keyOf('Consumer'), { name: 'Consumer', kind: 'container', tech: 'x', evidence: [], ports: [] }],
    [keyOf('Alpha'), { name: 'Alpha', kind: 'container', tech: 'x', evidence: [], ports: ['9001'] }],
    [keyOf('Beta'), { name: 'Beta', kind: 'container', tech: 'x', evidence: [], ports: ['9002'] }],
  ]);
  const consumes = [
    { owner: keyOf('Consumer'), kind: 'http', key: '/orders/{}', evidence: { file: 'consumer.ts', line: 1, text: 'fetch("/orders/1")' } },
  ];
  const provides = [
    { owner: keyOf('Alpha'), kind: 'http', key: '/orders/{}', evidence: { file: 'alpha.cs', line: 1, text: 'MapGet' } },
    { owner: keyOf('Beta'), kind: 'http', key: '/orders/{}', evidence: { file: 'beta.cs', line: 1, text: 'MapGet' } },
  ];

  const { edges, unresolved } = link.link({ elements, consumes, provides });
  assert.equal(edges.length, 0, 'no edge should be created when ambiguous and no port tie-break applies');
  const entries = unresolved.filter(u => u.where === 'Consumer');
  assert.equal(entries.length, 1, 'exactly one unresolved entry');
  assert.match(entries[0].what, /Alpha/);
  assert.match(entries[0].what, /Beta/);
});
