// C5: the recorded runs (test/fixtures/variance/*.json: the exact mint_test_scenarios arguments an agent sent for ORD-1)
// and the in-memory context they are checked against (the ORD-1 page, the orders pack, the orders-tag spec).
const fs = require('fs'), path = require('path');
const yaml = require('js-yaml');
const Core = require('../../renderer/core.js');
const { fixture } = require('./scenario-handover.js');
const PAGE = fs.readFileSync(path.join(__dirname, '..', '..', 'fixtures', 'scenario-registry', 'import', 'ORD-1.md'), 'utf8');
const run = n => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'variance', n + '.json'), 'utf8'));
const ORDERS = { key: 'orders', load: yaml.load, text: 'id: orders\nversion: 1\naggregates:\n  Order: { id: OrderId, fields: { ref: string, tag: string } }\n' };
const ENTITIES = Core.packAggregates([ORDERS]);
const S1 = 'The tag is applied to all orders matching the string entered.';
const S2 = 'An order that does not match is left untouched.';
const ctx = () => ({ pageText: PAGE, specs: fixture().ui.specs, entities: ENTITIES, resolveOperation: id => (id === 'tagOrders' ? { method: 'POST', path: '/orders/tags' } : null) });
module.exports = { PAGE, run, ORDERS, ENTITIES, ctx, S1, S2 };
