// feature_result (S12b): a Factory kind judged like ui_result, and `done_when: feature: <id>`.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const yaml = require('js-yaml');
const { spawnSync } = require('child_process');
const Ledger = require('../renderer/ledger.js');
const Work = require('../renderer/work.js');

const PY = path.join(__dirname, '..', 'python');
const skip = spawnSync('python3', ['-c', 'import yaml']).status === 0 ? false : 'python3 with PyYAML is not installed';
const C1 = '3f2a9c1d5e7b8a0c4d6e8f0a1b2c3d4e5f6a7b8c';
const C2 = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const J = (o = {}) => ({ journey: 'j1', entry: 'menu', outcome: 'pass', ...o });
const F = { step: 0, kind: 'step', msg: 'x' };
const EV = { kind: 'feature_result', by: 'factory', feature: 'submit', commit: C1, outcome: 'pass', journeys: [J()] };
const rows = fs.readFileSync(path.join(__dirname, '..', 'docs', 'feature-result.example.json'), 'utf8').trim().split('\n').map(l => JSON.parse(l));

// [label, row, expected message]
const BAD = [
  ['empty journeys', { ...EV, journeys: [] }, 'journeys: name at least one journey'],
  ['journey not an object', { ...EV, journeys: ['x'] }, 'journeys[0]: must be {journey, entry, outcome}'],
  ['journey missing name', { ...EV, journeys: [J({ journey: 5 })] }, 'journeys[0]: must be {journey, entry, outcome}'],
  ['journey bad outcome', { ...EV, journeys: [J({ outcome: 'flaky' })] }, 'journeys[0].outcome: must be pass, fail or could_not_run'],
  ['entry not string', { ...EV, journeys: [J({ entry: 3 })] }, 'journeys[0]: must be {journey, entry, outcome}'],
  ['failures not array', { ...EV, journeys: [J({ failures: 'x' })] }, 'journeys[0].failures: must be a list'],
  ['bad failure kind', { ...EV, outcome: 'fail', journeys: [J({ outcome: 'fail', failures: [{ ...F, kind: 'boom' }] })] }, 'journeys[0].failures[0]: must be {step, kind, msg}'],
  ['negative step', { ...EV, outcome: 'fail', journeys: [J({ outcome: 'fail', failures: [{ ...F, step: -1 }] })] }, 'journeys[0].failures[0]: must be {step, kind, msg}'],
  ['51 failures', { ...EV, outcome: 'fail', journeys: [J({ outcome: 'fail', failures: Array(51).fill(F) })] }, 'journeys[0].failures: at most 50 (the report holds the rest)'],
  ['fail without failures', { ...EV, outcome: 'fail', journeys: [J({ outcome: 'fail' })] }, "journeys[0].failures: name at least one when the journey outcome is 'fail'"],
  ['row pass but journey failed', { ...EV, journeys: [J({ outcome: 'fail', failures: [F] })] }, "outcome: must be 'fail' when a journey failed"],
  ['row fail but all pass', { ...EV, outcome: 'fail' }, "outcome: must be 'pass' when every journey passed"],
  ['row pass but one could not run', { ...EV, journeys: [J({ outcome: 'could_not_run' })] }, "outcome: must be 'could_not_run' when a journey could not run and none failed"],
];

test('ledger: feature_result example rows are valid; it is a pipeline kind', () => {
  assert.equal(rows.length, 2);
  for (const r of rows) assert.deepEqual(Ledger.validate(r), []);
  assert.deepEqual(Ledger.validate({ ...EV, item: 'W-f', commit: null, outcome: 'could_not_run', journeys: [J({ outcome: 'could_not_run' })] }), []);
  assert.equal(Ledger.KINDS.feature_result.stream, 'pipeline.jsonl');
  assert.ok(Ledger.PIPELINE_KINDS.includes('feature_result'));
});

test('ledger: feature_result needs feature, commit, outcome and journeys', () => {
  for (const k of ['feature', 'commit', 'outcome', 'journeys']) {
    const { [k]: _, ...rest } = EV;
    assert.ok(Ledger.validate(rest).some(e => e.includes(k)), k);
  }
  assert.ok(Ledger.validate({ ...EV, outcome: 'flaky' }).some(e => /outcome/.test(e)));
});

