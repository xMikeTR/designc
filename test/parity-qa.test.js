'use strict';
// QA bugs against recorded parity: the behaviour table, the grouped diff, the QA file and the four buckets.
// The matching cases are the contract in docs/parity-qa-cases.json.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const Parity = require('../renderer/parity.js');
const ParityQa = require('../renderer/parity-qa.js');
const cases = require('../docs/parity-qa-cases.json');

const W = cases.world;
const reportOf = bugs => ParityQa.report({ screen: W.screen, scenarios: W.scenarios, baselines: W.baselines, reports: W.reports, qa: { screen: W.screen, bugs, problems: [] } });

for (const c of cases.bugs) {
  test(`qa case ${c.bug.key}: ${c.about}`, () => {
    const r = reportOf([c.bug]);
    const b = r.bugs[0];
    assert.strictEqual(b.bucket, c.bucket, b.reason);
    assert.ok(b.reason && typeof b.reason === 'string', 'every bug says why');
  });
}

test('the cases cover every bucket', () => {
  const seen = new Set(cases.bugs.map(c => c.bucket));
  for (const k of ParityQa.BUCKETS) assert.ok(seen.has(k), `no case for ${k}`);
});

test('report counts every bucket, and triage is outside the four', () => {
  const r = reportOf(cases.bugs.map(c => c.bug));
  const want = {};
  for (const k of ParityQa.BUCKETS) want[k] = cases.bugs.filter(c => c.bucket === k).length;
  assert.deepStrictEqual(r.counts, want);
  assert.deepStrictEqual(r.states, ['list', 'new dialog', 'confirm']);
  const caught = r.bugs.find(b => b.key === 'QA-1');
  assert.deepStrictEqual({ scenario: caught.finding.scenario, step: caught.finding.step, kind: caught.finding.kind }, { scenario: 'orders-list', step: 1, kind: 'shape' });
  const gap = r.bugs.find(b => b.key === 'QA-8');
  assert.ok(gap.seen && gap.seen.legacy && gap.seen.next, 'a rule gap says what the table holds on each side');
  assert.match(r.bugs.find(b => b.key === 'QA-7').reason, /drop-archive/);
  assert.match(r.bugs.find(b => b.key === 'QA-11').reason, /could not run/);
});

test('report copies no bug text', () => {
  const r = reportOf(cases.bugs.map(c => c.bug));
  const out = JSON.stringify(r);
  for (const c of cases.bugs) for (const k of ['description', 'actual', 'expected']) if (c.bug[k]) assert.ok(!out.includes(c.bug[k]), `${c.bug.key} ${k} leaked`);
});

test('a screen no scenario records is a problem, not an empty pass', () => {
  const r = ParityQa.report({ screen: 'nowhere', scenarios: W.scenarios, baselines: W.baselines, reports: W.reports, qa: { screen: 'nowhere', bugs: [cases.bugs[0].bug], problems: [] } });
  assert.ok(r.problems.some(p => /no scenario/.test(p)), r.problems.join('; '));
  assert.strictEqual(r.bugs[0].bucket, 'state_not_recorded');
});

test('behaviour: one row per control per state per side, with name, enabled, order and format', () => {
  const rows = ParityQa.behaviour(W.baselines['orders-list'], W.scenarios[0]);
  const exp = rows.find(r => r.state === 'list' && r.key === 'button:Export');
  assert.deepStrictEqual({ side: exp.side, step: exp.step, role: exp.role, name: exp.name, enabled: exp.enabled, order: exp.order, format: exp.format }, { side: 'legacy', step: 1, role: 'button', name: 'Export', enabled: true, order: 3, format: null });
  const cell = rows.find(r => r.key === 'table:Orders/row:record/cell[Placed]');
  assert.deepStrictEqual([cell.name, cell.format], ['Placed', 'date:dd/0d/dddd']);
  assert.strictEqual(rows.find(r => r.key === 'dialog:New order/textbox:Customer').format, 'empty');
  assert.ok(!rows.some(r => r.step === 3 && r.side === 'next'));
  const unlabelled = ParityQa.behaviour(W.baselines['orders-list'], { id: 'x', steps: [{ goto: { path: '/' } }] });
  assert.strictEqual(unlabelled[0].state, 'x step 1');
});

test('group: every finding kind lands in exactly one group, covered apart', () => {
  for (const k of Parity.KINDS) assert.ok(['missing', 'divergent', 'newOnly'].includes(ParityQa.GROUP_OF[k]), k);
  const g = ParityQa.group(W.reports['orders-list'].result, W.scenarios[0]);
  assert.deepStrictEqual(g.missing.map(f => f.key), []);
  assert.deepStrictEqual(g.newOnly.map(f => f.key), ['button:Help']);
  assert.deepStrictEqual(g.divergent.map(f => f.kind).sort(), ['order', 'shape', 'state', 'text']);
  assert.deepStrictEqual(g.covered.map(f => f.by), ['drop-archive']);
  assert.strictEqual(g.divergent[0].state, 'list');
});

