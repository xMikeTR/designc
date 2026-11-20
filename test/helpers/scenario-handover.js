// B3: a freeze-ready copy of fixtures/scenario-registry, built in memory (the registry itself stays what the B1 e2e uses):
// the orders spec is bound and names its page file, the pack is pinned, previews approved; two structured scenarios, one bound, one minted.
const fs = require('fs'), path = require('path');
const yaml = require('js-yaml');
const { ROOT, load } = require('./ui.js');
const REG = path.join(__dirname, '..', '..', 'fixtures', 'scenario-registry');
const rd = rel => fs.readFileSync(path.join(REG, rel), 'utf8');
const sha = b => require('crypto').createHash('sha256').update(b).digest('hex');

const BOUND = { id: 'ORD-1-ts-01', requirement: 'ORD-1', title: 'Tag matching orders', source: 'The tag is applied to all orders matching the string entered.', screen: 'orders-tag',
  steps: [{ fill: { role: 'textbox', name: 'Match' }, value: '{match}' }, { select: { role: 'combobox', name: 'Tag' }, value: '{tag}' }, { click: { role: 'button', name: 'Apply' } }],
  effect: { operation: 'tagOrders', body: { match: '{match}', tag: '{tag}' } },
  examples: [{ title: 'prefix match', match: 'A-', tag: 'Priority' }, { title: 'whole reference', match: 'B-200', tag: 'Hold' }], by: 'grill', status: 'bound' };
const MINTED = { ...BOUND, id: 'ORD-1-ts-02', title: 'Tag nothing', status: 'minted' };

function fixture() {
  const base = load(REG);
  const orders = { ...JSON.parse(rd('ui/specs/orders.json')), status: 'bound', file: 'src/pages/OrdersList.tsx' };
  const ordersFile = { path: 'ui/specs/orders.json', text: JSON.stringify(orders, null, 2) + '\n' };
  const tagFile = base.specs.find(s => s.path === 'ui/specs/orders-tag.json');
  const files = { 'ready-chromium-linux.png': sha('ready') };
  return {
    modelText: rd('model/workspace.dsl'),
    ordersFile, tagFile,
    ui: { specs: [ordersFile, tagFile], pack: base.pack, pin: { name: 'acme-ui', hash: 'pinhash0123456789' }, previews: [{ screen: 'orders', approved_ts: 1700, files }], holdouts: {} },
    testScenarios: [BOUND, MINTED].map(s => ({ path: `test-scenarios/${s.id}.yaml`, text: yaml.dump(s, { lineWidth: -1 }) })),
    apiContracts: [{ path: 'contracts/openapi/orders.yaml', text: rd('contracts/openapi/orders.yaml') }],
    requirements: [{ path: 'requirements/ORD-1.yaml', text: rd('requirements/ORD-1.yaml') }],
  };
}
const inputs = (f, o = {}) => ({
  date: '2026-11-20', now: '2026-11-20T10:00:00.000Z', by: 'mike',
  model: { path: 'model/workspace.dsl', text: f.modelText }, requirements: f.requirements, apiContracts: f.apiContracts,
  ui: f.ui, testScenarios: f.testScenarios, ...o,
});
module.exports = { fixture, inputs, BOUND, MINTED, sha };
