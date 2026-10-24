'use strict';
// Parity snapshots: format shapes and normalising a raw tree. Shape is kept, data never is.
const test = require('node:test');
const assert = require('node:assert');
const Parity = require('../renderer/parity.js');
const R = require('../recorder/index.js');
const Fixture = require('../recorder/adapters/fixture.js');
const cases = require('../docs/parity-cases.json');

for (const c of cases.shape) {
  test(`shape case ${c.id}: "${c.a}" and "${c.b}" ${c.same ? 'fit' : 'differ'}`, () => {
    const a = Parity.shape(c.a);
    const b = Parity.shape(c.b);
    if (c.shapeA) assert.strictEqual(a, c.shapeA);
    if (c.shapeB) assert.strictEqual(b, c.shapeB);
    assert.strictEqual(Parity.sameShape(a, b), c.same, `${a} vs ${b}`);
  });
}

// Shaped like Chromium's tree of fixtures/parity-legacy/tags.html (see test/parity-web-adapter.test.js).
const n = (role, name = '', children = [], extra = {}) => ({ role, name, box: null, children, ...extra });
const text = s => n('StaticText', s);
const tree = n('RootWebArea', 'Adhoc tags', [n('main', '', [
  n('heading', 'Adhoc tags', [text('Adhoc tags')]),
  n('LabelText', '', [text('Program '), n('textbox', 'Program', [n('generic', '')], { testId: 'program-search', value: 'Alpha' })]),
  n('table', 'Programs', [
    n('rowgroup', '', [n('row', '', [n('columnheader', 'Program', [text('Program')]), n('columnheader', 'Inception', [text('Inception')])])]),
    n('rowgroup', '', [
      n('row', '', [n('cell', 'Mock Program Alpha', [text('Mock Program Alpha')]), n('cell', '15/01/2026', [text('15/01/2026')])]),
      n('row', '', [n('cell', 'Mock Program Beta', [text('Mock Program Beta')]), n('cell', '02/03/2026', [text('02/03/2026')])]),
    ]),
  ]),
  n('button', 'Bulk apply', [text('Bulk apply')]),
  n('button', 'Export', [text('Export')], { disabled: true }),
  n('status', ''),
])]);

test('normalise keeps interface text and structure, and only the shape of data', () => {
  const s = Parity.normalise(tree, { viewport: { width: 1280, height: 800 } });
  assert.deepStrictEqual(s.elements.map(e => e.key), ['heading:Adhoc tags', 'text:Program', 'textbox:Program', 'table:Programs', 'button:Bulk apply', 'button:Export', 'status#0']);
  const field = s.elements[2];
  assert.strictEqual(field.valueShape, 'text:Aa');
  assert.strictEqual(field.testId, 'program-search');
  assert.deepStrictEqual(field.children, [], 'a control\'s rendering is dropped');
  const table = s.elements[3];
  assert.deepStrictEqual(table.columns, [{ name: 'Program', shape: 'text:Aa' }, { name: 'Inception', shape: 'date:dd/0d/dddd' }]);
  assert.strictEqual(table.records, 2);
  assert.deepStrictEqual(table.children.map(r => r.key), ['row:head', 'row:record'], 'one record stands for all');
  assert.deepStrictEqual(table.children[1].children.map(c => [c.key, c.shape]), [['cell[Program]', 'text:Aa'], ['cell[Inception]', 'date:dd/0d/dddd']]);
  assert.strictEqual(s.elements[5].enabled, false);
  const json = JSON.stringify(s);
  for (const value of ['Mock Program', '15/01/2026', '02/03/2026', 'Alpha']) assert.ok(!json.includes(value), `${value} is data and is not kept`);
});

test('sort and filter expectations are judged on this side, so no value is kept for them', () => {
  const sorted = Parity.normalise(tree, { expect: { sorted: 'Inception' } }).elements[3].checks;
  assert.deepStrictEqual(sorted, [{ kind: 'sort', column: 'Inception', dir: 'asc' }]);
  const filtered = Parity.normalise(tree, { expect: { filtered: { column: 'Program', contains: 'beta' } } }).elements[3].checks;
  assert.deepStrictEqual(filtered, [{ kind: 'filter', column: 'Program', rows: 2, bad: 1 }]);
  const nowhere = Parity.normalise(tree, { expect: { sorted: 'Premium' } }).elements[3].checks;
  assert.strictEqual(nowhere[0].dir, 'no column');
});