test('read: the QA file, its problems, and triage for what a person has not filled', () => {
  const r = ParityQa.read(`
screen: orders
bugs:
  - key: QA-1
    description: d
    actual: a
    expected: e
    screenshots: [shots/qa-1.png]
    where: { role: button, name: Save }
    kind: text
    state: list
  - key: QA-2
    description: only what QA gave
  - key: QA-1
    where: { role: button }
    kind: colour
    screenshots: [../secret.png]
  - description: no key
`, { parseYaml: yaml.load, file: 'parity/qa/orders.yaml' });
  assert.strictEqual(r.screen, 'orders');
  assert.strictEqual(r.bugs.length, 3);
  assert.ok(ParityQa.needsTriage(r.bugs[1]));
  assert.ok(!ParityQa.needsTriage(r.bugs[0]));
  const ps = r.problems.join('\n');
  for (const want of [/QA-1 is repeated/, /kind must be one of/, /where needs a role and a name/, /screenshots go under shots\//, /bug 4 needs a key/]) assert.match(ps, want);
  assert.match(ParityQa.read('screen: other\nbugs: []', { parseYaml: yaml.load, file: 'parity/qa/orders.yaml' }).problems.join(), /file is named orders/);
  assert.strictEqual(ParityQa.read('bugs: []', { parseYaml: yaml.load, file: 'parity/qa/orders.yaml' }).screen, 'orders');
  assert.match(ParityQa.read(': : :', { parseYaml: yaml.load, file: 'parity/qa/orders.yaml' }).problems.join(), /does not parse/);
});

test('a step state label is optional and must be a name', () => {
  assert.strictEqual(Parity.stepProblem({ goto: { path: '/' }, state: 'list' }), null);
  assert.match(Parity.stepProblem({ goto: { path: '/' }, state: '' }), /state must be a name/);
  assert.match(Parity.stepProblem({ goto: { path: '/' }, state: 3 }), /state must be a name/);
});

test('the fixture registry: tags bugs land where its README says', () => {
  const reg = path.join(__dirname, '../fixtures/parity-registry');
  const scenarios = ['tags-list', 'tags-apply'].map(id => yaml.load(fs.readFileSync(path.join(reg, `parity/scenarios/${id}.yaml`), 'utf8')));
  const baselines = {}, reports = {};
  for (const s of scenarios) {
    baselines[s.id] = JSON.parse(fs.readFileSync(path.join(reg, `parity/baselines/${s.id}/legacy.json`), 'utf8'));
    reports[s.id] = JSON.parse(fs.readFileSync(path.join(reg, `parity/reports/${s.id}.json`), 'utf8'));
  }
  const qa = ParityQa.read(fs.readFileSync(path.join(reg, 'parity/qa/tags.yaml'), 'utf8'), { parseYaml: yaml.load, file: 'parity/qa/tags.yaml' });
  assert.deepStrictEqual(qa.problems, []);
  const r = ParityQa.report({ screen: 'tags', scenarios, baselines, reports, qa });
  assert.deepStrictEqual(r.counts, { caught: 1, not_captured: 1, state_not_recorded: 2, not_flagged: 1, triage: 1 });
});

// Slice 7f: the UI graph join. docs/parity-qa-cases.json "code".
const C = cases.code;
const codeReport = bugs => ParityQa.report({ screen: W.screen, scenarios: W.scenarios, baselines: W.baselines, reports: W.reports, qa: { screen: W.screen, bugs, problems: [] }, ui: C.ui });
const bugOf = c => c.bug || cases.bugs.find(x => x.bug.key === c.bug_key).bug;

test('ui join: role and name, name only to exactly one recorded role, never guessed', () => {
  const r = codeReport([]);
  for (const side of ['legacy', 'next']) {
    const got = Object.fromEntries(r.code[side].controls.map(c => [c.name == null ? '(unnamed)' : c.name, c.join]));
    assert.deepStrictEqual(got, C.joins[side], side);
  }
  const dp = r.code.next.controls.find(c => c.tag === 'DatePicker');
  assert.deepStrictEqual([dp.role, dp.recorded.role], [null, 'textbox'], 'the graph keeps role null; the join says what the recording shows');
  assert.deepStrictEqual(r.code.next.controls.find(c => c.name === 'Orders').candidates.sort(), ['heading', 'table']);
  assert.deepStrictEqual(r.code.next.joined, { role: 1, name: 1, ambiguous: 1, unnamed: 1, unrecorded: 2 });
});

for (const c of C.bugs) {
  test(`ui case ${bugOf(c).key}: ${c.about}`, () => {
    const b = codeReport([bugOf(c)]).bugs[0];
    assert.strictEqual(b.bucket, c.bucket, b.reason);
    for (const want of c.cites) assert.ok(b.reason.includes(want), `${b.reason}\n  lacks: ${want}`);
    if (!c.cites.length) assert.ok(!/in code:/.test(b.reason) && !b.code, b.reason);
  });
}

test('ui join: buckets do not change with the code, and without ui nothing is cited', () => {
  const all = cases.bugs.map(c => c.bug);
  assert.deepStrictEqual(codeReport(all).counts, reportOf(all).counts);
  const plain = reportOf(all);
  assert.ok(!plain.code && plain.bugs.every(b => !b.code && !/in code:/.test(b.reason)));
  assert.strictEqual(ParityQa.fromCode(C.ui.next, 'customers', []), null, 'a graph without the screen gives nothing');
  const out = JSON.stringify(codeReport(all));
  for (const c of cases.bugs) for (const k of ['description', 'actual', 'expected']) if (c.bug[k]) assert.ok(!out.includes(c.bug[k]), `${c.bug.key} ${k} leaked`);
});

test('ui join: the widget roles are the UI graph\'s own', () => {
  assert.deepStrictEqual([...ParityQa.WIDGET].sort(), [...require('../extract/ui-roles.js').WIDGET_ROLES].sort());
});
