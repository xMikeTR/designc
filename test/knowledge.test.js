'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const Knowledge = require('../renderer/knowledge.js');

const resolve = n => ({ 'Tags UI': 'Tags/Tags UI', 'Tags API': 'Tags/Tags API', 'Tags DB': 'Tags/Tags DB', 'Billing API': 'Billing/Billing API', 'Tags/Tags UI': 'Tags/Tags UI' })[n] || null;
const decisions = [
  { id: 'd-ui', status: 'bound', binds: ['Tags UI'], enforced_by: ['chk-1a2b3c4d'] },
  { id: 'd-db', status: 'bound', scope: ['el:Tags DB'] },
  { id: 'd-bill', status: 'bound', binds: ['Billing API'] },
  { id: 'd-free', status: 'bound' },
  { id: 'd-draft', status: 'minted', binds: ['Tags UI'] },
  { id: 'd-old', status: 'superseded', binds: ['Tags UI'] },
];
const episodes = [
  { run: 'R1', task: 'T1', item: 'W1', final: true, outcome: 'failed', cause: 'stalled', ref: null, elements: ['Tags UI'] },
  { run: 'R2', task: 'T1', item: 'W1', final: true, outcome: 'passed', cause: 'ci_failed', ref: { kind: 'ci', id: '1' }, elements: ['Tags/Tags UI'] },
  { run: 'R3', task: 'T2', item: null, final: true, outcome: 'failed', cause: 'stalled', ref: null, elements: ['Tags API'] },
  { run: 'R4', task: 'T3', item: null, final: true, outcome: 'passed', cause: null, ref: null, elements: ['Tags DB'] },
  { run: 'R5', task: 'T4', item: null, final: false, outcome: 'blocked', cause: 'parked', ref: null, elements: [] },
];
const events = [
  { kind: 'trace', run: 'R1', task: 'T1', bundle_id: 'sha256:a', tokens_in: 100, tokens_out: 50 },
  { kind: 'trace', run: 'R1', task: 'T1', bundle_id: 'sha256:a', tokens_in: 200, tokens_out: 100 },
  { kind: 'trace', run: 'R2', task: 'T1', bundle_id: 'sha256:b', tokens_in: 100, tokens_out: 0 },
  { kind: 'trace', run: 'R3', task: 'T2', bundle_id: null, tokens_in: 1000, tokens_out: 0 },
];

test('live set per area, graduation, unused and recurrence', () => {
  const h = Knowledge.health({ decisions, episodes, events, resolve });
  assert.strictEqual(h.live, 4);
  assert.deepStrictEqual(h.areas, [
    { area: '(no element)', live: 1, enforced: 0 },
    { area: 'Billing/Billing API', live: 1, enforced: 0 },
    { area: 'Tags/Tags DB', live: 1, enforced: 0 },
    { area: 'Tags/Tags UI', live: 1, enforced: 1 },
  ]);
  assert.deepStrictEqual(h.graduate, [{ id: 'd-ui', enforced_by: ['chk-1a2b3c4d'] }]);
  assert.deepStrictEqual(h.unused, ['d-bill']);
  assert.deepStrictEqual(h.recurrence, [
    { cause: 'stalled', count: 2, runs: 2, items: 1, recurring: true },
    { cause: 'ci_failed', count: 1, runs: 1, items: 1, recurring: false },
  ]);
  assert.deepStrictEqual(h.tokens, { withBundle: { rows: 2, mean: 200 }, withoutBundle: { rows: 1, mean: 1000 }, bundles: 2 });
});

test('no episodes: unused is unknown, not every decision', () => {
  const h = Knowledge.health({ decisions, episodes: [], events: [], resolve });
  assert.strictEqual(h.unused, null);
  assert.deepStrictEqual(h.recurrence, []);
  assert.deepStrictEqual(h.tokens.withBundle, { rows: 0, mean: null });
});

test('fixture registry through the headless core and CLI', async () => {
  const Headless = require('../headless/index.js');
  const REG = path.join(__dirname, '..', 'fixtures', 'core-registry');
  const h = Headless.knowledge(Headless.open(REG));
  assert.ok(h.live >= 1);
  assert.deepStrictEqual(h.recurrence.map(r => r.cause), ['stalled']);
  assert.strictEqual(h.tokens.withBundle.rows + h.tokens.withoutBundle.rows, 2);
  const { main } = require('../scripts/designc-core.js');
  const out = [];
  assert.strictEqual(await main(['health', '--registry', REG, '--json'], { log: s => out.push(s), err: () => {} }), 0);
  assert.strictEqual(JSON.parse(out.join('\n')).live, h.live);
  out.length = 0;
  assert.strictEqual(await main(['health', '--registry', REG], { log: s => out.push(s), err: () => {} }), 0);
  assert.match(out.join('\n'), /live decisions/);
});

test('overlaps: a second answer to one finding is same, a shared element alone is near', () => {
  const decs = [
    { id: 'occ', status: 'bound', binds: ['Tags DB'], resolves: ['DC002'], statement: 'optimistic' },
    { id: 'occ-draft', status: 'minted', binds: ['Tags/Tags DB'], resolves: ['dc002'] },
    { id: 'old', status: 'superseded', binds: ['Tags DB'], resolves: ['DC002'] },
    { id: 'free', status: 'bound', binds: ['Tags DB'] },
    { id: 'biz', status: 'bound', kind: 'business', requirement: 'HRE-1' },
  ];
  const r = Knowledge.overlaps({ binds: ['Tags DB'], resolves: ['DC002'] }, decs, { resolve });
  assert.deepStrictEqual(r.map(x => [x.id, x.level, x.elements, x.codes]), [['occ', 'same', ['Tags/Tags DB'], ['DC002']], ['occ-draft', 'same', ['Tags/Tags DB'], ['DC002']]]);
  assert.deepStrictEqual(Knowledge.overlaps({ binds: ['Tags DB'] }, decs, { resolve }).map(x => [x.id, x.level]), [['free', 'near']]);
  assert.deepStrictEqual(Knowledge.overlaps({ kind: 'business', requirement: 'HRE-1' }, decs).map(x => x.id), ['biz']);
  assert.deepStrictEqual(Knowledge.overlaps({ id: 'occ', binds: ['Tags DB'], resolves: ['DC002'] }, decs.slice(0, 1)), []);
  assert.deepStrictEqual(Knowledge.overlaps({ binds: ['Billing API'], resolves: ['DC002'] }, decs, { resolve }), []);
});

test('conflicts through the headless core and CLI', async () => {
  const Headless = require('../headless/index.js');
  const REG = path.join(__dirname, '..', 'fixtures', 'core-registry');
  const r = Headless.conflicts(Headless.open(REG), { binds: ['Tags API'] });
  assert.deepStrictEqual(r.overlaps.map(x => [x.id, x.level]), [['sort-server-side', 'near']]);
  const { main } = require('../scripts/designc-core.js');
  const out = [];
  assert.strictEqual(await main(['conflicts', '--registry', REG, '--element', 'Tags API', '--json'], { log: s => out.push(s), err: () => {} }), 0);
  assert.strictEqual(JSON.parse(out.join('\n')).overlaps[0].id, 'sort-server-side');
  out.length = 0;
  assert.strictEqual(await main(['conflicts', '--registry', REG, '--element', 'Billing'], { log: s => out.push(s), err: () => {} }), 0);
  assert.match(out.join('\n'), /no live or proposed decision/);
  assert.strictEqual(await main(['conflicts', '--registry', REG], { log: () => {}, err: () => {} }), 2);
});
