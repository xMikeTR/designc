// B4: gate clauses for structured test scenarios (renderer/test-scenarios.js clauses/coverage, wired through Core.gate) and BR coverage.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), os = require('os');
const { spawnSync } = require('child_process');
const yaml = require('js-yaml');
const Core = require('../renderer/core.js');
const TS = require('../renderer/test-scenarios.js');
const { fixture, inputs, BOUND, MINTED } = require('./helpers/scenario-handover.js');

const ROOT = path.join(__dirname, '..');
const specs = () => { const f = fixture(); return [f.ordersFile, f.tagFile]; };
const commit = list => TS.clauses({ specs: specs(), testScenarios: list }).filter(c => c.screen);
const questions = list => TS.clauses({ specs: specs(), testScenarios: list }).filter(c => c.scenario);

test('a commits transition with no scenario is a clause naming the screen, the locator and the requirement', () => {
  const c = commit([]);
  assert.equal(c.length, 1);
  assert.equal(c[0].kind, 'scenario');
  assert.equal(c[0].screen, 'orders');
  assert.equal(c[0].requirement, 'ORD-1');
  assert.equal(c[0].text, 'orders: committing "Apply" (tag-popover → tagged) has no bound test scenario with examples');
});
test('a minted scenario does not satisfy the commit clause', () => assert.equal(commit([{ ...MINTED }]).length, 1));
test('a bound scenario with no examples does not satisfy it', () => assert.equal(commit([{ ...BOUND, examples: [] }]).length, 1));
test('a bound scenario that never clicks Apply does not satisfy it', () => assert.equal(commit([{ ...BOUND, steps: BOUND.steps.slice(0, 2) }]).length, 1));
test('a bound one matching the Apply click (through the host) clears it', () => assert.deepEqual(commit([{ ...BOUND }]), []));
test('a flat scenario never counts', () => assert.equal(commit([{ id: 'x', requirement: 'ORD-1', given: ['a'], when: ['b'], then: ['c'], status: 'bound' }]).length, 1));

test('an open question is one blocking clause per scenario, with its requirement', () => {
  assert.deepEqual(questions([{ ...MINTED, questions: ['Which tags?', ' '] }]).map(c => [c.text, c.scenario, c.requirement]), [['ORD-1-ts-02: 1 open question(s) block binding', 'ORD-1-ts-02', 'ORD-1']]);
  assert.deepEqual(questions([{ ...MINTED }]), []);
  assert.deepEqual(questions([{ ...MINTED, questions: [] }]), []);
});

test('Core.gate: scenario clauses come with the gate, appear and disappear', () => {
  const f = fixture();
  const g = t => Core.gate({ model: Core.parse(f.modelText), diags: [], decisions: [], requirements: [], ledger: [], ui: { pack: { components: [], templates: [] }, specs: [f.ordersFile, f.tagFile], holdouts: [], legacy: [] }, testScenarios: t }).clauses.filter(c => c.kind === 'scenario');
  assert.equal(g([MINTED]).length, 1);
  assert.equal(g([BOUND]).length, 0);
  assert.equal(g([BOUND, { ...MINTED, questions: ['q?'] }]).length, 1);
});
test('an item scoped to another requirement does not see them', () => {
  const clauses = [{ kind: 'scenario', text: 'a', requirement: 'ORD-1' }, { kind: 'scenario', text: 'b', requirement: 'X-2' }, { kind: 'scenario', text: 'c' }];
  const r = Core.scopedGate({ clauses }, { model: Core.parse(''), requirement: 'ORD-1' });
  assert.deepEqual(r.clauses.map(c => c.text), ['a', 'c']);
});

// The done-when test: the B3 in-memory setup, as a registry on disk, checked by the headless core.
function registry(scenarios) {
  const f = fixture(), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'b4-'));
  const w = (rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
  w('designc.json', fs.readFileSync(path.join(ROOT, 'fixtures/scenario-registry/designc.json'), 'utf8'));
  w('model/workspace.dsl', f.modelText);
  for (const s of [f.ordersFile, f.tagFile]) w(s.path, s.text);
  for (const r of f.requirements) w(r.path, r.text);
  w('contracts/openapi/orders.yaml', f.apiContracts[0].text);
  for (const s of scenarios) w(`test-scenarios/${s.id}.yaml`, yaml.dump(s));
  return dir;
}
const check = dir => JSON.parse(spawnSync(process.execPath, [path.join(ROOT, 'scripts/designc-core.js'), 'check', dir, '--json', '--no-record'], { encoding: 'utf8', env: { ...process.env, NODE_ENV: 'test' } }).stdout).gate;
test('headless check: minted is not ready because of the commit clause, bound (no questions) clears it', () => {
  const minted = check(registry([{ ...BOUND, status: 'minted' }])).clauses.filter(c => c.kind === 'scenario');
  assert.equal(minted.length, 1);
  assert.match(minted[0].text, /committing "Apply"/);
  assert.deepEqual(check(registry([BOUND])).clauses.filter(c => c.kind === 'scenario'), []);
  const asked = check(registry([{ ...BOUND, questions: ['Which tags?'] }])).clauses.filter(c => c.kind === 'scenario');
  assert.deepEqual(asked.map(c => c.text), ['ORD-1-ts-01: 1 open question(s) block binding']);
});
test('the app and the headless assembly agree (same inputs, same clauses)', () => {
  const GI = require('../renderer/gate-inputs.js');
  const f = fixture();
  const a = GI.assemble({ cfg: {}, files: { 'model/workspace.dsl': f.modelText, [f.ordersFile.path]: f.ordersFile.text, [f.tagFile.path]: f.tagFile.text, 'test-scenarios/a.yaml': yaml.dump(MINTED) }, yamlLoad: yaml.load });
  assert.deepEqual(a.gateInputs.testScenarios.map(t => t._path), ['test-scenarios/a.yaml']);
  assert.equal(GI.run(a).gate.clauses.filter(c => c.kind === 'scenario').length, 1);
  assert.ok(Core.GATE_INPUTS.includes('test-scenarios'));
});

test('coverage: sentences split on . ! ?, tags stripped, a quoted source covers its sentence either way round', () => {
  const page = '<p>The tag is applied to all orders matching the string entered.  Clerks may undo it!</p><p>Is it audited?</p>';
  const r = TS.coverage(page, [{ ...BOUND }]);
  assert.deepEqual([r.covered, r.total], [1, 3]);
  assert.deepEqual(r.uncovered, ['Clerks may undo it!', 'Is it audited?']);
  assert.deepEqual(TS.coverage(page, [{ ...BOUND, source: 'The tag is applied' }]).covered, 1);
  assert.deepEqual(TS.coverage(page, [{ id: 'f', given: [], source: 'Clerks may undo it!' }]).covered, 0);
  assert.deepEqual(TS.coverage('', []), { covered: 0, total: 0, uncovered: [] });
});