test('masks: ignore drops a value, exact keeps a vocabulary word', () => {
  const ignored = Parity.normalise(tree, { masks: [{ column: 'Program', mode: 'ignore' }] }).elements[3].children[1].children[0];
  assert.strictEqual(ignored.shape, 'empty');
  assert.strictEqual(Parity.normalise(tree, { masks: [{ column: 'Program', mode: 'ignore' }] }).elements[3].columns[0].shape, 'empty', 'an ignored column has no shape to compare');
  const exact = Parity.normalise(tree, { masks: [{ column: 'Inception', mode: 'exact' }] }).elements[3];
  assert.strictEqual(exact.children[1].children[1].key, 'cell:15/01/2026');
  assert.strictEqual(exact.columns[1].exact, true);
});

test('volatile parts of interface text are replaced', () => {
  assert.strictEqual(Parity.volatile('Saved 3 items at 09:30 (id 0f8fad5b-d9cb-469f-a165-70867728950e)'), 'Saved # items at <time> (id <guid>)');
});

test('direction reads dates, numbers and text under en-GB', () => {
  assert.strictEqual(Parity.direction(['15/01/2026', '01/02/2026']), 'asc');
  assert.strictEqual(Parity.direction(['(5.00)', '1.00', '1,200.00']), 'asc');
  assert.strictEqual(Parity.direction(['beta', 'Alpha']), 'desc');
  assert.strictEqual(Parity.direction(['b', 'a', 'c']), 'none');
  assert.strictEqual(Parity.direction(['x', 'x']), 'unknown');
});

test('scenario rules: one action per step, expectations well formed, masks with a mode', () => {
  assert.deepStrictEqual(Parity.scenarioProblems({ id: 'tags-sort', steps: [{ goto: { path: '/tags' }, expect: { sorted: 'Inception' } }] }), []);
  assert.deepStrictEqual(Parity.scenarioProblems({ id: 'x y', steps: [] }), ['the scenario needs an id of letters, digits, ".", "_" or "-"', 'the scenario needs at least one step']);
  assert.deepStrictEqual(Parity.scenarioProblems({ id: 'a', steps: [{ click: { role: 'button', name: 'Go' }, expect: { filtered: { column: 'P' } } }], masks: [{ column: 'P' }] }),
    ['step 1: expect.filtered needs a column and contains', 'mask 1: mode must be ignore, shape, exact']);
});

test('snapshot of a recording: steps normalised, params resolved per side, no raw tree kept', async () => {
  const fx = { start: 'list', paths: { '/tags': 'list' }, screens: { list: tree } };
  const scenario = { id: 'tags-filter', steps: [{ goto: { path: '/tags' }, expect: { filtered: { column: 'Program', contains: { param: 'program' } } } }], params: { legacy: { program: 'Mock' } } };
  const rec = await R.record({ scenario, side: 'legacy', adapter: Fixture.create(fx) });
  const snap = Parity.snapshot(rec, scenario);
  assert.strictEqual(snap.side, 'legacy');
  assert.strictEqual(snap.steps[0].status, 'ok');
  assert.deepStrictEqual(snap.steps[0].elements[3].checks, [{ kind: 'filter', column: 'Program', rows: 2, bad: 0 }]);
  assert.ok(!('capture' in snap.steps[0]));
  assert.ok(!JSON.stringify(snap).includes('Mock Program'));
});

test('detect names the technology from files, and says unsupported or unknown rather than guess', () => {
  assert.strictEqual(Parity.detect([{ path: 'web/package.json', text: '{"dependencies":{"react":"18.3.1"}}' }]).tech, 'web');
  assert.deepStrictEqual(Parity.detect([{ path: 'App/App.csproj', text: '<UseWPF>true</UseWPF>' }]), { tech: 'unsupported', evidence: ['App/App.csproj: UseWPF'] });
  assert.deepStrictEqual(Parity.detect([{ path: 'README.md', text: '' }]), { tech: 'unknown', evidence: [] });
});
