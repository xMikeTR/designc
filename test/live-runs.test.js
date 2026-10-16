'use strict';
// run_started / run_ended: a pipeline says a build of a handover started and how it ended; Ledger.liveRuns
// folds them with the handover's task rows into what Build shows as Runs. Any pipeline: no names here.
const test = require('node:test');
const assert = require('node:assert/strict');
const Ledger = require('../renderer/ledger.js');

const H = '20261015-65fa159e';
const ev = (kind, ts, f) => ({ kind, by: 'some-pipeline', _ts: ts, ...f });

test('run_started and run_ended are pipeline kinds in pipeline.jsonl', () => {
  for (const k of ['run_started', 'run_ended']) {
    assert.ok(Ledger.PIPELINE_KINDS.includes(k), k);
    assert.equal(Ledger.KINDS[k].stream, 'pipeline.jsonl');
  }
});

test('run_started needs run and handover', () => {
  assert.deepEqual(Ledger.validate({ kind: 'run_started', by: 'p', run: 'r1', handover: H }), []);
  assert.ok(Ledger.validate({ kind: 'run_started', by: 'p', run: 'r1' }).some(e => /handover/.test(e)));
});

test('run_ended status is succeeded, failed, parked or cancelled, and only succeeded may leave out the reason', () => {
  const e = { kind: 'run_ended', by: 'p', run: 'r1', handover: H, status: 'succeeded' };
  assert.deepEqual(Ledger.validate(e), []);
  assert.deepEqual(Ledger.validate({ ...e, status: 'failed', reason: 'credit balance is too low' }), []);
  assert.ok(Ledger.validate({ ...e, status: 'failed' }).some(x => /run_ended\.reason: required when status is not 'succeeded'/.test(x)));
  assert.ok(Ledger.validate({ ...e, status: 'merged' }).length > 0);
});

test('a started run with no end is running, with the latest status of each task of its handover since it started', () => {
  const runs = Ledger.liveRuns([
    ev('task', 50, { task: 'T-0', status: 'failed', handover: H }), // before the run: an earlier run's
    ev('run_started', 100, { run: 'r1', handover: H }),
    ev('task', 110, { task: 'T-1', status: 'running', handover: H, element: 'Sys/MCP server' }),
    ev('task', 120, { task: 'T-2', status: 'running', handover: H }),
    ev('task', 130, { task: 'T-1', status: 'passed', handover: H, element: 'Sys/MCP server' }),
    ev('task', 140, { task: 'T-9', status: 'running', handover: 'other' }),
  ], { now: 1100 });
  assert.equal(runs.length, 1);
  const r = runs[0];
  assert.equal(r.run, 'r1');
  assert.equal(r.status, 'running');
  assert.equal(r.ms, 1000);
  assert.deepEqual(r.tasks.map(t => [t.task, t.status]), [['T-1', 'passed'], ['T-2', 'running']]);
  assert.equal(r.tasks[0].element, 'Sys/MCP server');
});

test('an ended run keeps its status, reason and duration, and tasks after its end are not its', () => {
  const [r] = Ledger.liveRuns([
    ev('run_started', 100, { run: 'r1', handover: H }),
    ev('task', 110, { task: 'T-1', status: 'running', handover: H }),
    ev('run_ended', 400, { run: 'r1', handover: H, status: 'failed', reason: 'model call refused' }),
    ev('task', 500, { task: 'T-1', status: 'passed', handover: H }),
  ], { now: 9999 });
  assert.equal(r.status, 'failed');
  assert.equal(r.reason, 'model call refused');
  assert.equal(r.ms, 300);
  assert.deepEqual(r.tasks.map(t => t.status), ['stopped']);
});

