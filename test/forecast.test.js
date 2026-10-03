// Slice 17: Core.forecast prices the elements a handover changes from their recorded spend history.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../renderer/core.js');

const dsl = ({ api = '', db = '', extra = '', rel = '' } = {}) => `workspace { model {
  s = softwareSystem "S" {
    api = container "Api" "" "" { properties { "d.instances" "2" ${api} } }
    db = container "Db" "" "" { properties { ${db} } }
    ${extra}
  }
  api -> db "reads" "SQL" { properties { ${rel} } }
} }`;
const parse = t => { const m = Core.parse(t); assert.deepEqual(m.errors, []); return m; };
const hist = (...tokens) => tokens.map((t, i) => ({ handover: `H-${i + 1}`, tokens: t, cost: t / 100 }));
const row = (f, name) => f.rows.find(r => r.name === name);

test('an element with 3 or more handovers of history is measured: median expected, nearest-rank p90 high', () => {
  const m = parse(dsl());
  const f = Core.forecast({ before: null, after: m, history: new Map([['Api', hist(100, 300, 200, 1000, 400)], ['Db', hist(10, 20, 30)]]) });
  const api = row(f, 'Api');
  assert.equal(api.status, 'measured');
  assert.equal(api.samples, 5);
  assert.equal(api.expected.tokens, 300);
  assert.equal(api.high.tokens, 1000);
  assert.equal(api.expected.cost, 3);
  assert.equal(row(f, 'Db').expected.tokens, 20);
  assert.equal(f.total.expected.tokens, 320);
  assert.equal(f.total.high.tokens, 1030);
  assert.deepEqual(f.coverage, { priced: 2, changed: 2 });
});

test('an even number of samples takes the mean of the two middle figures', () => {
  const f = Core.forecast({ before: null, after: parse(dsl()), history: new Map([['Api', hist(100, 200, 300, 400)]]) });
  assert.equal(row(f, 'Api').expected.tokens, 250);
});

test('fewer than the minimum is "no basis" and adds nothing to the total', () => {
  const f = Core.forecast({ before: null, after: parse(dsl()), history: new Map([['Api', hist(100, 200)]]) });
  assert.equal(row(f, 'Api').status, 'no basis');
  assert.equal(row(f, 'Api').expected, null);
  assert.equal(f.total.expected.tokens, 0);
  assert.deepEqual(f.coverage, { priced: 0, changed: 2 });
  const g = Core.forecast({ before: null, after: parse(dsl()), history: new Map([['Api', hist(100, 200)]]), minSamples: 2 });
  assert.equal(row(g, 'Api').status, 'measured');
});

test('only changed elements are priced; against a previous handover an untouched element is left out', () => {
  const before = parse(dsl());
  const same = Core.forecast({ before, after: parse(dsl()), history: new Map() });
  assert.deepEqual(same.rows, []);
  const changed = Core.forecast({ before, after: parse(dsl({ api: '"d.retry" "none"' })), history: new Map() });
  assert.deepEqual(changed.rows.map(r => [r.name, r.why]), [['Api', 'changed']]);
});

test('an added element is priced; a removed one is listed and not priced', () => {
  const before = parse(dsl({ extra: 'old = container "Old" "" ""' }));
  const after = parse(dsl({ extra: 'fresh = container "Fresh" "" ""' }));
  const f = Core.forecast({ before, after, history: new Map() });
  assert.deepEqual(f.rows.map(r => [r.name, r.why]), [['Fresh', 'added']]);
  assert.deepEqual(f.removed, ['Old']);
});

test('a changed relationship prices both of its ends', () => {
  const f = Core.forecast({ before: parse(dsl()), after: parse(dsl({ rel: '"d.timeout" "500"' })), history: new Map() });
  assert.deepEqual(f.rows.map(r => [r.name, r.why]), [['Api', 'relationship'], ['Db', 'relationship']]);
});

test('only containers and components are priced, not systems or people', () => {
  const f = Core.forecast({ before: null, after: parse(dsl()), history: new Map() });
  assert.deepEqual(f.rows.map(r => r.name), ['Api', 'Db']);
});

// ---- frozen into the handover, and the summary leadership reads ----
const jsyaml = require('js-yaml');
const handoverInputs = (f = {}) => ({ date: '2026-10-03', now: '2026-10-03T10:00:00Z', by: 'me', model: { path: 'model/workspace.dsl', text: dsl() }, requirements: [], decisions: [], ...f });
const frozen = () => Core.freezeForecast(Core.forecast({ before: null, after: parse(dsl()), history: new Map([['Api', hist(100, 300, 200)]]) }), { currency: 'GBP', baseline: null });

test('a forecast is written to handover.yaml and does not change the handover id', () => {
  const plain = Core.handoverPlan(handoverInputs());
  const withF = Core.handoverPlan(handoverInputs({ forecast: frozen() }));
  assert.equal(withF.id, plain.id);
  const y = jsyaml.load(withF.files[0].text);
  assert.equal(y.forecast.currency, 'GBP');
  assert.deepEqual(y.forecast.tokens, { expected: 200, high: 300 });
  assert.deepEqual(y.forecast.coverage, { priced: 1, changed: 2 });
  assert.deepEqual(y.forecast.elements.map(e => [e.name, e.status]), [['Api', 'measured'], ['Db', 'no basis']]);
  assert.equal(jsyaml.load(plain.files[0].text).forecast, undefined);
});

test('forecastSummary states forecast, range, coverage, actual and difference in plain text', () => {
  const f = frozen();
  const text = Core.forecastSummary({ id: '20261003-ab12cd34', created: '2026-10-03T10:00:00Z', requirements: ['HRE-1', 'HRE-2'], forecast: f, actual: { tokens: 250, cost: 2.5, tasks: 4, closed: null, afterClose: 0 } });
  assert.match(text, /^Handover 20261003-ab12cd34 \(2026-10-03\)/);
  assert.match(text, /Requirements: HRE-1, HRE-2/);
  assert.match(text, /Forecast: 200 tokens, GBP 2\.00 \(up to 300 tokens, GBP 3\.00\)/);
  assert.match(text, /Covers 1 of 2 changed elements; 1 has no history yet/);
  assert.match(text, /Actual so far \(in progress\): 250 tokens, GBP 2\.50 across 4 tasks/);
  assert.match(text, /Difference: \+50 tokens \(\+25%\), \+GBP 0\.50/);
});

test('forecastSummary copes with a closed handover, no actuals and no forecast', () => {
  const f = frozen();
  assert.match(Core.forecastSummary({ id: 'H', created: '2026-10-03', forecast: f, actual: { tokens: 150, cost: 1.5, tasks: 2, closed: 'delivered', afterClose: 1 } }), /Actual \(delivered\): 150 tokens, GBP 1\.50 across 2 tasks[\s\S]*Difference: -50 tokens \(-25%\), -GBP 0\.50[\s\S]*1 task recorded after close/);
  assert.match(Core.forecastSummary({ id: 'H', created: '2026-10-03', forecast: f, actual: null }), /Actual: none recorded yet/);
  assert.match(Core.forecastSummary({ id: 'H', created: '2026-10-03', forecast: null, actual: null }), /Forecast: not recorded/);
});
