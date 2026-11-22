// L1 slice 1: renderer/problems.js is the Problems view's rows, shared by app.js renderPanel and the LSP; checkState takes an unsaved-text overlay.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Core = require('../renderer/core.js');
const Problems = require('../renderer/problems.js');
const Headless = require('../headless/index.js');
const { tmpRegistry } = require('./helpers/parity.js');

const ROOT = path.join(__dirname, '..');
const SAMPLE = path.join(ROOT, 'sample-registry');
const W = 'model/workspace.dsl';
const stateRows = s => Problems.rows({ model: s.model, diags: s.diags, cfgModel: s.cfg.model, decisions: s.assembled.gateInputs.decisions, yamlErrors: s.assembled.yamlErrors, ledgerErrors: s.assembled.ledgerErrors, proposals: s.assembled.proposals });
const flat = groups => groups.flatMap(([p, rs]) => rs.map(r => [p, r.line, r.sev, r.code]));

// The old inline block of app.js renderPanel (before L1), kept as the reference implementation.
function oldInline(A) {
  const live = A.diags.filter(d => !d.suppressed);
  const groups = [];
  const mrows = [...A.model.errors.map(e => ({ sev: 'error', msg: e.msg, code: 'parse', line: e.line, file: Core.locFile(e, A.cfg.model) })),
    ...live.map((f, i) => ({ sev: f.sev, msg: `${f.loc.label}: ${f.msg}`, code: f.code, line: f.loc.line, file: Core.locFile(f.loc, A.cfg.model), fi: A.diags.indexOf(f), unknown: f.unknown, dec: Core.decisionsFor(f, A.decisions)[0], f }))];
  const mby = new Map();
  for (const r of mrows) { if (!mby.has(r.file)) mby.set(r.file, []); mby.get(r.file).push(r); }
  groups.push(...mby);
  const byPath = new Map();
  for (const e of [...A.yamlErrors, ...A.ledgerErrors, ...A.workErrors]) { if (!byPath.has(e.path)) byPath.set(e.path, []); byPath.get(e.path).push({ sev: 'error', msg: e.msg, code: 'yaml', line: e.line }); }
  for (const w of A.workWarnings) { if (!byPath.has(w.path)) byPath.set(w.path, []); byPath.get(w.path).push({ sev: 'warning', msg: w.msg, code: 'work', line: 1 }); }
  const seenP = new Set();
  for (const x of A.proposals) { if (seenP.has(x.id) && x._path) { if (!byPath.has(x._path)) byPath.set(x._path, []); byPath.get(x._path).push({ sev: 'error', msg: `duplicate id ${x.id}`, code: 'id', line: 1 }); } seenP.add(x.id); }
  groups.push(...byPath);
  return groups;
}
const asA = s => ({ model: s.model, diags: s.diags, cfg: s.cfg, decisions: s.assembled.gateInputs.decisions, yamlErrors: s.assembled.yamlErrors, ledgerErrors: s.assembled.ledgerErrors, workErrors: [], workWarnings: [], proposals: s.assembled.proposals });

function splitRegistry() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'designc-prob-'));
  fs.cpSync(SAMPLE, dir, { recursive: true });
  fs.rmSync(path.join(dir, 'model'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'fixtures/include-model'), path.join(dir, 'model'), { recursive: true });
  return dir;
}
function brokenRegistry() {
  return tmpRegistry({
    'designc.json': '{}',
    [W]: fs.readFileSync(path.join(SAMPLE, W), 'utf8'),
    'decisions/x.yaml': 'id: x\n  bad: [unclosed\n',
    'ledger/l.jsonl': 'not json\n',
    'acceptance/y.yaml': 'just a string\n',
    'proposals/a.yaml': 'id: same\nstatement: one\n',
    'proposals/b.yaml': 'id: same\nstatement: two\n',
  });
}

test('sample-registry gives exactly the recorded Problems rows: 8, 2 errors and 6 warnings, suppressed DC005 :40 absent', () => {
  const s = Headless.checkState(SAMPLE);
  const g = stateRows(s);
  assert.deepEqual(flat(g), [
    [W, 53, 'error', 'DC002'], [W, 94, 'error', 'DC004'], [W, 82, 'warning', 'DC001'], [W, 63, 'warning', 'DC003'],
    [W, 33, 'warning', 'DC005'], [W, 94, 'warning', 'DC006'], [W, 94, 'warning', 'DC008'], [W, 94, 'warning', 'DC011'],
  ]);
  assert.deepEqual(Problems.counts(g), { errors: 2, warnings: 6 });
  assert.ok(!flat(g).some(r => r[1] === 40));
});