test('runs are newest first; an end with no start still shows; a repeated start is ignored and the latest end wins', () => {
  const runs = Ledger.liveRuns([
    ev('run_started', 100, { run: 'a', handover: H }),
    ev('run_ended', 200, { run: 'a', handover: H, status: 'succeeded' }),
    ev('run_ended', 250, { run: 'a', handover: H, status: 'failed', reason: 'late' }),
    ev('run_started', 300, { run: 'b', handover: H }),
    ev('run_started', 350, { run: 'b', handover: 'x' }),
    ev('run_ended', 400, { run: 'c', handover: H, status: 'cancelled', reason: 'stopped' }),
  ], { now: 500 });
  assert.deepEqual(runs.map(r => [r.run, r.status]), [['c', 'cancelled'], ['b', 'running'], ['a', 'failed']]);
  assert.equal(runs.find(r => r.run === 'b').handover, H);
  assert.equal(runs.find(r => r.run === 'b').started, 300);
  assert.equal(runs.find(r => r.run === 'c').started, null);
});

test('a start after the end reopens the run (a parked run resumed), and it ends again later', () => {
  const events = [
    ev('run_started', 100, { run: 'r1', handover: H }),
    ev('run_ended', 200, { run: 'r1', handover: H, status: 'parked', reason: 'waiting on ND-0001' }),
    ev('run_started', 300, { run: 'r1', handover: H }),
  ];
  const [open] = Ledger.liveRuns(events, { now: 350 });
  assert.equal(open.status, 'running');
  assert.equal(open.reason, null);
  assert.equal(open.ended, null);
  assert.equal(open.started, 300);
  const [done] = Ledger.liveRuns([...events, ev('run_ended', 400, { run: 'r1', handover: H, status: 'succeeded' })], { now: 999 });
  assert.equal(done.status, 'succeeded');
  assert.equal(done.ms, 100);
});

test('a task row that names its run belongs to that run only, before or after a reopen', () => {
  const [r2, r1] = Ledger.liveRuns([
    ev('run_started', 100, { run: 'r1', handover: H }),
    ev('task', 110, { task: 'T-1', status: 'running', handover: H, run: 'r1' }),
    ev('run_ended', 200, { run: 'r1', handover: H, status: 'parked', reason: 'waiting' }),
    ev('run_started', 300, { run: 'r1', handover: H }),
    ev('run_started', 310, { run: 'r2', handover: H }),
    ev('task', 320, { task: 'T-2', status: 'running', handover: H, run: 'r1' }),
    ev('task', 330, { task: 'T-3', status: 'running', handover: H, run: 'r2' }),
  ], { now: 400 });
  assert.equal(r1.run, 'r1');
  assert.deepEqual(r1.tasks.map(t => t.task), ['T-1', 'T-2']);
  assert.deepEqual(r2.tasks.map(t => t.task), ['T-3']);
});

test('a task still running when its run ended is stopped, not running; a blocked task stays blocked', () => {
  const [r] = Ledger.liveRuns([
    ev('run_started', 100, { run: 'r1', handover: H }),
    ev('task', 110, { task: 'T-1', status: 'running', run: 'r1', handover: H }),
    ev('task', 120, { task: 'T-2', status: 'blocked', run: 'r1', handover: H }),
    ev('task', 130, { task: 'T-3', status: 'passed', run: 'r1', handover: H }),
    ev('run_ended', 400, { run: 'r1', handover: H, status: 'failed', reason: 'Waves failed: IOException: disk full' }),
  ], { now: 9999 });
  assert.deepEqual(r.tasks.map(t => [t.task, t.status]), [['T-1', 'stopped'], ['T-2', 'blocked'], ['T-3', 'passed']]);
});

test('a reopened run shows its tasks as running again', () => {
  const [r] = Ledger.liveRuns([
    ev('run_started', 100, { run: 'r1', handover: H }),
    ev('task', 110, { task: 'T-1', status: 'running', run: 'r1', handover: H }),
    ev('run_ended', 200, { run: 'r1', handover: H, status: 'parked', reason: 'waiting on ND-0001' }),
    ev('run_started', 300, { run: 'r1', handover: H }),
  ], { now: 400 });
  assert.deepEqual(r.tasks.map(t => t.status), ['running']);
});
