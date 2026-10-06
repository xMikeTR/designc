#!/usr/bin/env node
// A scripted eval harness: prints the factory events of two suite runs as JSON lines for `designc record`.
//   node dev/mock-suite-run.js | (cd python && python3 -m designc record ../fixtures/factory-registry --by mock-harness)
// Run 1 (harness v1) has finished, with agent failures and one harness failure; run 2 (harness v2) has finished better;
// run 3 repeats harness v2 with S2-0003 edited (a new hash, so it is not compared) and is still running.
// Timestamps and event ids are fixed so the fixture ledger is the same every time it is regenerated.
const T0 = Date.UTC(2026, 9, 5, 9, 0, 0);
let n = 0;
const out = [];
const emit = ev => out.push({ ...ev, event_id: `mock-${String(++n).padStart(3, '0')}`, ts: T0 + n * 60000 });

// Each eval task pins the hash of its file in fixtures/factory-registry/factory/tasks/, as the real harness would,
// so Improve's Eval tasks can tell a run that used another definition.
const fs = require('fs'), path = require('path');
const Core = require('../renderer/core.js');
const taskHash = id => Core.evalHash({ _text: fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'factory-registry', 'factory', 'tasks', `${id}.yaml`), 'utf8') });
const TASKS = {
  'S2-0001': { hash: taskHash('S2-0001'), gates: ['build', 'tests', 'decision_checks', 'scope'], gradients: ['judge:test-gaming'] },
  'S2-0002': { hash: taskHash('S2-0002'), gates: ['build', 'tests', 'scope'] },
  'S2-0003': { hash: taskHash('S2-0003'), gates: ['build', 'tests'], gradients: ['judge:test-gaming'] },
};

function suite(id, harness_version, prompt_version, results, finish, edits = {}) {
  emit({ kind: 'suite_run', suite_run_id: id, suite: 's2-regression', harness_version, model: 'claude-sonnet-5-5', prompt_version, trials: 3, configurator: 'laya', tasks: { ...TASKS, ...edits } });
  for (const [task_id, trials] of Object.entries(results)) {
    trials.forEach((verdicts, i) => {
      for (const [grader, verdict] of Object.entries(verdicts)) {
        emit({ kind: 'grader', suite_run_id: id, task_id, trial: i + 1, grader, verdict, trace_id: `lf-${id}-${task_id}-${i + 1}`, ...(verdict === 'fail' ? { reason: `${grader} failed` } : {}) });
      }
    });
  }
  if (finish) emit({ kind: 'suite_run_finished', suite_run_id: id, ...finish });
}

const ok = { build: 'pass', tests: 'pass', decision_checks: 'pass', scope: 'pass' };
suite('run-2026-10-05-a', '4f2a9e1', 'executor-v7', {
  'S2-0001': [{ ...ok, 'judge:test-gaming': 'pass' }, { ...ok, scope: 'fail' }, { ...ok, 'judge:test-gaming': 'fail' }],
  'S2-0002': [{ build: 'pass', tests: 'pass', scope: 'pass' }, { build: 'pass', tests: 'fail', scope: 'pass' }, { build: 'pass', tests: 'pass', scope: 'pass' }],
  'S2-0003': [{ build: 'pass', tests: 'pass' }, { build: 'pass', tests: 'pass', 'judge:test-gaming': 'unknown' }, { build: 'pass' }],
}, { outcome: 'completed' });
suite('run-2026-10-05-b', '8d0c3b2', 'executor-v8', {
  'S2-0001': [{ ...ok, 'judge:test-gaming': 'pass' }, { ...ok }, { ...ok, scope: 'fail' }],
  'S2-0002': [{ build: 'pass', tests: 'pass', scope: 'pass' }, { build: 'pass', tests: 'pass', scope: 'pass' }, { build: 'pass', tests: 'pass', scope: 'pass' }],
  'S2-0003': [{ build: 'pass', tests: 'pass' }, { build: 'pass', tests: 'fail' }, { build: 'pass', tests: 'pass' }],
}, { outcome: 'completed' });
suite('run-2026-10-05-c', '8d0c3b2', 'executor-v8', {
  'S2-0001': [{ ...ok }, { ...ok }],
  'S2-0002': [{ build: 'pass', tests: 'pass', scope: 'pass' }],
}, null, { 'S2-0003': { ...TASKS['S2-0003'], hash: 'd51f0e7a2c9b8346' } });

process.stdout.write(out.map(e => JSON.stringify(e)).join('\n') + '\n');
