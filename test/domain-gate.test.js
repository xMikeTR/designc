const { test } = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../renderer/core.js');

const PACK = 'id: pricing\naggregates:\n  Quote:\n    id: QuoteId\n    fields: { limit: money }\n';
const DSL = `workspace {
  model {
    s = softwareSystem "Pricing" {
      api = container "Quotes API" { properties { "d.owns" "Quote" } }
      w = container "Worker" { properties { "d.owns" "Qoute" } }
    }
  }
}`;
const m = Core.parse(DSL);
const gate = (domains, ledger = []) => Core.gate({ model: m, diags: [], decisions: [], requirements: [], ledger, domains });

test('gate: without domains the result is unchanged and carries no notes', () => {
  const g = gate(null);
  assert.equal(g.notes, undefined);
});
test('gate: domain clauses join the gate when packs are listed', () => {
  const g = gate({ listed: ['pricing'], packs: [{ key: 'pricing', path: 'domain/pricing.yaml', text: PACK }] });
  assert.ok(g.clauses.some(c => c.kind === 'domain' && /not pinned/.test(c.text)));
  assert.ok(g.clauses.some(c => c.kind === 'domain' && /Worker owns "Qoute".*pricing\/Quote/.test(c.text)));
  assert.equal(g.ready, false);
  assert.deepEqual(g.notes, []);
});
test('GATE_INPUTS includes domain', () => assert.ok(Core.GATE_INPUTS.includes('domain')));
