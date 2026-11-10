const test = require('node:test');
const assert = require('node:assert/strict');
const HealthOverlay = require('../renderer/health-overlay.js');

const health = () => ({
  elements: {
    'Pricing/Quotes': {
      findings: { total: 14, new: 2, byLevel: { error: 0, warning: 9, note: 5 }, byCategory: { smell: 8, duplication: 3 } },
      properties: {
        idempotent: { applicable: true, evidence: [{ kind: 'check', result: 'pass', commit: 'a1' }] },
        cached: { applicable: true, evidence: [] },
      },
    },
    'Pricing/Empty': { findings: { total: 0, new: 0, byLevel: {} } },
  },
  unmapped: { findings: 3 },
});

test('no health file: nothing is drawn', () => {
  assert.equal(HealthOverlay.build({ health: null }), null);
  assert.equal(HealthOverlay.build({ health: {} }), null);
});

test('badge carries the count, the new count and the worst level', () => {
  const o = HealthOverlay.build({ health: health() });
  assert.deepEqual(o.byElement['Pricing/Quotes'].badge, { count: 14, new: 2, worst: 'warning', byCategory: { smell: 8, duplication: 3 } });
  assert.equal(o.byElement['Pricing/Empty'].badge, null);
});

test('one chip per property the file speaks about, status computed from claim plus evidence', () => {
  const o = HealthOverlay.build({
    health: health(), claims: () => ({ idempotent: true }), changedSince: () => false,
  });
  assert.deepEqual(o.byElement['Pricing/Quotes'].chips, [
    { property: 'idempotent', status: 'verified' },
    { property: 'cached', status: 'unknown' },
  ]);
  assert.deepEqual(o.byElement['Pricing/Empty'].chips, []);
});

test('an edit under the element makes verified fall back to declared', () => {
  const o = HealthOverlay.build({ health: health(), claims: () => ({ idempotent: true }), changedSince: () => true });
  assert.equal(o.byElement['Pricing/Quotes'].chips[0].status, 'declared');
});

test('headline counts applicable properties not verified, and unmapped findings', () => {
  const o = HealthOverlay.build({ health: health(), claims: () => ({ idempotent: true }), changedSince: () => false });
  assert.deepEqual(o.headline, { unverified: 1, unmapped: 3 });
});

test('a not-applicable property draws no chip and does not count', () => {
  const h = health();
  h.elements['Pricing/Quotes'].properties.cached.applicable = false;
  const o = HealthOverlay.build({ health: h });
  assert.deepEqual(o.byElement['Pricing/Quotes'].chips.map(c => c.property), ['idempotent']);
});
