const test = require('node:test');
const assert = require('node:assert');
const TS = require('../renderer/test-scenarios.js');
const Core = require('../renderer/core.js');
const yamlLoad = require('js-yaml').load;

const page = 'ORD-1 Tag matching orders.\n\nThe  tag is applied to   all orders matching the string entered.';
const spec = {
  screen: 'orders',
  slots: { main: [{ id: 'match', component: 'FilterBar', locator: { role: 'textbox', name: 'Match' } }], 'header.actions': [{ id: 'tag', component: 'Button', locator: { role: 'button', name: 'Tag orders' } }] },
  transitions: [{ from: 'list', to: 'tag-popover', on: { click: { role: 'button', name: 'Tag orders' } } }, { from: 'tag-popover', to: 'tagged', on: { click: { role: 'button', name: 'Apply' } }, commits: true }, { from: 'list', to: 'list', on: { click: { role: 'button', name: 'Refresh' } } }],
};
const specs = [{ path: 'ui/specs/orders.json', text: JSON.stringify(spec) }];
const API = `openapi: 3.0.3\ninfo: {title: t, version: '1'}\npaths:\n  /orders/tags:\n    post: {operationId: tagOrders}\n`;
const reg = files => ({ files, yamlLoad });
const ctx = (over = {}) => ({ pageText: page, specs, resolveOperation: id => Core.resolveOperation(reg({ 'contracts/openapi/orders.yaml': API }), id), ...over });
const rec = (o = {}) => ({ id: 'ORD-1-ts-01', requirement: 'ORD-1', title: 'Tags matching', source: 'The tag is applied to all orders matching the string entered.', screen: 'orders',
  steps: [{ fill: { role: 'textbox', name: 'Match' }, value: '{match}' }, { click: { role: 'button', name: 'Apply' } }],
  effect: { operation: 'tagOrders', body: { match: '{match}' } }, examples: [{ match: 'A' }], ...o });
const reasons = (r, c = ctx()) => TS.mintProblems(r, c).map(p => p.reason);

test('a valid structured scenario has no problems; whitespace in the source and the page is collapsed', () => {
  assert.deepStrictEqual(TS.mintProblems(rec(), ctx()), []);
  assert.deepStrictEqual(reasons(rec({ source: 'The tag is applied  to all\norders matching the string entered.' })), []);
});

test('source_not_in_page: missing, or not verbatim (case matters)', () => {
  assert.deepStrictEqual(reasons(rec({ source: 'the tag is applied to all orders matching the string entered.' })), ['source_not_in_page']);
  assert.deepStrictEqual(reasons(rec({ source: undefined })), ['source_not_in_page']);
  assert.match(TS.mintProblems(rec({ source: 'Invented.' }), ctx())[0].message, /"Invented\." is not in the requirement page/);
});

test('flat records are checked for source_not_in_page only', () => {
  const flat = { id: 'x', requirement: 'ORD-1', title: 't', given: ['a'], when: ['b'], then: ['c'], source: 'Tag matching orders.' };
  assert.deepStrictEqual(TS.mintProblems(flat, ctx()), []);
  assert.deepStrictEqual(reasons({ ...flat, source: 'nope' }), ['source_not_in_page']);
});

test('unknown_screen: no spec for the screen, and the locator checks are skipped', () => {
  const p = TS.mintProblems(rec({ screen: 'nowhere' }), ctx());
  assert.deepStrictEqual(p.map(x => x.reason), ['unknown_screen']);
  assert.match(p[0].message, /nowhere/);
});

test('locator_not_in_spec names the step and the locator; placements and transition locators both count', () => {
  const p = TS.mintProblems(rec({ steps: [{ fill: { role: 'textbox', name: 'Match' }, value: '{match}' }, { click: { role: 'button', name: 'Submit' } }] }), ctx());
  assert.deepStrictEqual(p.map(x => x.reason), ['locator_not_in_spec']);
  assert.match(p[0].message, /steps\[1\].*button "Submit"/);
  assert.deepStrictEqual(reasons(rec({ steps: [{ click: { role: 'button', name: 'Tag orders' } }, { click: { role: 'button', name: 'Refresh' } }] })), []);
});

test('unknown_operation: not pinned; and a duplicated operationId names the files', () => {
  const p = TS.mintProblems(rec({ effect: { operation: 'untagOrders' } }), ctx());
  assert.deepStrictEqual(p.map(x => x.reason), ['unknown_operation']);
  assert.match(p[0].message, /untagOrders/);
  const files = { 'contracts/openapi/a.yaml': API, 'contracts/openapi/b.yaml': API };
  const dup = TS.mintProblems(rec(), ctx({ resolveOperation: id => Core.resolveOperation(reg(files), id), operationErrors: Core.operations(reg(files)).errors }));
  assert.deepStrictEqual(dup.map(x => x.reason), ['unknown_operation']);
  assert.match(dup[0].message, /more than once \(in contracts\/openapi\/a\.yaml, contracts\/openapi\/b\.yaml\)/);
});

test('commit_without_examples: clicking a commits transition needs examples; a non-committing click does not', () => {
  assert.deepStrictEqual(reasons(rec({ examples: [], effect: { operation: 'tagOrders' }, steps: [{ click: { role: 'button', name: 'Apply' } }] })), ['commit_without_examples']);
  assert.deepStrictEqual(reasons(rec({ examples: undefined, effect: { operation: 'tagOrders' }, steps: [{ click: { role: 'button', name: 'Apply' } }] })), ['commit_without_examples']);
  assert.deepStrictEqual(reasons(rec({ examples: undefined, effect: { operation: 'tagOrders' }, steps: [{ click: { role: 'button', name: 'Refresh' } }] })), []);
});

test('unfilled_placeholder: names the placeholder and the example, in a step value or in effect.body', () => {
  const p = TS.mintProblems(rec({ examples: [{ match: 'A' }, { other: 1 }], effect: { operation: 'tagOrders', body: { match: '{match}', tag: { label: '{label}' } } } }), ctx());
  assert.deepStrictEqual(p.map(x => x.reason), ['unfilled_placeholder', 'unfilled_placeholder', 'unfilled_placeholder']);
  assert.deepStrictEqual(p.map(x => x.message.match(/examples\[(\d)\].*\{(\w+)\}/).slice(1)), [['1', 'match'], ['0', 'label'], ['1', 'label']]);
});

test('bindProblem: open questions block, then an invalid record; otherwise null', () => {
  assert.strictEqual(TS.bindProblem(rec()), null);
  assert.strictEqual(TS.bindProblem(rec({ questions: ['Prefix or contains?'] })), '1 open question: answer them first');
  assert.strictEqual(TS.bindProblem(rec({ questions: ['a', 'b'] })), '2 open questions: answer them first');
  assert.match(TS.bindProblem(rec({ steps: [] })), /^steps: a non-empty list/);
  assert.strictEqual(TS.bindProblem(rec({ questions: [] })), null);
});
