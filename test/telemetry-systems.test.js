const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Ledger = require('../renderer/ledger.js');

const run = (system, tokens, cost, outcome = 'passed') => ({ system, tokens, cost, outcome });

test('pipelineRuns drops Designc\'s own systems and keeps tagged-other and untagged runs', () => {
  const runs = [run('S1', 1, 1), run('S4', 2, 2), run('factory', 4, 4), run(undefined, 8, 8), run(null, 16, 16)];
  assert.deepEqual(Ledger.pipelineRuns(runs).map(r => r.tokens), [4, 8, 16]);
});

test('runTotals sums tokens and cost over the same runs it is given', () => {
  const runs = Ledger.pipelineRuns([run('S1', 100, 9), run('x', 10, 0.5), run('x', 20, 0.25, 'failed')]);
  assert.deepEqual(Ledger.runTotals(runs), { runs: 2, tokens: 30, cost: 0.75, failed: 1 });
});

test('OWN_SYSTEMS equals the systems of agent.js ROLES', () => {
  const src = fs.readFileSync(path.join(__dirname, '../renderer/agent.js'), 'utf8');
  const systems = [...new Set([...src.matchAll(/system: '([A-Za-z0-9]+)', allow:/g)].map(m => m[1]))].sort();
  assert.ok(systems.length > 0);
  assert.deepEqual([...Ledger.OWN_SYSTEMS].sort(), systems);
});

test('STAGES keys in app.js equal Ledger.CAUGHT_BY', () => {
  const src = fs.readFileSync(path.join(__dirname, '../renderer/app.js'), 'utf8');
  const line = src.split('\n').find(l => l.startsWith('const STAGES = '));
  const keys = [...line.matchAll(/\['([^']+)',/g)].map(m => m[1]);
  assert.deepEqual(keys, Ledger.CAUGHT_BY);
});
