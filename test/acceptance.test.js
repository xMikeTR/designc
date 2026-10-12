const { test } = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../renderer/core.js');

// Slice 27: UI acceptance criteria and the gate clauses they add.
const dsl = (tags = '"UI"') => `workspace "Quotes" {
  model {
    broker = person "Broker"
    s = softwareSystem "Quotes" {
      ui = container "Quote UI" "" "React" ${tags}
      api = container "Quotes API" "" "C#"
    }
    broker -> ui "Uses" "HTTPS" {
      properties {
        d.authenticated "yes"
      }
    }
    ui -> api "Calls" "HTTPS"
  }
}`;
const req = [{ id: 'R-1', elements: ['Quote UI'] }];
const cases = states => states.map(state => ({ state, given: `g ${state}`, then: `t ${state}` }));
const ac = (o = {}) => ({ id: 'AC-1', requirement: 'R-1', element: 'Quotes/Quote UI', states: ['ready', 'loading', 'empty', 'error', 'forbidden'],
  cases: cases(['ready', 'loading', 'empty', 'error', 'forbidden']), ...o });
const run = (o = {}) => Core.acceptanceClauses({ model: Core.parse(o.dsl || dsl()), acceptance: o.acceptance || [], requirements: o.requirements || req, decisions: o.decisions || [] });
const texts = r => r.map(c => c.text);

test('a UI element with no criterion is a clause naming the element', () => {
  const r = run();
  assert.equal(r.length, 1);
  assert.match(r[0].text, /R-1: Quote UI is a UI element with no acceptance criterion/);
  assert.deepEqual(r[0].about, ['Quote UI']);
  assert.equal(r[0].kind, 'acceptance');
});

test('a complete criterion clears it', () => {
  assert.deepEqual(run({ acceptance: [ac()] }), []);
});

test('a requirement with no UI element needs nothing', () => {
  assert.deepEqual(run({ dsl: dsl(''), }), []);
});

test('a missing state is named', () => {
  const r = run({ acceptance: [ac({ cases: cases(['ready', 'loading', 'error', 'forbidden']) })] });
  assert.deepEqual(texts(r), ['AC-1: no case for state empty']);
});

test('forbidden is required only behind an auth boundary, or when the criterion lists it', () => {
  const four = ['ready', 'loading', 'empty', 'error'];
  // The broker reaches the UI with d.authenticated yes: forbidden is required even if states omits it.
  assert.deepEqual(texts(run({ acceptance: [ac({ states: four, cases: cases(four) })] })), ['AC-1: no case for state forbidden']);
  // No auth boundary: four states are enough...
  const open = dsl().replace('d.authenticated "yes"', 'd.interaction "sync"');
  assert.deepEqual(run({ dsl: open, acceptance: [ac({ states: four, cases: cases(four) })] }), []);
  // ...unless the criterion itself lists forbidden.
  assert.deepEqual(texts(run({ dsl: open, acceptance: [ac({ states: [...four, 'forbidden'], cases: cases(four) })] })), ['AC-1: no case for state forbidden']);
});

test('malformed criteria say what to fix', () => {
  assert.ok(texts(run({ acceptance: [ac({ requirement: 'R-9' })] })).some(t => /requirement R-9 is not in the registry/.test(t)));
  assert.ok(texts(run({ acceptance: [ac({ element: 'Nope' })] })).some(t => /element "Nope" is not in the model/.test(t)));
  assert.ok(texts(run({ acceptance: [ac({ states: ['ready', 'sleepy'] })] })).some(t => /unknown state "sleepy"/.test(t)));
  assert.ok(texts(run({ acceptance: [ac({ cases: [{ state: 'ready', given: 'g' }, ...cases(['loading', 'empty', 'error', 'forbidden'])] })] })).some(t => /case for ready needs given and then/.test(t)));
  assert.ok(texts(run({ acceptance: [ac({ decision: 'D-9' })] })).some(t => /decision D-9 is not in the registry/.test(t)));
  assert.ok(texts(run({ acceptance: [{ id: 'AC-2' }] })).some(t => /AC-2: needs requirement, element, states and cases/.test(t)));
});

test('the gate carries the clauses, and a scoped gate keeps them for in-scope elements only', () => {
  const model = Core.parse(dsl());
  const g = Core.gate({ model, diags: [], decisions: [], requirements: req, ledger: [], acceptance: [] });
  assert.ok(g.clauses.some(c => c.kind === 'acceptance'));
  const inScope = Core.scopedGate(g, { model, elements: ['Quote UI'], requirement: 'R-1', decisions: [] });
  assert.ok(inScope.clauses.some(c => c.kind === 'acceptance'));
  const other = Core.scopedGate(g, { model, elements: ['Quotes API'], requirement: 'R-2', decisions: [] });
  assert.ok(!other.clauses.some(c => c.kind === 'acceptance'));
});

test('locators: every name a case uses is declared, with a role from the closed list', () => {
  const model = Core.parse('workspace "Q" {\n  model {\n    s = softwareSystem "Quotes" {\n      ui = container "Quote UI" {\n        tags "UI"\n      }\n    }\n  }\n}\n');
  const cases = ['ready', 'loading', 'empty', 'error'].map(state => ({ state, given: 'a', then: 'b' }));
  const run = (locators, uses) => Core.acceptanceClauses({ model, requirements: [{ id: 'R-1', elements: ['Quote UI'] }], decisions: [],
    acceptance: [{ id: 'AC-1', requirement: 'R-1', element: 'Quotes/Quote UI', states: ['ready'], locators, cases: cases.map((c, i) => i ? c : { ...c, uses }) }] }).map(c => c.text);
  assert.deepEqual(run({ save: { role: 'button', name: 'Save' } }, ['save']), []);
  assert.deepEqual(run({}, ['save']), ['AC-1: case for ready uses locator "save" that is not declared']);
  assert.match(run({ x: { role: 'widget', name: 'X' } }, [])[0], /locator "x" has role "widget"/);
  assert.match(run({ x: { role: 'link' } }, [])[0], /locator "x" needs a role and an accessible name/);
});
