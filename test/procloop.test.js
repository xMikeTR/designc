'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const Memory = require('../renderer/memory.js');
const ProcLoop = require('../renderer/procloop.js');

const REG = path.join(__dirname, '..', 'fixtures', 'core-registry');

const file = (id, status, version = 1) => {
  const text = `id: ${id}\nstatus: ${status}\ntitle: ${id}\nversion: ${version}\nscope: [el:A]\nsteps: [do it]\n`;
  return { rec: { id, status, title: id, version, scope: ['el:A'], steps: ['do it'] }, path: `procedures/${id}.yaml`, text };
};
const stat = (f, uses, passed, extra = {}) => ({ id: f.rec.id, version: String(f.rec.version), hash: Memory.ref(f.rec, f.text).hash, uses, passed, failed: uses - passed, success: passed, causes: {}, ...extra });

test('settings: defaults, overrides, bad values named', () => {
  assert.deepStrictEqual(ProcLoop.settings({}), { ...ProcLoop.DEFAULTS, problems: [] });
  const s = ProcLoop.settings({ improve: { procedures: { minUses: 3, proven: 0.9 } } });
  assert.strictEqual(s.minUses, 3); assert.strictEqual(s.proven, 0.9); assert.strictEqual(s.struggling, 0.4);
  const bad = ProcLoop.settings({ improve: { procedures: { minUses: 0, proven: 2, struggling: 'x' } } });
  assert.strictEqual(bad.problems.length, 3);
  assert.strictEqual(bad.minUses, 5);
  assert.strictEqual(ProcLoop.settings({ improve: { procedures: { proven: 0.3, struggling: 0.5 } } }).proven, 0.8);
});

test('review judges the version in the file now', () => {
  const proven = file('p-proven', 'bound'), weak = file('p-weak', 'bound'), mixed = file('p-mixed', 'bound');
  const fresh = file('p-new', 'bound', 2), draft = file('p-draft', 'minted'), old = file('p-old', 'retired');
  const stats = [
    stat(proven, 5, 5), stat(weak, 6, 2), stat(mixed, 5, 3), stat(fresh, 1, 1),
    { id: 'p-new', version: '1', hash: '0123456789abcdef', uses: 8, passed: 2, failed: 6, success: 2, causes: { stalled: 6 } },
    { id: 'prompt:builder', version: '3', hash: 'sha256:aa', uses: 9, passed: 9, failed: 0, success: 9, causes: {} },
  ];
  const r = ProcLoop.review({ procedures: [proven, weak, mixed, fresh, draft, old, { rec: { id: 'p-bad', status: 'bound' }, path: 'procedures/p-bad.yaml', text: '' }], stats, settings: ProcLoop.settings({}) });
  const j = Object.fromEntries(r.rows.map(x => [x.id, [x.judgement, x.action]]));
  assert.deepStrictEqual(j, {
    'p-draft': ['proposed', 'bind'], 'p-mixed': ['mixed', null], 'p-new': ['untested', null], 'p-old': ['retired', null],
    'p-proven': ['proven', null], 'p-weak': ['struggling', 'retire'],
  });
  const n = r.rows.find(x => x.id === 'p-new');
  assert.strictEqual(n.uses, 1);
  assert.deepStrictEqual(n.older.map(o => [o.version, o.uses, o.rate]), [['1', 8, 0.25]]);
  assert.match(r.rows.find(x => x.id === 'p-weak').reason, /passed 2 of 6 tasks it was given in/);
  assert.deepStrictEqual(r.external.map(x => x.id), ['prompt:builder'], 'a pipeline entry is judged as external');
  assert.strictEqual(r.ignored, 0);
  assert.deepStrictEqual(r.invalid.map(x => x.id), ['p-bad']);
});

test('external procedures (prompt:, policy:, target:policy): grouped by id, the latest hash is current, no bind or retire', () => {
  const st = (id, version, hash, uses, passed, last) => ({ id, version, hash, uses, passed, failed: uses - passed, success: passed, causes: {}, last });
  const stats = [
    st('prompt:builder', '3', 'sha256:old', 6, 6, 4),
    st('prompt:builder', '3', 'sha256:new', 5, 1, 9),
    st('policy:review', '1', 'sha256:p', 5, 5, 7),
    st('target:policy', '2', 'sha256:t', 2, 2, 8),
    st('orphan', '1', 'abc', 3, 3, 1),
  ];
  const r = ProcLoop.review({ procedures: [], stats, settings: ProcLoop.settings({}) });
  const j = Object.fromEntries(r.external.map(x => [x.id, [x.hash, x.judgement, x.action]]));
  assert.deepStrictEqual(j, {
    'policy:review': ['sha256:p', 'proven', null],
    'prompt:builder': ['sha256:new', 'struggling', 'propose'],
    'target:policy': ['sha256:t', 'untested', null],
  });
  const b = r.external.find(x => x.id === 'prompt:builder');
  assert.deepStrictEqual(b.older.map(o => [o.hash, o.rate]), [['sha256:old', 1]], 'same declared version, new hash: a new version');
  assert.match(b.source, /prompts\/builder\.md/);
  assert.match(b.reason, /propose a change in the pipeline's repository/);
  assert.match(r.external.find(x => x.id === 'target:policy').source, /\.factory\/policy\.yaml/);
  assert.strictEqual(r.ignored, 1, 'an id with no colon and no file is still not judged');
});

test('procedureStats: last is the newest episode that named the version', () => {
  const ep = (run, hash, outcome = 'passed') => ({ run, task: 'T', final: true, outcome, success: outcome === 'passed', cause: null, procedures: [{ id: 'prompt:x', version: '1', hash }] });
  const s = Memory.procedureStats([ep('R1', 'a'), ep('R2', 'b'), ep('R3', 'a')]);
  assert.deepStrictEqual(s.map(x => [x.hash, x.last]), [['a', 2], ['b', 1]]);
});

test('setStatus changes only the one top-level status line', () => {
  assert.strictEqual(ProcLoop.setStatus('id: p\nstatus: bound\nsteps:\n  - status: x\n', 'retired'), 'id: p\nstatus: retired\nsteps:\n  - status: x\n');
  assert.strictEqual(ProcLoop.setStatus('id: p\n', 'bound'), null);
  assert.strictEqual(ProcLoop.setStatus('status: a\nstatus: b\n', 'bound'), null);
});

test('fixture registry and CLI review', async () => {
  const Headless = require('../headless/index.js');
  const reg = Headless.open(REG);
  const r = Headless.procedureReview(reg);
  assert.deepStrictEqual(r.rows.map(x => `${x.id}:${x.judgement}`), ['change-ui-list:untested', 'draft-api-paging:proposed']);
  assert.deepStrictEqual(r.rows[0].older.map(o => o.version), ['1']);
  const { main } = require('../scripts/designc-core.js');
  const out = [];
  const code = await main(['procedures', '--registry', REG, '--json'], { log: s => out.push(s), err: () => {} });
  assert.strictEqual(code, 0);
  assert.deepStrictEqual(JSON.parse(out.join('\n')).review.rows.map(x => x.judgement), ['untested', 'proposed']);
  out.length = 0;
  await main(['procedures', '--registry', REG], { log: s => out.push(s), err: () => {} });
  assert.match(out.join('\n'), /change-ui-list v2: untested, given in 1 finished task on this version/);
});
