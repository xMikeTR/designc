'use strict';
// A task row may carry `usage`: what each model it used cost, so Build shows the split (planning on one model,
// coding on another) and Ledger.usageByTier totals it for metrics. Any pipeline: tier is the pipeline's own word.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');
const Ledger = require('../renderer/ledger.js');

const PY = path.join(__dirname, '..', 'python');
const skipPy = spawnSync('python3', ['-c', 'import yaml']).status === 0 ? false : 'python3 with PyYAML is not installed';
const H = '20261016-9de366a9';
const ev = (kind, ts, f) => ({ kind, by: 'some-pipeline', _ts: ts, ...f });
const plan = { tier: 'frontier', model: 'big-model', turns: 1, tokens_in: 80000, tokens_out: 4000 };
const act = { tier: 'standard', model: 'mid-model', turns: 2, tokens_in: 130000, tokens_out: 4000, cost: 0.4 };
const task = { kind: 'task', by: 'p', task: 'T-3', status: 'running', usage: [plan, act] };

const bad = [
  [{ ...task, usage: {} }, /task\.usage: must be a list of \{model, turns, tokens_in, tokens_out\}/],
  [{ ...task, usage: [{ ...plan, model: '' }] }, /task\.usage\[0\]\.model: must be a non-empty string/],
  [{ ...task, usage: [plan, { ...act, turns: 1.5 }] }, /task\.usage\[1\]\.turns: must be a whole number of at least 0/],
  [{ ...task, usage: [{ ...plan, tokens_out: undefined }] }, /task\.usage\[0\]\.tokens_out: must be a whole number of at least 0/],
  [{ ...task, usage: [{ ...plan, tier: 3 }] }, /task\.usage\[0\]\.tier: must be a string/],
  [{ ...task, usage: [{ ...plan, cost: 'cheap' }] }, /task\.usage\[0\]\.cost: must be a number/],
  [{ ...task, usage: [{ ...plan, cache_read: -1 }] }, /task\.usage\[0\]\.cache_read: must be a whole number of at least 0/],
  [{ ...task, usage: [{ ...plan, cache_write: 2.5 }] }, /task\.usage\[0\]\.cache_write: must be a whole number of at least 0/],
  [{ ...task, usage: [{ ...plan, cache_read: 70000, cache_write: 20000 }] }, /task\.usage\[0\]: cache_read and cache_write are part of tokens_in, so together at most tokens_in/],
];

test('usage is optional on a task, a list of model entries with whole-number turns and tokens', () => {
  assert.deepEqual(Ledger.validate({ ...task, usage: undefined }), []);
  assert.deepEqual(Ledger.validate(task), []);
  assert.deepEqual(Ledger.validate({ ...task, usage: [] }), []);
  assert.deepEqual(Ledger.validate({ ...task, usage: [{ ...plan, cache_read: 60000, cache_write: 20000 }] }), []);
  for (const [e, re] of bad) assert.ok(Ledger.validate(e).some(x => re.test(x)), `${re} in ${Ledger.validate(e)}`);
});

test('python validates usage with the same errors', { skip: skipPy }, () => {
  for (const e of [task, { ...task, usage: [{ ...plan, cache_read: 60000, cache_write: 0 }] }, ...bad.map(b => b[0])]) {
    const clean = JSON.parse(JSON.stringify(e));
    const r = spawnSync('python3', ['-c', 'import json,sys; from designc.ledger import validate; print(json.dumps(validate(json.loads(sys.argv[1]))))', JSON.stringify(clean)], { cwd: PY, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), Ledger.validate(clean));
  }
});

test('Build Runs: each task carries its usage, and the run totals it per tier', () => {
  const [run] = Ledger.liveRuns([
    ev('run_started', 100, { run: 'r1', handover: H }),
    ev('task', 110, { task: 'T-1', status: 'running', handover: H, run: 'r1', usage: [plan] }),
    ev('task', 120, { task: 'T-1', status: 'passed', handover: H, run: 'r1', usage: [plan, act] }),
    ev('task', 130, { task: 'T-2', status: 'running', handover: H, run: 'r1', usage: [{ ...plan, model: 'other-big', turns: 2, tokens_in: 10, tokens_out: 10 }] }),
    ev('task', 140, { task: 'T-3', status: 'running', handover: H, run: 'r1', tier: 'frontier' }),
  ], { now: 200 });
  assert.deepEqual(run.tasks.find(t => t.task === 'T-1').usage, [plan, act]);
  assert.equal(run.tasks.find(t => t.task === 'T-3').usage, null);
  assert.deepEqual(run.usage, [
    { tier: 'standard', models: ['mid-model'], turns: 2, tokens_in: 130000, tokens_out: 4000, tokens: 134000, cost: 0.4, cache_read: 0, cache_write: 0 },
    { tier: 'frontier', models: ['big-model', 'other-big'], turns: 3, tokens_in: 80010, tokens_out: 4010, tokens: 84020, cost: 0, cache_read: 0, cache_write: 0 },
  ]);
});

test('usageByTier totals the latest row per task and run, keyed by tier or else model, and counts rows with no usage', () => {
  const u = Ledger.usageByTier([
    ev('task', 1, { task: 'T-1', status: 'running', handover: H, run: 'r1', usage: [plan] }),
    ev('task', 2, { task: 'T-1', status: 'passed', handover: H, run: 'r1', usage: [plan, act] }),
    ev('task', 3, { task: 'T-2', status: 'passed', handover: H, usage: [{ model: 'small-model', turns: 1, tokens_in: 5, tokens_out: 5 }] }),
    ev('task', 4, { task: 'T-4', status: 'passed', handover: H, tokens: 99 }),
    ev('task', 5, { task: 'T-5', status: 'passed', handover: H, usage: [plan], sample: true }),
  ]);
  assert.deepEqual(u.tiers.map(t => [t.tier, t.turns, t.tokens]), [['standard', 2, 134000], ['frontier', 1, 84000], ['small-model', 1, 10]]);
  assert.equal(u.without, 1);
});

test('cache reads and writes, part of tokens_in, sum per tier; a tier with none reports 0', () => {
  const u = Ledger.usageByTier([
    ev('task', 1, { task: 'T-1', status: 'passed', handover: H, usage: [{ ...plan, cache_read: 60000, cache_write: 15000 }, act] }),
    ev('task', 2, { task: 'T-2', status: 'passed', handover: H, usage: [{ ...plan, cache_read: 1000 }] }),
  ]);
  assert.deepEqual(u.tiers.map(t => [t.tier, t.tokens_in, t.cache_read, t.cache_write]), [['frontier', 160000, 61000, 15000], ['standard', 130000, 0, 0]]);
});
