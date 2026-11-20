// C6 slice 2: a model split over files gives the same findings, gate and fingerprints as the single file.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Core = require('../renderer/core.js');
const Headless = require('../headless/index.js');
const { nodeReport } = require('./helpers/parity.js');

const ROOT = path.join(__dirname, '..');
function splitRegistry(mutate) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'designc-include-'));
  fs.cpSync(path.join(ROOT, 'sample-registry'), dir, { recursive: true });
  fs.rmSync(path.join(dir, 'model'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'fixtures/include-model'), path.join(dir, 'model'), { recursive: true });
  if (mutate) mutate(dir);
  return dir;
}
const single = Headless.check(path.join(ROOT, 'sample-registry'));
const dir = splitRegistry();
const split = Headless.check(dir);
const lineText = (state, loc) => {
  const src = state.model.sources.find(s => s.path === loc.file);
  assert.ok(src, `no source for ${loc.file}`);
  return src.text.split('\n')[loc.line - 1].trim();
};

test('the split registry reads with no errors and the same findings and gate as the single file', () => {
  assert.ok(!split.error, split.error);
  assert.deepEqual(split.state.model.errors, []);
  const key = f => ({ code: f.code, sev: f.sev, msg: f.msg, label: f.label, unknown: f.unknown, suppressed: f.suppressed });
  assert.deepEqual(split.report.findings.map(key), single.report.findings.map(key));
  assert.deepEqual(split.report.gate, single.report.gate);
  assert.ok(split.report.findings.length > 0);
});

test('every finding, related loc and clause points at the same line text in its own file', () => {
  const files = new Set();
  const check = (d, loc) => {
    assert.ok(loc.file, `${d} has no file`);
    files.add(loc.file);
  };
  split.state.diags.forEach((d, i) => {
    const s = single.state.diags[i];
    assert.equal(lineText(split.state, d.loc), lineText(single.state, s.loc), `${d.code} ${d.loc.label}`);
    check(d.code, d.loc);
    assert.equal(d.related.length, s.related.length);
    d.related.forEach((r, j) => { if (r.line != null) assert.equal(lineText(split.state, r), lineText(single.state, s.related[j]), `${d.code} related`); });
  });
  const sc = single.state.gate.clauses, pc = split.state.gate.clauses;
  assert.equal(pc.length, sc.length);
  pc.forEach((c, i) => {
    assert.equal(c.text, sc[i].text);
    if (c.line != null) {
      assert.ok(c.file && c.file.startsWith('model/'), 'clause carries a file under model/');
      assert.equal(lineText(split.state, c), lineText(single.state, { file: single.state.cfg.model, line: sc[i].line }));
    }
  });
  for (const f of ['model/workspace.dsl', 'model/fares.dsl', 'model/fares/workers.dsl', 'model/relationships.dsl']) {
    if (f === 'model/workspace.dsl') continue;
    assert.ok(files.has(f), `a finding lies in ${f}; saw ${[...files]}`);
  }
});

test('fingerprints, the semantic diff and the verdict hash are unchanged by the split', () => {
  const a = single.state.model, b = split.state.model;
  assert.deepEqual([...a.elements.keys()], [...b.elements.keys()]);
  for (const id of a.elements.keys()) assert.equal(Core.fingerprint(b, id).hash, Core.fingerprint(a, id).hash, id);
  const d = Core.diffModels(a, b);
  assert.deepEqual(d.summary, { added: 0, removed: 0, changed: 0, relsAdded: 0, relsRemoved: 0, relsChanged: 0 });
  const rec = s => Core.gateRecord({ modelText: s.modelText, diags: s.diags, gate: s.gate, source: 'local' });
  assert.equal(rec(split.state).verdict, rec(single.state).verdict);
});

test('moving escalations from fares/workers.dsl into fares.dsl keeps every fingerprint', () => {
  const dir2 = splitRegistry(d => {
    const w = fs.readFileSync(path.join(d, 'model/fares/workers.dsl'), 'utf8').split('\n');
    const esc = w.slice(0, 5).join('\n'), rest = w.slice(5).join('\n');
    fs.writeFileSync(path.join(d, 'model/fares/workers.dsl'), rest);
    const f = fs.readFileSync(path.join(d, 'model/fares.dsl'), 'utf8');
    fs.writeFileSync(path.join(d, 'model/fares.dsl'), f.replace('      !include fares/workers.dsl', esc + '\n      !include fares/workers.dsl'));
  });
  const moved = Headless.check(dir2);
  assert.deepEqual(moved.state.model.errors, []);
  assert.equal(moved.state.model.elements.get('escalations').file, 'model/fares.dsl');
  for (const id of single.state.model.elements.keys()) assert.equal(Core.fingerprint(moved.state.model, id).hash, Core.fingerprint(single.state.model, id).hash, id);
});

test('the app assembly (parity helper) and headless give the same report for the split registry', () => {
  assert.deepEqual(nodeReport(dir), split.report);
});

test('report key order is line, file', () => {
  assert.deepEqual(Object.keys(split.report.errors[0] || { line: 0, file: 0, msg: 0 }), ['line', 'file', 'msg']);
  const keys = Object.keys(split.report.findings[0]);
  assert.equal(keys[keys.indexOf('line') + 1], 'file');
  const bad = splitRegistry(d => fs.writeFileSync(path.join(d, 'model/fares/workers.dsl'), 'bogus "x"\n'));
  assert.deepEqual(Object.keys(Headless.check(bad).report.errors[0]), ['line', 'file', 'msg']);
  assert.equal(Headless.check(bad).report.errors[0].file, 'model/fares/workers.dsl');
});

test('MCP get_findings and get_gate carry file', () => {
  const f = JSON.parse(Headless.callTool(dir, 'get_findings').text);
  assert.ok(f.every(x => typeof x.file === 'string'));
  const bad = splitRegistry(d => fs.writeFileSync(path.join(d, 'model/fares/workers.dsl'), 'bogus "x"\n'));
  const g = JSON.parse(Headless.callTool(bad, 'get_gate').text);
  const parse = g.blocking.find(c => c.kind === 'parse');
  assert.equal(parse.file, 'model/fares/workers.dsl');
});
