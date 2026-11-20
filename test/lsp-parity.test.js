// L1 slice 3: the LSP shows the Problems view's rows. The e2e pins the GUI at 2 errors and 6 warnings; renderPanel and the LSP share Problems.rows.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const P = require('../lsp/providers.js');
const Problems = require('../renderer/problems.js');
const Headless = require('../headless/index.js');
const { tmpRegistry } = require('./helpers/parity.js');

const ROOT = path.join(__dirname, '..');
const SAMPLE = path.join(ROOT, 'sample-registry');
const W = 'model/workspace.dsl';

function splitRegistry() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'designc-par-'));
  fs.cpSync(SAMPLE, dir, { recursive: true });
  fs.rmSync(path.join(dir, 'model'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'fixtures/include-model'), path.join(dir, 'model'), { recursive: true });
  return dir;
}
function brokenRegistry() {
  return tmpRegistry({
    'designc.json': '{}', [W]: fs.readFileSync(path.join(SAMPLE, W), 'utf8'),
    'decisions/x.yaml': 'id: x\n  bad: [unclosed\n', 'ledger/l.jsonl': 'not json\n', 'acceptance/y.yaml': 'just a string\n',
    'proposals/a.yaml': 'id: same\nstatement: one\n', 'proposals/b.yaml': 'id: same\nstatement: two\n',
  });
}
const rowsOf = s => Problems.rows({ model: s.model, diags: s.diags, cfgModel: s.cfg.model, decisions: s.assembled.gateInputs.decisions, yamlErrors: s.assembled.yamlErrors, ledgerErrors: s.assembled.ledgerErrors, proposals: s.assembled.proposals });
const publish = (dir, related = false) => {
  const s = Headless.checkState(dir), groups = rowsOf(s);
  return { s, groups, map: P.toDiagnostics(groups, { root: dir, textOf: rel => (s.files[rel] != null ? s.files[rel] : null), cfgModel: s.cfg.model, related }) };
};

for (const [name, mk] of [['sample-registry', () => SAMPLE], ['split registry', splitRegistry], ['broken files', brokenRegistry]]) {
  test(`${name}: per URI, the diagnostics are the Problems rows, in order`, () => {
    const dir = mk(), { groups, map } = publish(dir);
    assert.deepEqual([...map.keys()], groups.map(([rel]) => P.uri(dir, rel)));
    for (const [rel, rows] of groups) {
      const ds = map.get(P.uri(dir, rel));
      assert.equal(ds.length, rows.length);
      rows.forEach((r, i) => {
        assert.equal(ds[i].range.start.line, Math.max(r.line || 1, 1) - 1);
        assert.equal(ds[i].severity, r.sev === 'error' ? 1 : r.sev === 'warning' ? 2 : 3);
        assert.equal(ds[i].code, r.code);
        assert.equal(ds[i].message.split('\n')[0].replace(' (undeclared property)', ''), r.msg);
      });
    }
  });
}

test('sample-registry: one URI, model/workspace.dsl, 8 diagnostics: 2 Error and 6 Warning, the recorded codes and lines', () => {
  const { map } = publish(SAMPLE);
  assert.deepEqual([...map.keys()], [P.uri(SAMPLE, W)]);
  const ds = map.get(P.uri(SAMPLE, W));
  assert.deepEqual(ds.map(d => [d.code, d.range.start.line + 1, d.severity]), [
    ['DC002', 53, 1], ['DC004', 94, 1], ['DC001', 82, 2], ['DC003', 63, 2], ['DC005', 33, 2], ['DC006', 94, 2], ['DC008', 94, 2], ['DC011', 94, 2],
  ]);
  assert.equal(ds.filter(d => d.severity === 1).length, 2);
  assert.equal(ds.filter(d => d.severity === 2).length, 6);
});

test('broken files land on their own URIs, whole line', () => {
  const dir = brokenRegistry(), { map } = publish(dir);
  for (const rel of ['decisions/x.yaml', 'ledger/l.jsonl', 'acceptance/y.yaml', 'proposals/b.yaml']) {
    const ds = map.get(P.uri(dir, rel));
    assert.equal(ds.length, 1, rel);
    assert.equal(ds[0].range.start.character, 0);
  }
  assert.deepEqual(map.get(P.uri(dir, 'ledger/l.jsonl'))[0].code, 'yaml');
  assert.deepEqual(map.get(P.uri(dir, 'proposals/b.yaml'))[0].code, 'id');
});
