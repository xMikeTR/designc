'use strict';
// Shared by the featuremap tests: the orders spec from fixtures/scenario-registry, a clean feature on it and a ctx that knows it.
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..', '..');
const orders = JSON.parse(fs.readFileSync(path.join(ROOT, 'fixtures/scenario-registry/ui/specs/orders.json'), 'utf8'));

const ctx = (over = {}) => ({
  specs: { orders },
  elements: new Set(['OrdersList', 'Orders API']),
  requirements: ['ORD-1'],
  acceptance: ['AC-1'],
  testScenarios: ['TS-1'],
  ...over,
});

// A feature that gives no problem against ctx(). Fresh every call, so a test can edit it.
const clean = () => ({
  id: 'orders-tag',
  title: 'Tag orders',
  intent: 'A clerk tags the matching orders in bulk.',
  aliases: ['bulk tag'],
  screens: ['orders'],
  elements: ['OrdersList'],
  requirements: ['ORD-1'],
  acceptance: ['AC-1'],
  test_scenarios: ['TS-1'],
  preconditions: { role: 'clerk', data: { tag: { param: 'tag' } } },
  entry_points: [
    { id: 'deep-link', via: { goto: { path: '/orders' } } },
    { id: 'header-button', from: 'orders:ready', via: { click: { role: 'button', name: 'Tag orders' } } },
  ],
  journeys: [{
    id: 'apply-tag',
    from: 'orders:ready',
    steps: [
      'entry',
      { click: { role: 'button', name: 'Tag orders' }, state: 'tag-popover' },
      { fill: { role: 'textbox', name: 'Tag', value: { param: 'tag' } } },
      { click: { role: 'button', name: 'Apply' }, state: 'tagged' },
      { wait: { role: 'status', text: 'Tagged' } },
      { press: 'Escape' },
    ],
    proves: { ui: { state: 'tagged', contains: [{ role: 'status', text: 'Tagged' }] }, effect: { api: { method: 'GET', path: '/api/orders' }, expect: { status: 200 } } },
  }],
});

const file = (rec, p = `features/${rec.id}.yaml`) => ({ path: p, record: rec });
// problems of one record; `code` keeps only that code
const run = (FM, rec, c = ctx(), code) => FM.problems([file(rec)], c).filter(p => !code || p.code === code);

module.exports = { orders, ctx, clean, file, run, ROOT };