test('ledger: each journeys_shape error', () => {
  for (const [label, row, msg] of BAD) {
    const errs = Ledger.validate(row);
    assert.ok(errs.some(e => e.includes(msg)), `${label}: ${JSON.stringify(errs)}`);
  }
});

test('V9: a feature_result in pipeline.jsonl is accepted', () => {
  const line = JSON.stringify({ ...EV, schema_version: Ledger.SCHEMA_VERSION, ts: 1, event_id: 'e1' });
  const r = Ledger.verify([{ path: 'ledger/pipeline.jsonl', text: line + '\n' }]);
  assert.deepEqual(r.errors.filter(e => e.rule === 'V9'), []);
  const bad = Ledger.verify([{ path: 'ledger/pipeline.jsonl', text: JSON.stringify({ ...EV, kind: 'feature_resultx', schema_version: Ledger.SCHEMA_VERSION, ts: 1 }) + '\n' }]);
  assert.equal(bad.errors.filter(e => e.rule === 'V9').length, 1);
});

const pyValidate = rowsIn => {
  const r = spawnSync('python3', ['-c', 'import sys,json\nfrom designc import ledger\nprint(json.dumps([ledger.validate(e) for e in json.load(sys.stdin)]))'], { cwd: PY, input: JSON.stringify(rowsIn), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
};

test('Python ledger.validate gives the same errors as Ledger.validate', { skip }, () => {
  const all = [...rows, EV, ...BAD.map(b => b[1]), (({ journeys, ...r }) => r)(EV)];
  const py = pyValidate(all);
  all.forEach((r, i) => assert.deepEqual(py[i], Ledger.validate(r), `row ${i}`));
});

test('designc record accepts feature_result', { skip }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'designc-featres-'));
  try {
    const rec = ev => spawnSync('python3', ['-m', 'designc', 'record', root, '--by', 'factory'], { cwd: PY, input: JSON.stringify(ev) + '\n', encoding: 'utf8' });
    const r = rec(EV);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const out = fs.readFileSync(path.join(root, 'ledger', 'pipeline.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
    assert.deepEqual(out.map(x => [x.kind, x.feature, x.outcome]), [['feature_result', 'submit', 'pass']]);
    assert.equal(rec({ ...EV, outcome: 'fail' }).status, 1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

const item = (feature = 'submit') => ({ id: 'W-f', requirement: 'DEMO-1', elements: ['Fares API'], done_when: [{ gate: 'npm test' }, { feature }] });
const ctx = { requirements: [{ id: 'DEMO-1', elements: ['Fares API'] }], items: [], features: ['submit'] };

test('validate: feature only on a repo item and only for a known feature id', () => {
  assert.deepEqual(Work.validate(item(), ctx), []);
  assert.deepEqual(Work.validate(item('nope'), ctx), ['W-f: done_when entry 2 names feature nope, which is not in features/.']);
  assert.deepEqual(Work.validate(item('nope'), { ...ctx, features: null }), [], 'features unknown: not judged');
  assert.deepEqual(Work.validate(item('nope'), { requirements: ctx.requirements, items: [] }), [], 'features omitted: not judged');
  const target = Work.validate({ id: 'W-t', target: { jira: 'X-1' }, done_when: [{ checklist: 'a' }, { feature: 'submit' }] }, ctx);
  assert.deepEqual(target, ['W-t: done_when entry 2 (feature) is allowed only on a repo item: feature is judged at the commit that finished it.']);
  const noGate = Work.validate({ ...item(), done_when: [{ feature: 'submit' }] }, ctx);
  assert.ok(noGate.some(m => /needs a gate/.test(m)), 'feature is not a gate');
  assert.ok(Work.validate({ ...item(), done_when: [{ gate: 'x' }, { nope: 1 }] }, ctx)[0].endsWith('use gate, checklist, review, judge, parity, ui or feature.'));
  assert.ok(Work.validate({ ...item(), done_when: [{ gate: 'x' }, { ui: 'a', feature: 'b' }] }, ctx)[0].endsWith('exactly one of gate, checklist, review, judge, parity, ui or feature.'));
});

const gate = { kind: 'item_gate', item: 'W-f', gate: 'npm test', outcome: 'pass', commit: C1, dirty: false, _ts: 1 };
const res = (outcome, o = {}) => ({ kind: 'feature_result', feature: 'submit', commit: C1, outcome, journeys: [], _ts: 10, ...o });
const done = (events, it = item()) => Work.doneProblems(it, { events: [gate, ...events], commit: C1, onMain: true });

test('the latest feature_result at the done commit decides; could_not_run is not met', () => {
  assert.deepEqual(done([res('pass')]), []);
  assert.deepEqual(done([]), [`Feature submit has no result at 3f2a9c1. Run its journeys (the Factory's features runner) and record feature_result for ${C1}.`]);
  const bad = [J({ outcome: 'fail', failures: [F] }), J({ entry: 'b', outcome: 'fail', failures: [F] }), J({ entry: 'c' })];
  assert.equal(done([res('fail', { journeys: bad })])[0], 'Feature submit failed at 3f2a9c1 (2 journey runs failed). Fix the app; never edit a journey to make it pass.');
  assert.equal(done([res('fail', { journeys: [bad[0]] })])[0], 'Feature submit failed at 3f2a9c1 (1 journey run failed). Fix the app; never edit a journey to make it pass.');
  assert.equal(done([res('could_not_run')])[0], 'Feature submit could not run at 3f2a9c1. Fix what stopped it (the ready check, data or params) and run it again.');
  assert.deepEqual(done([res('fail', { _ts: 5 }), res('pass', { _ts: 6 })]), []);
  assert.match(done([res('pass', { _ts: 5 }), res('fail', { _ts: 6 })])[0], /failed/);
  assert.match(done([res('pass', { commit: C2 })])[0], /no result at 3f2a9c1/, 'another commit does not count');
  assert.match(done([res('pass', { feature: 'other' })])[0], /no result/, 'another feature does not count');
  const late = [{ kind: 'item_done', item: 'W-f', commit: C1, _ts: 8 }, res('pass', { _ts: 9 })];
  assert.match(done(late)[0], /no result/, 'recorded after done does not count');
});

test('the Python work report validates feature entries the same way', { skip }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'designc-featwork-'));
  try {
    const put = (rel, text) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); };
    put('requirements/DEMO-1.yaml', 'id: DEMO-1\ntitle: t\nversion: 1\nelements: [Fares API]\n');
    put('features/submit.yaml', 'id: submit\n');
    const files = { ok: 'id: ok\nrequirement: DEMO-1\nelements: [Fares API]\ndone_when:\n  - gate: x\n  - feature: submit\n', bad: 'id: bad\nrequirement: DEMO-1\nelements: [Fares API]\ndone_when:\n  - gate: x\n  - feature: nope\n', tgt: 'id: tgt\ntarget: { jira: X-1 }\ndone_when:\n  - checklist: a\n  - feature: submit\n', nog: 'id: nog\nrequirement: DEMO-1\nelements: [Fares API]\ndone_when:\n  - feature: submit\n', unk: 'id: unk\nrequirement: DEMO-1\nelements: [Fares API]\ndone_when:\n  - gate: x\n  - zzz: 1\n' };
    for (const [n, t] of Object.entries(files)) put(`work/${n}.yaml`, t);
    const r = spawnSync('python3', ['-m', 'designc', 'work', root, '--json'], { cwd: PY, encoding: 'utf8' });
    const py = JSON.parse(r.stdout);
    for (const [n, t] of Object.entries(files)) {
      assert.deepEqual(py.items.find(x => x.id === n).problems, Work.validate(yaml.load(t), { ...ctx, items: [] }), n);
    }
    assert.deepEqual(py.items.find(x => x.id === 'bad').problems, ['bad: done_when entry 2 names feature nope, which is not in features/.']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
