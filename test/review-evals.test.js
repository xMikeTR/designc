// Error analysis, slice 3: a failure mode becomes an eval. Failed reviews in the mode are a judge's positive examples
// and reviewed passes its negatives; the Analyst drafts a minted eval task traced to the attempts it came from.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const yaml = require('js-yaml');
const Ledger = require('../renderer/ledger.js');

let t = 0;
const ev = (kind, f) => ({ kind, by: 'mike', event_id: `e${++t}`, _ts: t, ...f });
const review = (observation, verdict, note, failure_mode, extra = {}) => ev('trace_review', { trace_id: 'tr-' + observation, observation, verdict, note, task: 'T-' + observation, ...(failure_mode !== undefined ? { failure_mode } : {}), ...extra });
const taxonomy = { modes: [{ id: 'FM-01', name: 'Blind retry', triage: 'fix' }, { id: 'FM-02', name: 'Spec gap' }] };
const events = [
  ev('handover', { handover: '20261016-9de366a9', revision: 'r-1', commit: '76ba6ff' }),
  ev('run_started', { run: 'r1', handover: '20261016-9de366a9' }),
  review('a', 'fail', 'same patch three times', 'FM-01', { run_id: 'r1', attempt: 2 }),
  review('b', 'fail', 'again', 'FM-01'),
  review('c', 'fail', 'missing field', 'FM-02'),
  review('d', 'pass', ''),
  review('e', 'fail', 'later passed'), review('e', 'pass', 'fine on second look'),
];

test('judgeExamples: the mode\'s failed reviews are positives, reviewed passes negatives, as JSON lines', () => {
  const r = Ledger.judgeExamples(events, 'FM-01');
  assert.deepEqual(r.positives.map(x => x.observation), ['a', 'b']);
  assert.deepEqual(r.negatives.map(x => x.observation), ['d', 'e']);
  const lines = r.jsonl.trim().split('\n').map(JSON.parse);
  assert.deepEqual(lines[0], { trace_id: 'tr-a', observation: 'a', task: 'T-a', run_id: 'r1', attempt: 2, label: 'fail', failure_mode: 'FM-01', note: 'same patch three times' });
  assert.deepEqual(lines.map(l => l.label), ['fail', 'fail', 'pass', 'pass']);
});

test('evalTaskDraft: a minted task whose source names the mode and the attempts, with the handover and commit of the run', () => {
  const r = Ledger.evalTaskDraft(events, taxonomy, { failure_mode: 'FM-01', title: 'Does not retry the same patch', observations: ['a', 'b'], why: 'seen twice' }, { taken: [] });
  assert.equal(r.error, undefined);
  assert.equal(r.path, `factory/tasks/${r.id}.yaml`);
  const o = yaml.load(r.text);
  assert.equal(o.status, 'minted');
  assert.equal(o.source.failure_mode, 'FM-01');
  assert.deepEqual(o.source.traces, [{ trace_id: 'tr-a', observation: 'a', task: 'T-a' }, { trace_id: 'tr-b', observation: 'b', task: 'T-b' }]);
  assert.deepEqual(o.input, { handover: '20261016-9de366a9', commit: '76ba6ff' });
  assert.equal(Ledger.taskBindProblem(o), null, "bindable: it names its failure mode");
});

test('evalTaskDraft: refuses an unknown mode, a blank title, and an observation that is not a failed review in that mode', () => {
  const bad = a => Ledger.evalTaskDraft(events, taxonomy, { why: 'x', ...a }, { taken: [] }).error;
  assert.ok(bad({ failure_mode: 'FM-09', title: 'x', observations: ['a'] }));
  assert.ok(bad({ failure_mode: 'FM-01', title: ' ', observations: ['a'] }));
  assert.ok(bad({ failure_mode: 'FM-01', title: 'x', observations: ['c'] }), 'another mode');
  assert.ok(bad({ failure_mode: 'FM-01', title: 'x', observations: ['d'] }), 'a pass');
  assert.ok(bad({ failure_mode: 'FM-01', title: 'x', observations: [] }));
  const noRun = Ledger.evalTaskDraft(events, taxonomy, { failure_mode: 'FM-01', title: 'x', observations: ['b'], why: 'y' }, { taken: [] });
  assert.equal(yaml.load(noRun.text).input, undefined, 'no run known: no input guessed');
});
