// Gate clause unpinned_contract: a requirement whose elements span more than one declared repo is not ready until an
// OpenAPI contract (contracts/openapi/*.yaml) is pinned. With no repos declared nothing changes.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../renderer/core.js');

const DSL = `workspace { model { s = softwareSystem "S" {
  api = container "Api" { properties { "d.repo" "Api" "d.code" "src/**" "d.risk" "low" } }
  ui = container "Web" { properties { "d.repo" "Ui" "d.code" "web/**" "d.risk" "low" } }
  ui2 = container "Admin" { properties { "d.repo" "Ui" "d.code" "admin/**" "d.risk" "low" } }
} } }`;
const REPOS = { Api: '../api', Ui: '../ui' };
const gate = (requirements, extra = {}) => {
  const model = Core.parse(DSL);
  return Core.gate({ model, diags: [], decisions: [], requirements, ledger: [], ...extra });
};
const kinds = g => g.clauses.filter(c => c.kind === 'unpinned_contract');
const REQ = (id, elements) => ({ id, elements });

test('no repos declared: never raised', () => {
  assert.deepEqual(kinds(gate([REQ('REQ-1', ['Api', 'Web'])])), []);
});

test('a requirement across two repos with no contract pinned is raised, naming the repos', () => {
  const cs = kinds(gate([REQ('REQ-1', ['Api', 'Web'])], { repos: REPOS, apiContracts: [] }));
  assert.equal(cs.length, 1);
  assert.equal(cs[0].requirement, 'REQ-1');
  assert.deepEqual(cs[0].about, ['Api', 'Web']);
  assert.match(cs[0].text, /Api, Ui/);
});

test('a pinned contract clears it', () => {
  assert.deepEqual(kinds(gate([REQ('REQ-1', ['Api', 'Web'])], { repos: REPOS, apiContracts: ['contracts/openapi/pricing.yaml'] })), []);
});

test('a requirement inside one repo is not raised', () => {
  assert.deepEqual(kinds(gate([REQ('REQ-1', ['Web', 'Admin']), REQ('REQ-2', ['Api'])], { repos: REPOS, apiContracts: [] })), []);
});

test('scoped gate keeps the clause for an item that touches one of its elements, drops it otherwise', () => {
  const model = Core.parse(DSL);
  const g = gate([REQ('REQ-1', ['Api', 'Web'])], { repos: REPOS, apiContracts: [] });
  const decisions = [];
  assert.equal(Core.scopedGate(g, { model, elements: ['Web'], requirement: 'REQ-1', decisions }).clauses.filter(c => c.kind === 'unpinned_contract').length, 1);
  assert.equal(Core.scopedGate(g, { model, elements: ['Admin'], requirement: 'REQ-1', decisions }).clauses.filter(c => c.kind === 'unpinned_contract').length, 0);
});

test('the clause kind is a known gate kind in the records schema (JS)', () => {
  assert.ok(require('../renderer/records.js').GATE_KINDS.includes('unpinned_contract'));
});
