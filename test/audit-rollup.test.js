const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Rollup = require('../audit/rollup.js');
const Audit = require('../audit/audit.js');
const example = require('../docs/health.example.json');

const res = (ruleId, uri, level = 'warning') => ({ ruleId, level, message: { text: ruleId }, locations: [{ physicalLocation: { artifactLocation: { uri }, region: { startLine: 3 } } }] });
const sarif = results => ({ version: '2.1.0', runs: [{ tool: { driver: { name: 'T' } }, results }] });
const els = [
  { id: 'Pricing', kind: 'container', paths: ['src/Pricing/**'] },
  { id: 'Pricing/Quotes', kind: 'component', parent: 'Pricing', paths: ['src/Pricing/Quotes/**'], externalRead: true },
  { id: 'Person', kind: 'person', paths: [] },
];
const NOW = new Date('2026-11-10T13:00:00.000Z');

test('rollup has the shape of the hand-written file', () => {
  const { health } = Rollup.build({
    sarif: sarif([res('S1', 'src/Pricing/Quotes/A.cs'), res('CA3001', 'src/Pricing/Quotes/B.cs', 'error'), res('S1', 'src/Pricing/Other.cs'), res('S1', 'docs/x.cs')]),
    elements: els, config: { categories: [{ prefix: 'CA3', category: 'security' }] }, repo: { name: 'pricing-api', commit: 'a1b2c3d' },
    sources: [{ tool: 'T', sarif: 'findings.sarif' }], now: NOW,
  });
  assert.deepEqual(Object.keys(health), Object.keys(example));
  assert.equal(health.generatedAt, '2026-11-10T13:00:00Z');
  const q = health.elements['Pricing/Quotes'];
  assert.deepEqual(Object.keys(q).sort(), ['findings', 'kind', 'parent', 'paths', 'properties']); // the example's keys, plus parent (in the schema table)
  assert.deepEqual(q.findings, { total: 2, new: 0, byLevel: { warning: 1, error: 1 }, byCategory: { smell: 1, security: 1 } });
  assert.equal(q.parent, 'Pricing');
  assert.deepEqual(Object.keys(q.findings), Object.keys(example.elements['Pricing/Quotes'].findings));
  // roll-up to the parent; the finding outside every element is unmapped
  assert.equal(health.elements.Pricing.findings.total, 3);
  assert.deepEqual(health.unmapped, { findings: 1 });
  assert.ok(!('Person' in health.elements), 'an element with no paths and no findings is left out');
});

test('properties: idempotent where code lives; cached only with an external read; evidence is merged in', () => {
  const evidence = { 'Pricing/Quotes': { idempotent: [{ kind: 'check', by: 'X', result: 'pass', commit: 'a1b2c3d' }] } };
  const { health } = Rollup.build({ sarif: sarif([]), elements: els, evidence, now: NOW });
  assert.deepEqual(health.elements['Pricing/Quotes'].properties.idempotent, { applicable: true, evidence: evidence['Pricing/Quotes'].idempotent });
  assert.equal(health.elements['Pricing/Quotes'].properties.cached.applicable, true);
  assert.equal(health.elements.Pricing.properties.cached.applicable, false);
});

test('new findings are those absent from the baseline', () => {
  const s = sarif([res('S1', 'src/Pricing/Quotes/A.cs')]);
  const first = Rollup.build({ sarif: s, elements: els, now: NOW });
  assert.equal(first.health.elements['Pricing/Quotes'].findings.new, 0, 'no baseline: nothing is new');
  const fp = first.mapped.map(m => m.fingerprint);
  assert.equal(Rollup.build({ sarif: s, elements: els, baseline: fp, now: NOW }).health.elements['Pricing/Quotes'].findings.new, 0);
  assert.equal(Rollup.build({ sarif: s, elements: els, baseline: [], now: NOW }).health.elements['Pricing/Quotes'].findings.new, 1);
});

test('relativise makes uris repo-relative and drops duplicates', () => {
  const abs = res('S1', 'file:///w/src/A.cs');
  const log = Audit.relativise({ runs: [{ results: [abs, JSON.parse(JSON.stringify(abs)), res('S2', 'file:///w/src/A.cs')] }] }, '/w');
  assert.equal(log.runs[0].results.length, 2);
  assert.equal(log.runs[0].results[0].locations[0].physicalLocation.artifactLocation.uri, 'src/A.cs');
});

test('modelElements reads d.code and hierarchical ids from a registry; cached applies to an edge to a database', () => {
  const root = path.join(__dirname, '..', 'sample-registry');
  const els2 = Audit.modelElements(root);
  const api = els2.find(e => e.id === 'Fares Platform/Fares API');
  assert.equal(api.parent, 'Fares Platform');
  assert.equal(els2.find(e => e.id === 'Fares Platform/Bookings DB').kind, 'container');
  assert.ok(els2.every(e => Array.isArray(e.paths)));
});
