'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const Records = require('../renderer/records.js');
const Memory = require('../renderer/memory.js');
const Headless = require('../headless/index.js');

const REG = path.join(__dirname, '..', 'fixtures', 'core-registry');

test('procedure records validate', () => {
  const ok = { id: 'p-ui', status: 'bound', title: 'Change a UI list', version: 2, scope: ['el:Tags UI'], steps: ['Read the parity report', 'Change the list'] };
  assert.deepStrictEqual(Records.validate('procedure', ok), []);
  assert.deepStrictEqual(Records.validate('procedure', { ...ok, version: '2.1', steps: 'one step' }), []);
  const bad = Records.validate('procedure', { id: 'p', status: 'bound', version: 0, steps: [1] });
  assert.ok(bad.includes('title: required'));
  assert.ok(bad.some(e => e.startsWith('version:')));
  assert.ok(bad.some(e => e.startsWith('scope:')));
  assert.ok(bad.some(e => e.startsWith('steps:')));
  assert.ok(Records.validate('procedure', { ...ok, id: 'prompt:x' }).some(e => e.startsWith('id:')));
});

test('procedure ref hashes the file text with LF line endings', () => {
  const a = Memory.ref({ id: 'p', version: 2 }, 'id: p\nversion: 2\n');
  const b = Memory.ref({ id: 'p', version: 2 }, 'id: p\r\nversion: 2\r\n');
  assert.deepStrictEqual(a, b);
  assert.deepStrictEqual(Object.keys(a), ['id', 'version', 'hash']);
  assert.strictEqual(a.version, '2');
  assert.match(a.hash, /^[0-9a-f]{16}$/);
});

const proc = (id, status, scope, extra = {}) => ({ rec: { id, status, title: id, version: 1, scope, steps: ['do it'], ...extra }, path: `procedures/${id}.yaml`, text: `id: ${id}\n` });

test('procedures for elements: bound only, valid only, through resolve', () => {
  const resolve = n => ({ 'Tags UI': 'Tags/Tags UI', 'Tags/Tags UI': 'Tags/Tags UI', 'Tags API': 'Tags/Tags API' })[n] || null;
  const recs = [
    proc('p-ui', 'bound', ['el:Tags UI']),
    proc('p-ui-id', 'bound', ['el:Tags/Tags UI']),
    proc('p-api', 'bound', ['el:Tags API']),
    proc('p-draft', 'proposed', ['el:Tags UI']),
    proc('p-old', 'retired', ['el:Tags UI']),
    { ...proc('p-bad', 'bound', ['el:Tags UI']), rec: { id: 'p-bad', status: 'bound', scope: ['el:Tags UI'] } },
  ];
  const r = Memory.procedures(recs, ['Tags/Tags UI'], resolve);
  assert.deepStrictEqual(r.procedures.map(p => p.id), ['p-ui', 'p-ui-id']);
  assert.deepStrictEqual(Object.keys(r.procedures[0]).sort(), ['hash', 'id', 'steps', 'title', 'version']);
  assert.deepStrictEqual(r.procedures[0].steps, ['do it']);
  assert.deepStrictEqual(r.invalid.map(x => x.id), ['p-bad']);
});

const ev = (kind, f) => ({ kind, ...f });
const events = () => [
  ev('handover', { handover: 'H1', revision: 'r-1', item: 'W-tags' }),
  ev('handover', { handover: 'H2', revision: 'r-2' }),
  ev('run_started', { run: 'R1', handover: 'H1' }),
  ev('trace', { run: 'R1', task: 'T-1', outcome: 'passed', bundle_id: 'sha256:a', models: ['m'], procedures: [{ id: 'p-ui', version: '1', hash: 'h1' }], tokens_in: 10, tokens_out: 5 }),
  ev('outcome', { run: 'R1', task: 'T-1', cause: 'ci_failed', ref: { kind: 'ci', id: '9' } }),
  ev('run_started', { run: 'R2', handover: 'H1' }),
  ev('trace', { run: 'R2', task: 'T-1', outcome: 'passed', bundle_id: null, models: ['m'], procedures: [{ id: 'p-ui', version: '1', hash: 'h1' }], tokens_in: 10, tokens_out: 5 }),
  ev('handover_closed', { handover: 'H1', outcome: 'delivered' }),
  ev('run_started', { run: 'R3', handover: 'H2' }),
  ev('task', { task: 'T-9', status: 'failed', run: 'R3', element: 'Tags API' }),
  ev('trace', { run: 'R3', task: 'T-9', outcome: 'failed', bundle_id: null, models: ['m'], procedures: [{ id: 'p-ui', version: '2', hash: 'h2' }], tokens_in: 1, tokens_out: 1, cause: 'stalled' }),
  ev('run_started', { run: 'R4', handover: 'H9' }),
  ev('trace', { run: 'R4', task: 'T-4', outcome: 'blocked', bundle_id: null, models: ['m'], procedures: [], tokens_in: 1, tokens_out: 1, cause: 'parked' }),
];
const items = [{ id: 'W-tags', elements: ['Tags UI', 'Tags API'] }];

