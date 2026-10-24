'use strict';
// The recorder over the fixture adapter: no browser. Steps, params, picking by position, and could-not-run.
const test = require('node:test');
const assert = require('node:assert');
const R = require('../recorder/index.js');
const Fixture = require('../recorder/adapters/fixture.js');

const btn = (name, extra = {}) => ({ role: 'button', name, box: null, children: [], ...extra });
const app = {
  start: 'list',
  paths: { '/tags': 'list' },
  screens: {
    list: { role: 'RootWebArea', name: 'Tags', box: null, children: [
      { role: 'textbox', name: 'Program', box: null, children: [] },
      { role: 'row', name: 'Alpha', box: null, children: [btn('Edit')] },
      { role: 'row', name: 'Beta', box: null, children: [btn('Edit')] },
      btn('Bulk apply'),
      btn('Export', { disabled: true }),
    ] },
    dialog: { role: 'RootWebArea', name: 'Tags', box: null, children: [
      { role: 'dialog', name: 'Apply tag', box: null, children: [btn('Apply'), btn('Cancel')] },
    ] },
    editBeta: { role: 'RootWebArea', name: 'Edit Beta', box: null, children: [] },
  },
  on: [
    { screen: 'list', click: { role: 'button', name: 'Bulk apply' }, go: 'dialog' },
    { screen: 'list', click: { role: 'button', name: 'Edit', index: 1 }, go: 'editBeta' },
  ],
};
const adapter = Fixture.create(app);
const run = (steps, params = {}) => R.record({ scenario: { id: 's', steps }, side: 'legacy', adapter, params });

test('each step is acted on and captured', async () => {
  const r = await run([{ goto: { path: '/tags' } }, { click: { role: 'button', name: 'Bulk apply' } }]);
  assert.deepStrictEqual(r.steps.map(s => s.status), ['ok', 'ok']);
  assert.strictEqual(r.steps[1].capture.tree.children[0].role, 'dialog');
  assert.strictEqual(r.adapter, 'fixture');
});

test('index picks a record by position', async () => {
  const r = await run([{ click: { role: 'button', name: 'Edit', index: 1 } }]);
  assert.strictEqual(r.steps[0].capture.url, 'editBeta');
});

test('a value can come from the side\'s params', async () => {
  const r = await run([{ fill: { role: 'textbox', name: 'Program', value: { param: 'program' } } }], { program: '54027' });
  assert.strictEqual(r.steps[0].capture.tree.children[0].value, '54027');
});

test('a missing element or param is could not run, and so is every later step', async () => {
  const r = await run([{ click: { role: 'button', name: 'Bulk apply now' } }, { click: { role: 'button', name: 'Apply' } }]);
  assert.deepStrictEqual(r.steps.map(s => s.status), ['could_not_run', 'could_not_run']);
  assert.match(r.steps[0].reason, /no button named "Bulk apply now"/);
  assert.match(r.steps[1].reason, /step 1/);
  const p = await run([{ fill: { role: 'textbox', name: 'Program', value: { param: 'program' } } }]);
  assert.match(p.steps[0].reason, /legacy has no param program/);
});

test('an action that fails is an error, not could not run', async () => {
  const r = await run([{ click: { role: 'button', name: 'Export' } }]);
  assert.strictEqual(r.steps[0].status, 'error');
  assert.match(r.steps[0].reason, /disabled/);
});

test('a malformed scenario is refused before anything opens', async () => {
  assert.match((await run([{ click: { name: 'x' } }])).error, /step 1: click needs a role/);
  assert.match((await run([{ click: {}, fill: {} }])).error, /exactly one/);
  assert.deepStrictEqual(R.scenarioProblems({ id: 'x', steps: [{ fill: { role: 'textbox', name: 'A' } }] }), ['step 1: fill needs a value']);
});

test('a click that would commit is blocked unless writes are allowed, and later steps could not run', async () => {
  const steps = [{ click: { role: 'button', name: 'Bulk apply' } }, { click: { role: 'button', name: 'Apply' } }, { click: { role: 'button', name: 'Cancel' } }];
  const r = await run(steps);
  assert.deepStrictEqual(r.steps.map(s => s.status), ['ok', 'blocked', 'could_not_run']);
  const ok = await R.record({ scenario: { id: 's', steps }, side: 'legacy', adapter, allowWrites: true });
  assert.deepStrictEqual(ok.steps.map(s => s.status), ['ok', 'ok', 'ok']);
  for (const n of ['Apply', 'Save changes', 'Delete program']) assert.ok(R.COMMITS.test(n), n);
  for (const n of ['Bulk apply', 'Applications', 'Search']) assert.ok(!R.COMMITS.test(n), n);
});
