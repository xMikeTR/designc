const { test } = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../renderer/core.js');

test('slugId: kebab-case of the first words, at most 48 characters', () => {
  assert.equal(Core.slugId('Quote writes use optimistic concurrency', []), 'quote-writes-use-optimistic-concurrency');
  assert.equal(Core.slugId('  Pricing API: retry on 5xx, never on 4xx!  ', []), 'pricing-api-retry-on-5xx-never-on-4xx');
  const long = Core.slugId('A very long statement about the pricing engine retention thresholds and reinstatement premiums', []);
  assert.ok(long.length <= 48, long); assert.ok(!long.endsWith('-'), long);
  assert.equal(Core.slugId('', []), 'untitled');
  assert.equal(Core.slugId('!!!', []), 'untitled');
});

test('slugId: a clash gets -2, -3; taken may be an array or a Set', () => {
  assert.equal(Core.slugId('Use a queue', ['use-a-queue']), 'use-a-queue-2');
  assert.equal(Core.slugId('Use a queue', new Set(['use-a-queue', 'use-a-queue-2'])), 'use-a-queue-3');
  assert.equal(Core.slugId('Use a queue', ['USE-A-QUEUE']), 'use-a-queue-2');
});

const model = Core.parse('workspace {\n model {\n  a = softwareSystem "A"\n }\n}');
const gate = (o = {}) => Core.gate({ model, diags: [], decisions: [], requirements: [], ledger: [], ...o });
const bound = id => ({ id, status: 'bound', effect: 'accept', checks: ['x'], binds: [], resolves: [] });

test('gate: a repeated decision id blocks, once per id, naming the id', () => {
  const g = gate({ decisions: [bound('d1'), bound('d1'), bound('d1')], ledger: [{ kind: 'check', decision: 'd1', outcome: 'pass', _ts: 1 }] });
  const dup = g.clauses.filter(c => c.kind === 'duplicate');
  assert.equal(dup.length, 1); assert.equal(dup[0].text, 'duplicate id d1');
  assert.equal(g.ready, false);
});

test('gate: a repeated requirement id blocks', () => {
  const r = { id: 'HRE-1', elements: ['A'] };
  assert.deepEqual(gate({ requirements: [r, r] }).clauses.map(c => c.text), ['duplicate id HRE-1']);
  assert.equal(gate({ requirements: [r] }).ready, true);
});

test('gate: a registry file that does not parse blocks', () => {
  const g = gate({ registryErrors: [{ path: 'decisions/d1.yaml', message: 'bad indentation' }] });
  assert.deepEqual(g.clauses.map(c => c.text), ['decisions/d1.yaml does not parse']);
  assert.equal(g.clauses[0].kind, 'registry');
  assert.equal(gate().ready, true);
});

test('sample registry still compiles to 2 errors, 5 warnings, 1 suppressed', () => {
  const m = Core.parse(require('fs').readFileSync(__dirname + '/../sample-registry/model/workspace.dsl', 'utf8'));
  const d = Core.check(m, { chainHops: 4 });
  assert.equal(d.filter(x => !x.suppressed && x.sev === 'error').length, 2);
  assert.equal(d.filter(x => !x.suppressed && x.sev === 'warning').length, 5);
  assert.equal(d.filter(x => x.suppressed).length, 1);
});
