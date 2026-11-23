// S2: landings/ is a gate input only for the dirty check. A registry with no landings, or with landings in it, keeps the same
// gate, the same findings and the same handover id; a bad landing file is never a gate clause.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Core = require('../renderer/core.js');
const Headless = require('../headless/index.js');

const copy = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'landing-gate-')); fs.cpSync(path.join(__dirname, '..', 'sample-registry'), d, { recursive: true }); return d; };
const strip = r => JSON.stringify({ gate: r.report.gate || r.report, state: r.state.gate });

test('landings is a gate input, and nothing else about the list changed', () => {
  assert.ok(Core.GATE_INPUTS.includes('landings'));
  assert.deepEqual(Core.dirtyInputs([{ path: 'landings/RE-1.yaml' }, { path: 'landing-notes.md' }], {}), ['landings/RE-1.yaml']);
});

test('with no landings, and with good and bad landings, the gate and findings are the same', () => {
  const dir = copy();
  try {
    const none = Headless.check(dir);
    assert.ok(!none.error, none.error);
    fs.mkdirSync(path.join(dir, 'landings'));
    fs.writeFileSync(path.join(dir, 'landings', 'RE-1.yaml'), 'requirement: RE-1\nauthor: human\nstatus: proposed\n');
    fs.writeFileSync(path.join(dir, 'landings', 'broken.yaml'), ':\n  - [\n');
    fs.writeFileSync(path.join(dir, 'landings', 'RE-2.yaml'), 'requirement: RE-3\nauthor: robot\nstatus: done\n');
    const some = Headless.check(dir);
    assert.deepEqual(JSON.parse(strip(some)), JSON.parse(strip(none)));
    assert.equal(JSON.stringify(some.report), JSON.stringify(none.report));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the handover id and files do not depend on landings (it is not an input to handoverPlan)', () => {
  const DSL = 'workspace "w" { model { sys = softwareSystem "w" { a = container "A" "" "x" } } }';
  const base = { date: '2026-10-12', now: 'n', by: 'm', model: { path: 'model/workspace.dsl', text: DSL } };
  const a = Core.handoverPlan(base), b = Core.handoverPlan({ ...base, landings: [{ requirement: 'RE-1' }] });
  assert.equal(a.id, b.id);
  assert.deepEqual(a.files.map(f => f.path), b.files.map(f => f.path));
});