test('episodes carry the elements of the work item or of the task rows', () => {
  const eps = Memory.episodes(events(), { items });
  const by = Object.fromEntries(eps.map(e => [`${e.run}/${e.task}`, e]));
  assert.deepStrictEqual(by['R1/T-1'].elements, ['Tags API', 'Tags UI']);
  assert.strictEqual(by['R1/T-1'].item, 'W-tags');
  assert.strictEqual(by['R1/T-1'].cause, 'ci_failed');
  assert.strictEqual(by['R2/T-1'].success, true);
  assert.deepStrictEqual(by['R3/T-9'].elements, ['Tags API']);
  assert.strictEqual(by['R3/T-9'].item, null);
  assert.deepStrictEqual(by['R4/T-4'].elements, []);
});

test('recall gives the episodes on an element, newest first', () => {
  const eps = Memory.episodes(events(), { items });
  const resolve = n => ({ 'Tags UI': 'Tags/Tags UI', 'Tags API': 'Tags/Tags API', 'Tags/Tags API': 'Tags/Tags API' })[n] || null;
  assert.deepStrictEqual(Memory.recall(eps, ['Tags/Tags API'], { resolve }).map(e => e.run), ['R3', 'R2', 'R1']);
  assert.deepStrictEqual(Memory.recall(eps, ['Tags UI'], { resolve, limit: 1 }).map(e => e.run), ['R2']);
  assert.deepStrictEqual(Memory.recall(eps, ['Nope'], { resolve }), []);
});

test('procedure stats count final outcomes per id and version', () => {
  const s = Memory.procedureStats(Memory.episodes(events(), { items }));
  assert.deepStrictEqual(s, [
    { id: 'p-ui', version: '1', hash: 'h1', uses: 2, passed: 1, failed: 1, success: 1, causes: { ci_failed: 1 } },
    { id: 'p-ui', version: '2', hash: 'h2', uses: 1, passed: 0, failed: 1, success: 0, causes: { stalled: 1 } },
  ]);
});

test('summary line for a card', () => {
  const eps = Memory.episodes(events(), { items });
  assert.deepStrictEqual(Memory.summary(eps), { tasks: 4, passed: 1, failed: 2, open: 1, causes: { ci_failed: 1, stalled: 1 } });
});

test('the fixture registry gives the bound procedure in the bundle', () => {
  const reg = Headless.open(REG);
  assert.deepStrictEqual(reg.problems, []);
  const b = Headless.bundle(reg, { work_item: 'W-tags', role: 'builder' });
  assert.deepStrictEqual(b.procedures.map(p => `${p.id}@${p.version}`), ['change-ui-list@2']);
  const eps = Headless.episodes(reg, { elements: ['Tags UI'] });
  assert.ok(!eps.error);
  assert.deepStrictEqual(eps.episodes.map(e => `${e.run}/${e.task}:${e.outcome}`), ['run-2/T-1:passed', 'run-1/T-1:failed']);
  const stats = Headless.procedureStats(reg);
  assert.deepStrictEqual(stats.map(s => `${s.id}@${s.version}:${s.uses}/${s.success}`), ['change-ui-list@1:1/0', 'change-ui-list@2:1/1']);
});

test('CLI: episodes and procedures', async () => {
  const { main } = require('../scripts/designc-core.js');
  const run = async argv => { const out = [], err = []; const code = await main(argv, { log: s => out.push(s), err: s => err.push(s) }); return { code, out: out.join('\n'), err: err.join('\n') }; };
  let r = await run(['episodes', '--registry', REG, '--item', 'W-tags']);
  assert.strictEqual(r.code, 0);
  assert.match(r.out, /^2 tasks: 1 passed, 1 failed, 0 not final \(stalled 1\)/);
  assert.match(r.out, /run-2\/T-1: passed, delivered, using change-ui-list@2/);
  r = await run(['episodes', '--registry', REG, '--element', 'Tags DB', '--json']);
  assert.strictEqual(r.code, 0);
  assert.deepStrictEqual(JSON.parse(r.out).episodes, []);
  r = await run(['episodes', '--registry', REG]);
  assert.strictEqual(r.code, 2);
  r = await run(['procedures', '--registry', REG, '--json']);
  assert.strictEqual(r.code, 0);
  assert.deepStrictEqual(JSON.parse(r.out).procedures.map(p => p.version), ['1', '2']);
});
