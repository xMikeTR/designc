const { test } = require('node:test');
const assert = require('node:assert/strict');
const code = require('../extract/code.js');

const FILES = {
  'a/Orders.cs': 'public class Orders : IOrders\n{\n  Repo _r;\n  public Order Make() { if (_r == null) return null; return new Order(); }\n}\n',
  'a/IOrders.cs': 'public interface IOrders { }\n',
  'a/Order.cs': 'public partial class Order\n{\n  void A() { }\n}\n',
  'a/Order.More.cs': 'public partial class Order\n{\n  void B() { if (true) { } }\n}\n',
  'a/Repo.cs': 'public class Repo { }\n',
  'b/Repo.cs': 'public class Repo { }\n',
  'b/Dup.cs': 'public class Dup1 { }\npublic class User { Dup1 d; Repo r; }\n',
  'b/Dup2.cs': 'public class Dup1 { }\n',
  'a/readme.json': '{}',
};
const read = async f => FILES[f] || '';
const comps = [
  { id: 'c_a_orders', container: 'Api', files: ['a/Orders.cs', 'a/IOrders.cs', 'a/readme.json'] },
  { id: 'c_a_domain', container: 'Api', files: ['a/Order.cs', 'a/Order.More.cs', 'a/Repo.cs'] },
  { id: 'c_b_data', container: 'Worker', files: ['b/Repo.cs', 'b/Dup.cs'] },
  { id: 'c_b_more', container: 'Worker', files: ['b/Dup2.cs'] },
];

test('types per component, partial classes merged, methods keep their own file', async () => {
  const r = await code.build({ components: comps, read });
  const order = r.types.find(t => t.component === 'c_a_domain' && t.name === 'Order');
  assert.equal(order.id, 't_c_a_domain_order');
  assert.deepEqual(order.methods.map(m => [m.name, m.file, m.cc]), [['A', 'a/Order.cs', 1], ['B', 'a/Order.More.cs', 2]]);
  assert.deepEqual(order.files.map(f => f.file).sort(), ['a/Order.More.cs', 'a/Order.cs']);
  assert.ok(!r.types.some(t => t.file === 'a/readme.json'));
});

test('edges resolve by name inside the same container and carry evidence', async () => {
  const r = await code.build({ components: comps, read });
  const edge = (a, b) => r.typeEdges.find(e => e.from === a && e.to === b);
  assert.equal(edge('t_c_a_orders_orders', 't_c_a_orders_iorders').via, 'inherits');
  assert.equal(edge('t_c_a_orders_orders', 't_c_a_domain_order').via, 'new');
  assert.equal(edge('t_c_a_orders_orders', 't_c_a_domain_repo').via, 'uses');
  assert.deepEqual(Object.keys(edge('t_c_a_orders_orders', 't_c_a_domain_order').evidence).sort(), ['file', 'line']);
});

test('a name that two types share in one container is unresolved, never guessed', async () => {
  const r = await code.build({ components: comps, read });
  assert.ok(r.unresolved.some(u => /Dup1/.test(u.what)));
  assert.ok(!r.typeEdges.some(e => e.to.includes('dup1')));
  // Repo exists once per container, so User in Worker resolves to the Worker one, not Api's
  assert.ok(r.typeEdges.some(e => e.from === 't_c_b_data_user' && e.to === 't_c_b_data_repo'));
});

test('no self edges and no edges to unknown names', async () => {
  const r = await code.build({ components: comps, read });
  assert.ok(r.typeEdges.every(e => e.from !== e.to));
  assert.ok(!r.typeEdges.some(e => /task/i.test(e.to)));
});

test('JS/TS: classes and modules of one container link by name, an import names the module, a class and a module of one name stay apart', async () => {
  const files = {
    'web/src/orders/index.ts': 'import { price } from "../pricing/index";\nexport class Orders extends Base {\n  run() { return new Cart(); }\n}\nexport function load() { return 1; }',
    'web/src/pricing/index.ts': 'export function price() { if (1) { return 2; } return 1; }',
    'web/src/cart.ts': 'export class Cart {}\nexport class Base {}',
    'web/src/cart/index.ts': 'export function cart() { return 1; }',
  };
  const r = await code.build({
    components: [{ id: 'c_web_orders', container: 'Web', files: ['web/src/orders/index.ts'] }, { id: 'c_web_pricing', container: 'Web', files: ['web/src/pricing/index.ts'] }, { id: 'c_web_cart', container: 'Web', files: ['web/src/cart.ts', 'web/src/cart/index.ts'] }],
    read: async f => files[f],
  });
  const byName = Object.fromEntries(r.types.map(t => [t.kind + ':' + t.name, t]));
  assert.ok(byName['module:cart'] && byName['class:Cart'] && byName['module:cart'].id !== byName['class:Cart'].id);
  const edge = (a, b) => r.typeEdges.find(e => e.from === byName[a].id && e.to === byName[b].id);
  assert.equal(edge('module:orders', 'module:pricing').via, 'uses');
  assert.equal(edge('class:Orders', 'class:Base').via, 'inherits');
  assert.equal(edge('class:Orders', 'class:Cart').via, 'new');
  assert.equal(r.unresolved.length, 0);
});

test('F#: a module and a type of one container link by name, qualified calls name the module', async () => {
  const files = {
    'rating/Rates.fs': 'module Rates\nlet price q = if q > 1 then 2 else 1\n',
    'rating/Engine.fs': 'module Engine\ntype Engine(repo: Repo) =\n    member _.Run() = Rates.price 1\n',
    'rating/Repo.fs': 'module Repo\ntype Repo() =\n    member _.Get() = 1\n',
  };
  const r = await code.build({
    components: [{ id: 'c_rating', container: 'Rating', files: Object.keys(files) }],
    read: async f => files[f],
  });
  const byName = Object.fromEntries(r.types.map(t => [t.kind + ':' + t.name, t]));
  const edge = (a, b) => r.typeEdges.find(e => e.from === byName[a].id && e.to === byName[b].id);
  assert.ok(edge('class:Engine', 'module:Rates'));
  assert.ok(edge('class:Engine', 'class:Repo'));
});
