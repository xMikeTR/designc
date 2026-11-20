// elements.json /3 (R4b): both ends of a typed rel carry the same resolved interface. /1 and /2 are untouched when nothing is typed.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Core = require('../renderer/core.js');
const yamlLoad = require('js-yaml').load;

const dsl = `workspace "Shop" { model {
  s = softwareSystem "Shop" {
    web = container "Web" { properties { "d.code" "web/**" "d.risk" "low" "d.repo" "Ui" } }
    api = container "Api" { properties { "d.code" "api/**" "d.risk" "low" "d.repo" "Api" "d.owns" "Order" } }
    mail = container "Mail"
  }
  web -> api "lists" { properties { "d.operation" "listOrders" } }
  api -> mail "tells" { properties { "d.interaction" "async" "d.message" "OrderPlaced" } }
} }`;
const spec = (extra = 'string') => `openapi: 3.0.3
info: {title: t, version: '1'}
paths:
  /orders:
    get:
      operationId: listOrders
      responses:
        '200':
          content:
            application/json:
              schema: {$ref: '#/components/schemas/Order'}
components:
  schemas:
    Order:
      type: object
      properties:
        ref: {type: ${extra}}
        parent: {$ref: '#/components/schemas/Order'}
`;
const PACK = { key: 'orders', path: 'domain/orders.yaml', load: yamlLoad, text: 'id: orders\naggregates:\n  Order: {id: OrderId, publishes: [OrderPlaced]}\nevents:\n  OrderPlaced: {orderId: string}\n' };
const api = (t = spec()) => [{ path: 'contracts/openapi/shop.yaml', text: t }];
const boundary = (t) => ({ apiContracts: api(t), packs: [PACK] });
const byId = (doc, id) => doc.elements.find(e => e.id === id);

test('both ends of a typed sync rel carry the same operation interface (calls / serves)', () => {
  const d = Core.handoverElements(dsl, [], null, boundary());
  assert.equal(d.schema, 'designc.handover.elements/3');
  const call = byId(d, 'Shop/Web').interfaces.find(i => i.kind === 'operation'), serve = byId(d, 'Shop/Api').interfaces.find(i => i.kind === 'operation');
  assert.equal(call.role, 'calls'); assert.equal(serve.role, 'serves');
  const { role: _a, ...c } = call, { role: _b, ...s } = serve;
  assert.deepEqual(c, s);
  assert.equal(c.id, 'listOrders'); assert.equal(c.method, 'GET'); assert.equal(c.path, '/orders'); assert.equal(c.file, 'contracts/openapi/shop.yaml');
  assert.match(c.version, /^[0-9a-f]{16}$/);
  assert.deepEqual(call.rel, { from: 'Shop/Web', to: 'Shop/Api' });
});

test('typed async rel: publishes / consumes with the same fields and version', () => {
  const d = Core.handoverElements(dsl, [], null, boundary());
  const pub = byId(d, 'Shop/Api').interfaces.find(i => i.kind === 'event'), con = byId(d, 'Shop/Mail').interfaces[0];
  assert.equal(pub.role, 'publishes'); assert.equal(con.role, 'consumes');
  assert.equal(pub.id, 'orders/OrderPlaced');
  assert.deepEqual(pub.fields, [{ name: 'orderId', type: 'string' }]);
  assert.equal(pub.version, con.version);
  assert.deepEqual(pub.fields, con.fields);
  assert.equal(byId(d, 'Shop/Web').interfaces.length, 1);
});

test('a $ref into components/schemas is inlined, and a recursive one terminates', () => {
  const d = Core.handoverElements(dsl, [], null, boundary());
  const op = byId(d, 'Shop/Web').interfaces[0];
  const sch = op.schema.responses['200'].content['application/json'].schema;
  assert.equal(sch.type, 'object');
  assert.equal(sch.properties.ref.type, 'string');
  assert.deepEqual(sch.properties.parent, { $ref: '#/components/schemas/Order' });
  assert.ok(!JSON.stringify(op.schema).includes('"$ref":"#/components/schemas/Order"') || sch.properties.parent.$ref);
});

test('a change to the response schema changes version on both sides', () => {
  const a = Core.handoverElements(dsl, [], null, boundary()), b = Core.handoverElements(dsl, [], null, boundary(spec('integer')));
  const v = d => [byId(d, 'Shop/Web').interfaces[0].version, byId(d, 'Shop/Api').interfaces.find(i => i.kind === 'operation').version];
  assert.notEqual(v(a)[0], v(b)[0]);
  assert.equal(v(b)[0], v(b)[1]);
});

test('no typed rels resolve: still /1 (whole model) or /2 (item), same as without a boundary', () => {
  const none = { apiContracts: [], packs: [] };
  assert.deepEqual(Core.handoverElements(dsl, [], null, none), Core.handoverElements(dsl, [], null));
  assert.equal(Core.handoverElements(dsl, [], null, none).schema, 'designc.handover.elements/1');
  assert.deepEqual(Core.handoverElements(dsl, [], ['Web'], none), Core.handoverElements(dsl, [], ['Web']));
  assert.equal(Core.handoverElements(dsl, [], ['Web'], none).schema, 'designc.handover.elements/2');
});

test('work-item freeze with interfaces: /3 with in_scope and reserved; whole-model /3 has neither', () => {
  const item = Core.handoverElements(dsl, [], ['Web'], boundary());
  assert.equal(item.schema, 'designc.handover.elements/3');
  assert.ok(item.reserved.length);
  assert.ok(item.elements.every(e => typeof e.in_scope === 'boolean'));
  const whole = Core.handoverElements(dsl, [], null, boundary());
  assert.ok(!('reserved' in whole)); assert.ok(whole.elements.every(e => !('in_scope' in e)));
});

test('the /3 example is what handoverElements writes, and it validates against the schema', () => {
  const read = f => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'docs', f), 'utf8'));
  const ex = read('handover-elements-3.example.json'), schema = read('handover-elements-3.schema.json');
  assert.deepEqual(ex, Core.handoverElements(dsl, [], ['Web'], boundary()));
  assert.equal(schema.$id, 'designc.handover.elements/3');
  assert.equal(schema.properties.schema.const, 'designc.handover.elements/3');
  const validate = new (require('ajv/dist/2020'))({ strict: false, allErrors: true }).compile(schema);
  assert.ok(validate(ex), JSON.stringify(validate.errors));
  assert.ok(validate(Core.handoverElements(dsl, [], null, boundary())), JSON.stringify(validate.errors));
});

test('handoverPlan writes /3 into elements.json when a typed rel resolves', () => {
  const plan = Core.handoverPlan({ date: '2026-11-20', now: 'n', by: 'u', model: { path: 'model/workspace.dsl', text: dsl }, apiContracts: api(), domain: [PACK] });
  const el = JSON.parse(plan.files.find(f => f.path.endsWith('elements.json')).text);
  assert.equal(el.schema, 'designc.handover.elements/3');
  assert.equal(byId(el, 'Shop/Web').interfaces[0].id, 'listOrders');
});
