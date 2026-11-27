'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Problems = require('../renderer/problems.js');
const Core = require('../renderer/core.js');

const model = { errors: [] };
const base = { model, diags: [], cfgModel: 'model/workspace.dsl' };
const fp = [{ path: 'features/orders-bad.yaml', line: 1, code: 'FM002', msg: 'orders-bad: step 1 names state "ghost".' }, { path: 'features/orders-bad.yaml', line: 1, code: 'yaml', msg: 'x does not parse' }, { path: 'features/other.yaml', line: 3, code: 'FM001', msg: 'other: no title' }];

test('featureProblems become error rows under their path with their own code', () => {
  const g = Problems.rows({ ...base, featureProblems: fp });
  assert.deepEqual(g, [
    ['features/orders-bad.yaml', [{ sev: 'error', msg: fp[0].msg, code: 'FM002', line: 1 }, { sev: 'error', msg: fp[1].msg, code: 'yaml', line: 1 }]],
    ['features/other.yaml', [{ sev: 'error', msg: fp[2].msg, code: 'FM001', line: 3 }]],
  ]);
  assert.deepEqual(Problems.counts(g), { errors: 3, warnings: 0 });
});

test('featureProblems come after work warnings and before duplicate proposal ids, in the same path group', () => {
  const g = Problems.rows({ ...base, workWarnings: [{ path: 'features/orders-bad.yaml', msg: 'warn', code: 'x' }], proposals: [{ id: 'P', _path: 'features/orders-bad.yaml' }, { id: 'P', _path: 'features/orders-bad.yaml' }], featureProblems: [fp[0]] });
  assert.deepEqual(g[0][1].map(r => r.code), ['work', 'FM002', 'id']);
});

test('without featureProblems the output is what it was', () => {
  const args = { ...base, yamlErrors: [{ path: 'a.yaml', line: 2, msg: 'bad' }], workWarnings: [{ path: 'w.yaml', msg: 'warn' }], proposals: [] };
  assert.deepEqual(Problems.rows(args), Problems.rows({ ...args, featureProblems: [] }));
  assert.deepEqual(Problems.rows(args), Problems.rows({ ...args, featureProblems: undefined }));
});

test('features is a gate input (a dirty feature file blocks a freeze), and a look-alike name is not', () => {
  assert.ok(Core.GATE_INPUTS.includes('features'));
  assert.ok(Core.GATE_INPUTS.indexOf('features') < Core.GATE_INPUTS.indexOf('designc.json'));
  assert.deepEqual(Core.dirtyInputs([{ path: 'features/x.yaml' }, { path: 'features-notes.md' }], {}), ['features/x.yaml']);
});
