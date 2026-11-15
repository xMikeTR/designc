// ui_result (D5 slice 1): a Factory kind judged like parity_result, and `done_when: ui: <screen>`.
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
const EV = { kind: 'ui_result', by: 'factory', screen: 'bordereaux', commit: C1, outcome: 'pass' };

test('ledger: ui_result needs screen, commit and outcome; it is a pipeline kind', () => {
  assert.deepEqual(Ledger.validate(EV), []);
  assert.deepEqual(Ledger.validate({ ...EV, item: 'W-ui', commit: null, outcome: 'could_not_run' }), []);
  for (const k of ['screen', 'commit', 'outcome']) {
    const { [k]: _, ...rest } = EV;
    assert.ok(Ledger.validate(rest).some(e => e.includes(k)), k);
  }
  assert.ok(Ledger.validate({ ...EV, outcome: 'flaky' }).some(e => /outcome/.test(e)));
  assert.equal(Ledger.KINDS.ui_result.stream, 'pipeline.jsonl');
  assert.ok(Ledger.PIPELINE_KINDS.includes('ui_result'));
});

const record = (root, ev) => spawnSync('python3', ['-m', 'designc', 'record', root, '--by', 'factory'], { cwd: PY, input: JSON.stringify(ev) + '\n', encoding: 'utf8' });

test('designc record accepts ui_result and writes it to pipeline.jsonl', { skip }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'designc-uires-'));
  try {
    const r = record(root, EV);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const rows = fs.readFileSync(path.join(root, 'ledger', 'pipeline.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
    assert.deepEqual(rows.map(x => [x.kind, x.screen, x.outcome]), [['ui_result', 'bordereaux', 'pass']]);
    assert.equal(record(root, { ...EV, outcome: 'flaky' }).status, 1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

const item = (ui = 'bordereaux') => ({ id: 'W-ui', requirement: 'DEMO-1', elements: ['Fares API'], done_when: [{ gate: 'npm test' }, { ui }] });
const ctx = { requirements: [{ id: 'DEMO-1', elements: ['Fares API'] }], items: [], screens: ['bordereaux'] };

test('validate: ui only on a repo item and only for a screen that has a spec', () => {
  assert.deepEqual(Work.validate(item(), ctx), []);
  assert.deepEqual(Work.validate(item('nope'), ctx), ['W-ui: done_when entry 2 names ui screen nope, which has no spec in ui/specs/.']);
  assert.deepEqual(Work.validate(item('nope'), { ...ctx, screens: null }), [], 'screens unknown: not judged');
  const target = Work.validate({ id: 'W-t', target: { jira: 'X-1' }, done_when: [{ checklist: 'a' }, { ui: 'bordereaux' }] }, ctx);
  assert.deepEqual(target, ['W-t: done_when entry 2 (ui) is allowed only on a repo item: ui is judged at the commit that finished it.']);
});

const gate = { kind: 'item_gate', item: 'W-ui', gate: 'npm test', outcome: 'pass', commit: C1, dirty: false, _ts: 1 };
const res = (outcome, o = {}) => ({ kind: 'ui_result', screen: 'bordereaux', commit: C1, outcome, _ts: 10, ...o });
const done = (events, it = item()) => Work.doneProblems(it, { events: [gate, ...events], commit: C1, onMain: true });

test('the latest ui_result at the done commit decides; could_not_run is not met', () => {
  assert.deepEqual(done([res('pass')]), []);
  assert.deepEqual(done([]), [`UI bordereaux has no result at 3f2a9c1. Run the Factory's ui check for it and record ui_result for ${C1}.`]);
  assert.match(done([res('fail')])[0], /^UI bordereaux failed at 3f2a9c1/);
  assert.match(done([res('could_not_run')])[0], /^UI bordereaux could not run at 3f2a9c1/);
  assert.deepEqual(done([res('fail', { _ts: 5 }), res('pass', { _ts: 6 })]), []);
  assert.match(done([res('pass', { _ts: 5 }), res('fail', { _ts: 6 })])[0], /failed/);
  assert.match(done([res('pass', { commit: C2 })])[0], /no result at 3f2a9c1/, 'another commit does not count');
  assert.match(done([res('pass', { screen: 'other' })])[0], /no result/, 'another screen does not count');
  assert.deepEqual(done([res('pass', { _ts: 5 }), res('flaky', { _ts: 6 })]), [], 'unknown outcome ignored');
  const late = [{ kind: 'item_done', item: 'W-ui', commit: C1, _ts: 8 }, res('pass', { _ts: 9 })];
  assert.match(done(late)[0], /no result/, 'recorded after done does not count');
});

test('the Python work report validates ui entries the same way', { skip }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'designc-uiwork-'));
  try {
    const put = (rel, text) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); };
    put('requirements/DEMO-1.yaml', 'id: DEMO-1\ntitle: t\nversion: 1\nelements: [Fares API]\n');
    put('ui/specs/bordereaux.json', '{}');
    const files = { ok: 'id: ok\nrequirement: DEMO-1\nelements: [Fares API]\ndone_when:\n  - gate: x\n  - ui: bordereaux\n', bad: 'id: bad\nrequirement: DEMO-1\nelements: [Fares API]\ndone_when:\n  - gate: x\n  - ui: nope\n', tgt: 'id: tgt\ntarget: { jira: X-1 }\ndone_when:\n  - checklist: a\n  - ui: bordereaux\n' };
    for (const [n, t] of Object.entries(files)) put(`work/${n}.yaml`, t);
    const r = spawnSync('python3', ['-m', 'designc', 'work', root, '--json'], { cwd: PY, encoding: 'utf8' });
    const py = JSON.parse(r.stdout);
    for (const [n, t] of Object.entries(files)) {
      const it = yaml.load(t);
      assert.deepEqual(py.items.find(x => x.id === n).problems, Work.validate(it, { ...ctx, items: [] }), n);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