test('a split model groups rows under the included file each finding lives in', () => {
  const g = stateRows(Headless.checkState(splitRegistry()));
  // workspace.dsl holds the includes only and has no finding of its own, so it has no group (the brief listed it; the code says otherwise).
  assert.deepEqual(g.map(([p]) => p), ['model/fares/workers.dsl', 'model/relationships.dsl', 'model/fares.dsl']);
  assert.deepEqual(Problems.counts(g), { errors: 2, warnings: 6 });
});

test('broken registry files give yaml, yaml (ledger), yaml and id rows in file order', () => {
  const s = Headless.checkState(brokenRegistry());
  const g = stateRows(s);
  const paths = g.filter(([p]) => p !== W).map(([p, rs]) => [p, rs.map(r => r.code)]);
  assert.deepEqual(paths, [['decisions/x.yaml', ['yaml']], ['acceptance/y.yaml', ['yaml']], ['ledger/l.jsonl', ['yaml']], ['proposals/b.yaml', ['id']]]);
});

test('the group order and rows match the old inline renderPanel code on every fixture', () => {
  for (const dir of [SAMPLE, splitRegistry(), brokenRegistry()]) {
    const s = Headless.checkState(dir);
    const a = oldInline(asA(s)), b = stateRows(s);
    assert.deepEqual(b.map(([p, rs]) => [p, rs.map(r => ({ ...r, f: undefined }))]), a.map(([p, rs]) => [p, rs.map(r => ({ ...r, f: undefined }))]));
    assert.equal(JSON.stringify(b), JSON.stringify(a));
  }
});

test('work errors and warnings group as in the panel', () => {
  const s = Headless.checkState(SAMPLE);
  const g = Problems.rows({ model: s.model, diags: [], cfgModel: s.cfg.model, workErrors: [{ path: 'work/a.yaml', line: 3, msg: 'bad' }], workWarnings: [{ path: 'work/a.yaml', msg: 'hmm' }] });
  assert.deepEqual(g, [['work/a.yaml', [{ sev: 'error', msg: 'bad', code: 'yaml', line: 3 }, { sev: 'warning', msg: 'hmm', code: 'work', line: 1 }]]]);
});

// ---- overlay
test('an unsaved model edit changes the findings, and the disk is unchanged', () => {
  const before = fs.readFileSync(path.join(SAMPLE, W), 'utf8');
  const edited = before.split('\n').map((l, i) => (i === 99 ? l.replace('"no"', '"yes"') : l)).join('\n');
  assert.notEqual(edited, before);
  const s = Headless.checkState(SAMPLE, { overlay: { [W]: edited } });
  const rows = flat(stateRows(s));
  assert.ok(!rows.some(r => r[3] === 'DC004'), 'DC004 should clear');
  assert.ok(rows.some(r => r[3] === 'DC002'));
  assert.equal(fs.readFileSync(path.join(SAMPLE, W), 'utf8'), before);
});

test('an unsaved new include in the model folder resolves; other new keys are ignored', () => {
  const dir = splitRegistry();
  const ws = fs.readFileSync(path.join(dir, W), 'utf8');
  const withInc = ws + '\n';
  const files0 = Headless.checkState(dir);
  assert.deepEqual(files0.model.errors, []);
  // point the workspace at a file that exists only in the overlay
  const m = /!include\s+(\S+)/.exec(ws); assert.ok(m, 'the split workspace has an include');
  const missing = path.join(dir, 'model', m[1].replace(/^"|"$/g, ''));
  const original = fs.readFileSync(missing, 'utf8');
  fs.rmSync(missing);
  assert.ok(Headless.checkState(dir).model.errors.length > 0, 'include is missing on disk');
  const s = Headless.checkState(dir, { overlay: { [path.relative(dir, missing).split(path.sep).join('/')]: original, 'decisions/new.yaml': 'id: n\n' } });
  assert.deepEqual(s.model.errors, []);
  assert.ok(!('decisions/new.yaml' in s.files));
  void withInc;
});

test('an overlay designc.json is ignored, and applyOverlay is pure', () => {
  const s = Headless.checkState(SAMPLE, { overlay: { 'designc.json': '{ nope' } });
  assert.ok(!s.error);
  const files = { [W]: 'a' };
  const out = Headless.applyOverlay(files, { [W]: 'b', 'designc.json': 'x', 'notes.txt': 'y' }, W);
  assert.deepEqual(files, { [W]: 'a' });
  assert.deepEqual(out, { [W]: 'b' });
});
