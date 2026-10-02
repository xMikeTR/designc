const { test } = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../renderer/core.js');
const Ledger = require('../renderer/ledger.js');

const av = (a) => (a == null ? '' : `properties { "d.availability" "${a}" }`);
const model = (a, b, c) => Core.parse(`workspace {
 model {
  sys = softwareSystem "Pricing" {
   api = container "Pricing API" "" "C#" { ${av(a)} }
   db = container "Quotes DB" "" "SQL" { ${av(b)} }
   q = container "Queue" "" "SB" { ${av(c)} }
  }
  api -> db "x" "t" { properties { "d.interaction" "sync" } }
  api -> q "x" "t" { properties { "d.interaction" "async" } }
 }
}`);
const sc = (o = {}) => ({ id: 'QAS-1', title: 'Quote stays up', attribute: 'availability', artifact: 'Pricing API',
  stimulus: 'Quotes DB restarts', response: 'quotes still answer', measure: { metric: 'availability', op: '>=', value: 99.5, unit: '%' }, ...o });
const report = (m, scenarios, ledger = []) => Core.scenarioReport({ model: m, scenarios, ledger });

test('availability is the product over the artifact and its sync dependencies; async ones are excluded', () => {
  const r = report(model(0.999, 0.999, 0.5), [sc()])[0];
  assert.equal(r.analytic.status, 'met');
  assert.equal(Math.round(r.analytic.value * 1000) / 1000, 99.8);
  assert.equal(report(model(0.999, 0.99, 0.5), [sc({ measure: { metric: 'availability', op: '>=', value: 99.9, unit: '%' } })])[0].analytic.status, 'not-met');
});

test('a missing d.availability makes the analytic result unknown and names the element', () => {
  const r = report(model(0.999, null, null), [sc()])[0];
  assert.equal(r.analytic.status, 'unknown');
  assert.deepEqual(r.analytic.missing, ['Quotes DB']);
});

test('an unresolved artifact is reported, other attributes have no analytic check', () => {
  assert.equal(report(model(1, 1, 1), [sc({ artifact: 'Nope' })])[0].status, 'unresolved');
  const lat = report(model(1, 1, 1), [sc({ attribute: 'latency', measure: { metric: 'p95', op: '<=', value: 300, unit: 'ms' } })])[0];
  assert.equal(lat.analytic.status, 'n/a');
});

test('fitness status comes from the latest fitness event for the scenario', () => {
  const m = model(1, 1, 1), s = sc({ fitness: ['npm run perf'] });
  assert.equal(report(m, [s])[0].fitness.status, 'unchecked');
  assert.equal(report(m, [sc()])[0].fitness.status, 'none');
  const led = [{ kind: 'fitness', scenario: 'QAS-1', outcome: 'fail', _ts: 1 }, { kind: 'fitness', scenario: 'QAS-1', outcome: 'pass', _ts: 2 }];
  assert.equal(report(m, [s], led)[0].fitness.status, 'passing');
  assert.equal(report(m, [s], led.slice(0, 1))[0].fitness.status, 'failing');
});

test('gate: unresolved, not-met and failing fitness block; unknown and unchecked do not', () => {
  const g = (m, scenarios, ledger = []) => Core.gate({ model: m, diags: [], decisions: [], requirements: [], ledger, scenarios });
  const text = r => r.clauses.map(c => c.text).join('\n');
  assert.equal(g(model(0.999, 0.999, 1), [sc()]).ready, true);
  assert.equal(g(model(0.999, null, 1), [sc({ fitness: ['x'] })]).ready, true);
  assert.match(text(g(model(1, 1, 1), [sc({ artifact: 'Nope' })])), /QAS-1: artifact "Nope" is not in the model/);
  assert.match(text(g(model(0.99, 0.99, 1), [sc()])), /QAS-1 is not met: availability ≈ 98\.01% against ≥ 99\.5%/);
  assert.match(text(g(model(1, 1, 1), [sc({ fitness: ['x'] })], [{ kind: 'fitness', scenario: 'QAS-1', outcome: 'fail', _ts: 1 }])), /QAS-1: fitness function failing/);
});

test('gate: a scenario that is not a mapping or lacks an id, artifact or measure is a clause', () => {
  const r = Core.gate({ model: model(1, 1, 1), diags: [], decisions: [], requirements: [], ledger: [], scenarios: [{ id: 'QAS-2', title: 't' }] });
  assert.match(r.clauses.map(c => c.text).join('\n'), /QAS-2 needs artifact, attribute and measure/);
});

test('ledger: fitness is a checks-stream kind; a failure needs exit_code or reason', () => {
  assert.equal(Ledger.KINDS.fitness.stream, 'checks.jsonl');
  const ev = { schema_version: 1, event_id: 'e1', ts: 1, kind: 'fitness', by: 'mike', scenario: 'QAS-1', check: 'npm run perf', outcome: 'pass', source: 'local' };
  assert.deepEqual(Ledger.validate(ev), []);
  assert.equal(Ledger.validate({ ...ev, outcome: 'fail' }).length, 1);
  assert.deepEqual(Ledger.validate({ ...ev, outcome: 'fail', exit_code: 1 }), []);
});
