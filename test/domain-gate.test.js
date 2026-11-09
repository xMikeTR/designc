const { test } = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../renderer/core.js');

const PACK = 'id: fares\naggregates:\n  Booking:\n    id: BookingId\n    fields: { limit: money }\n';
const DSL = `workspace {
  model {
    s = softwareSystem "Fares" {
      api = container "Bookings API" { properties { "d.owns" "Booking" } }
      w = container "Worker" { properties { "d.owns" "Bookign" } }
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
  const g = gate({ listed: ['fares'], packs: [{ key: 'fares', path: 'domain/fares.yaml', text: PACK }] });
  assert.ok(g.clauses.some(c => c.kind === 'domain' && /not pinned/.test(c.text)));
  assert.ok(g.clauses.some(c => c.kind === 'domain' && /Worker owns "Bookign".*fares\/Booking/.test(c.text)));
  assert.equal(g.ready, false);
  assert.deepEqual(g.notes, []);
});
test('GATE_INPUTS includes domain', () => assert.ok(Core.GATE_INPUTS.includes('domain')));
