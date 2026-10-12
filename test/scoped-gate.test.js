const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Core = require('../renderer/core.js');

// Slice 24: the gate as one work item sees it, and the item handover.
const dsl = `workspace "Quotes" {
  model {
    s = softwareSystem "Quotes" {
      api = container "Quotes API" "" "C#" {
        properties { d.code "src/Api/**"
          d.risk medium }
      }
      db = container "Quotes DB"
      mail = container "Mail" {
        properties { d.code "src/Mail/**"
          d.risk low }
      }
    }
    api -> db "writes" { properties { d.interaction sync } }
  }
}`;
const model = Core.parse(dsl);
const decision = (id, binds, o = {}) => ({ id, status: 'minted', effect: 'fix', binds, statement: id, ...o });

test('scopedGate keeps model-wide clauses and clauses that touch an item element', () => {
  const g = { ready: false, clauses: [
    { kind: 'parse', text: 'p' },
    { kind: 'decision', text: 'D-1 is minted, not bound', decision: 'D-1' },
    { kind: 'decision', text: 'D-2 is minted, not bound', decision: 'D-2' },
    { kind: 'finding', text: 'DC002 on Quotes DB', about: ['Quotes DB'] },
    { kind: 'finding', text: 'DC003 on Mail', about: ['Mail'] },
    { kind: 'requirement', text: 'R-1 untraced', requirement: 'R-1' },
    { kind: 'requirement', text: 'R-2 untraced', requirement: 'R-2' },
    { kind: 'needs', text: 'open ask', needs: { id: 'n1', element: 'Quotes/Quotes API' }, about: ['Quotes/Quotes API'] },
    { kind: 'scenario', text: 'S-1 malformed' },
  ] };
  const r = Core.scopedGate(g, { model, elements: ['Quotes API', 'Quotes DB'], requirement: 'R-1', decisions: [decision('D-1', ['Quotes DB']), decision('D-2', ['Mail'])] });
  assert.deepEqual(r.clauses.map(c => c.text), ['p', 'D-1 is minted, not bound', 'DC002 on Quotes DB', 'R-1 untraced', 'open ask', 'S-1 malformed']);
  assert.equal(r.outside, 3);
  assert.equal(r.ready, false);
});

test('scopedGate is ready when only other elements block', () => {
  const g = { ready: false, clauses: [{ kind: 'finding', text: 'DC003 on Mail', about: ['Mail'] }] };
  const r = Core.scopedGate(g, { model, elements: ['Quotes API'], requirement: 'R-1', decisions: [] });
  assert.equal(r.ready, true);
  assert.equal(r.outside, 1);
});

test('Core.gate tags clauses with the elements they are about', () => {
  const diags = Core.check(model, {});
  const g = Core.gate({ model, diags, decisions: [], requirements: [], ledger: [{ kind: 'needs_decision', status: 'open', id: 'n1', question: 'q', element: 'Mail' }] });
  assert.deepEqual(g.clauses.find(c => c.kind === 'needs').about, ['Mail']);
  for (const c of g.clauses.filter(c => c.kind === 'finding')) assert.ok(Array.isArray(c.about) && c.about.length, c.text);
});

const item = { id: 'W-quote', elements: ['Quotes API'], requirement: 'R-1' };
const base = { date: '2026-10-12', now: 'n', by: 'u', model: { path: 'model/workspace.dsl', text: dsl } };

test('item handover: elements.json marks in_scope and uses schema /2; handover.yaml pins design_version', () => {
  const plan = Core.handoverPlan({ ...base, item });
  const el = JSON.parse(plan.files.find(f => f.path.endsWith('elements.json')).text);
  assert.equal(el.schema, 'designc.handover.elements/2');
  assert.deepEqual(el.elements.map(e => [e.name, e.in_scope]), [['Quotes', false], ['Quotes API', true], ['Quotes DB', false], ['Mail', false]]);
  const head = plan.files[0].text;
  assert.match(head, /^work_item: "W-quote"$/m);
  assert.match(head, /^design_version: r-\w+$/m);
  assert.match(head, /^in_scope: \["Quotes API"\]$/m);
});

test('item handover: the id covers the work item, and a whole-model handover is unchanged', () => {
  const a = Core.handoverPlan({ ...base, item }), b = Core.handoverPlan({ ...base, item: { ...item, id: 'W-other' } }), whole = Core.handoverPlan(base);
  assert.notEqual(a.id, b.id);
  assert.notEqual(a.id, whole.id);
  const el = JSON.parse(whole.files.find(f => f.path.endsWith('elements.json')).text);
  assert.equal(el.schema, 'designc.handover.elements/1');
  assert.ok(!whole.files[0].text.includes('work_item'));
});

test('the /2 example in docs is what handoverElements writes', () => {
  const ex = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'docs', 'handover-elements-2.example.json'), 'utf8'));
  assert.deepEqual(ex, Core.handoverElements(dsl, [], ['Quotes API']));
  const schema = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'docs', 'handover-elements-2.schema.json'), 'utf8'));
  assert.equal(schema.$id, 'designc.handover.elements/2');
});
