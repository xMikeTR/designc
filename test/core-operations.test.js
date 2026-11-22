const test = require('node:test');
const assert = require('node:assert');
const Core = require('../renderer/core.js');
const yamlLoad = require('js-yaml').load;

const spec = (paths, extra = '') => `openapi: 3.0.3\n${extra}info: {title: t, version: '1'}\npaths:\n${paths}`;
const A = spec(`  /orders:
    parameters: [{name: x, in: query}]
    summary: s
    get: {operationId: listOrders}
    post: {operationId: createOrder}
  /orders/{id}:
    get: {operationId: getOrder}
    delete: {summary: no id}
`);
const B = spec(`  /tags:
    put: {operationId: putTag}
`);
const reg = files => ({ files, yamlLoad });

test('happy path: sorted, uppercase methods, non-methods ignored', () => {
  const { operations, errors } = Core.operations(reg({ 'contracts/openapi/b.yml': B, 'contracts/openapi/a.yaml': A }));
  assert.deepStrictEqual(errors, []);
  assert.deepStrictEqual(operations, [
    { operationId: 'listOrders', method: 'GET', path: '/orders', file: 'contracts/openapi/a.yaml' },
    { operationId: 'createOrder', method: 'POST', path: '/orders', file: 'contracts/openapi/a.yaml' },
    { operationId: 'getOrder', method: 'GET', path: '/orders/{id}', file: 'contracts/openapi/a.yaml' },
    { operationId: 'putTag', method: 'PUT', path: '/tags', file: 'contracts/openapi/b.yml' },
  ]);
  assert.deepStrictEqual(Core.resolveOperation(reg({ 'contracts/openapi/a.yaml': A }), 'getOrder'),
    { operationId: 'getOrder', method: 'GET', path: '/orders/{id}', file: 'contracts/openapi/a.yaml' });
});

test('no contracts/openapi at all, and unknown id', () => {
  const r = reg({ 'model.dsl': 'x' });
  assert.deepStrictEqual(Core.operations(r), { operations: [], errors: [] });
  assert.strictEqual(Core.resolveOperation(r, 'getOrder'), null);
  assert.strictEqual(Core.resolveOperation(reg({ 'contracts/openapi/a.yaml': A }), 'nope'), null);
});

test('duplicate across files names both files and does not resolve', () => {
  const r = reg({ 'contracts/openapi/b.yaml': A, 'contracts/openapi/a.yaml': A });
  const { errors } = Core.operations(r);
  const d = errors.filter(e => e.code === 'duplicate_operation' && e.operationId === 'getOrder');
  assert.strictEqual(d.length, 1);
  assert.deepStrictEqual(d[0].files, ['contracts/openapi/a.yaml', 'contracts/openapi/b.yaml']);
  assert.ok(d[0].message.includes('contracts/openapi/a.yaml') && d[0].message.includes('contracts/openapi/b.yaml'));
  assert.strictEqual(Core.resolveOperation(r, 'getOrder'), null);
});

test('duplicate within one file', () => {
  const t = spec('  /a:\n    get: {operationId: same}\n  /b:\n    get: {operationId: same}\n');
  const r = reg({ 'contracts/openapi/a.yaml': t });
  const { errors } = Core.operations(r);
  assert.strictEqual(errors.length, 1);
  assert.strictEqual(errors[0].code, 'duplicate_operation');
  assert.deepStrictEqual(errors[0].files, ['contracts/openapi/a.yaml']);
  assert.strictEqual(Core.resolveOperation(r, 'same'), null);
});

test('unpinned files are ignored entirely', () => {
  for (const p of ['contracts/drafts/x.yaml', 'contracts/openapi/sub/x.yaml', 'contracts/openapi/x.json']) {
    const r = reg({ [p]: A });
    assert.deepStrictEqual(Core.operations(r), { operations: [], errors: [] }, p);
    assert.strictEqual(Core.resolveOperation(r, 'getOrder'), null, p);
  }
});

test('malformed YAML and non-OpenAPI-3 files report errors, others still resolve', () => {
  const r = reg({
    'contracts/openapi/a.yaml': A,
    'contracts/openapi/bad.yaml': 'a: [unclosed\n',
    'contracts/openapi/list.yaml': '- 1\n- 2\n',
    'contracts/openapi/v2.yaml': 'swagger: "2.0"\npaths: {}\n',
  });
  const { operations, errors } = Core.operations(r);
  assert.strictEqual(operations.length, 3);
  const by = c => errors.filter(e => e.code === c);
  assert.deepStrictEqual(by('unreadable').map(e => e.file).sort(), ['contracts/openapi/bad.yaml', 'contracts/openapi/list.yaml']);
  assert.deepStrictEqual(by('not_openapi3').map(e => e.file), ['contracts/openapi/v2.yaml']);
  for (const e of errors) assert.ok(e.message.includes(e.file));
  assert.strictEqual(Core.resolveOperation(r, 'putTag'), null);
  assert.strictEqual(Core.resolveOperation(r, 'listOrders').file, 'contracts/openapi/a.yaml');
});

const pack = (id, events) => ({ key: id, load: yamlLoad, text: `id: ${id}\nevents:\n${events.map(e => `  ${e}: {a: string}`).join('\n')}\n` });

test('packEvents lists every event of every readable pack, sorted by pack then name', () => {
  const ev = Core.packEvents([pack('orders', ['OrderPlaced', 'Cancelled']), pack('billing', ['Paid']), { key: 'bad', load: yamlLoad, text: '- nope' }]);
  assert.deepEqual(ev, [{ pack: 'billing', name: 'Paid' }, { pack: 'orders', name: 'Cancelled' }, { pack: 'orders', name: 'OrderPlaced' }]);
  assert.deepEqual(Core.packEvents(null), []);
});

test('resolveMessage: qualified exact, bare unique, bare ambiguous, unknown', () => {
  const ev = Core.packEvents([pack('orders', ['Placed', 'Shared']), pack('billing', ['Shared'])]);
  assert.deepEqual(Core.resolveMessage(ev, 'Placed'), { event: { pack: 'orders', name: 'Placed' } });
  assert.deepEqual(Core.resolveMessage(ev, 'billing/Shared'), { event: { pack: 'billing', name: 'Shared' } });
  assert.match(Core.resolveMessage(ev, 'Shared').error, /Shared is defined by billing and orders: write billing\/Shared/);
  assert.match(Core.resolveMessage(ev, 'Nope').error, /no pinned pack defines event Nope/);
  assert.match(Core.resolveMessage(ev, 'orders/Nope').error, /no pinned pack defines event orders\/Nope/);
});

const apack = (id, body, extra = '') => ({ key: id, load: yamlLoad, text: `id: ${id}\nversion: 2\naggregates:\n${body}\n${extra}` });
const ORD = apack('orders', '  Order: { id: OrderId, fields: { ref: string, tag: string } }\n  Line: { id: LineId }');

test('packAggregates lists aggregates (not refs) sorted by pack then name, skipping an unreadable pack', () => {
  const aggs = Core.packAggregates([ORD, apack('billing', '  Invoice: { id: InvId, fields: { total: number } }', 'refs:\n  Order: orders/Order\n'), { key: 'bad', load: yamlLoad, text: '- nope' }]);
  assert.deepEqual(aggs.map(a => `${a.pack}/${a.name}`), ['billing/Invoice', 'orders/Line', 'orders/Order']);
  assert.deepEqual(aggs[2], { pack: 'orders', name: 'Order', fields: [{ name: 'ref', type: 'string' }, { name: 'tag', type: 'string' }], version: 2 });
  assert.deepEqual(Core.packAggregates(null), []);
});
test('resolveEntity: qualified, bare unique, bare ambiguous, unknown', () => {
  const aggs = Core.packAggregates([ORD, apack('billing', '  Order: { id: OId }')]);
  assert.equal(Core.resolveEntity(aggs, 'orders/Order').entity.pack, 'orders');
  assert.equal(Core.resolveEntity(aggs, 'Line').entity.name, 'Line');
  assert.match(Core.resolveEntity(aggs, 'Order').error, /Order is defined by billing and orders: write billing\/Order/);
  assert.match(Core.resolveEntity(aggs, 'Nope').error, /no pinned pack defines aggregate Nope/);
  assert.match(Core.resolveEntity(aggs, 'orders/Nope').error, /no pinned pack defines aggregate orders\/Nope/);
});

// C4b: operationInputs
const OPS = `openapi: 3.0.3
info: {title: t, version: '1'}
components:
  parameters:
    Size: {name: size, in: query, required: true}
  requestBodies:
    TagBody:
      required: true
      content:
        application/json:
          schema: {$ref: '#/components/schemas/Tag'}
  schemas:
    Tag: {type: object, required: [tag], properties: {tag: {type: string}, note: {type: string}}}
paths:
  /orders/{orderId}/tags:
    parameters:
      - {name: page, in: query, required: true}
      - {name: orderId, in: path, required: true}
    post:
      operationId: tagOne
      parameters:
        - {name: page, in: query}
        - {$ref: '#/components/parameters/Size'}
        - {name: X-Trace, in: header}
      requestBody: {$ref: '#/components/requestBodies/TagBody'}
  /plain: {get: {operationId: plain}}
  /all:
    post:
      operationId: allOf
      requestBody: {content: {application/json: {schema: {allOf: [{type: object}]}}}}
  /open:
    post:
      operationId: open
      requestBody: {content: {application/problem+json: {schema: {type: object, properties: {a: {}}, additionalProperties: true}}}}
  /d1: {get: {operationId: dd}}
  /d2: {get: {operationId: dd}}
`;
test('operationInputs: path, merged and $ref query params, header ignored, $ref body closed', () => {
  const r = reg({ 'contracts/openapi/o.yaml': OPS });
  assert.deepStrictEqual(Core.operationInputs(r, 'tagOne'), { path: ['orderId'], pathTemplate: '/orders/{orderId}/tags', query: [{ name: 'page', required: false }, { name: 'size', required: true }],
    body: { required: true, mapping: true, properties: ['tag', 'note'], requiredProps: ['tag'], closed: true } });
  assert.deepStrictEqual(Core.operationInputs(r, 'allOf').body, { required: false, mapping: false, properties: null, requiredProps: [], closed: false });
  assert.equal(Core.operationInputs(r, 'open').body.closed, false);
  assert.equal(Core.operationInputs(r, 'open').body.mapping, true);
  assert.equal(Core.operationInputs(r, 'nope'), null);
});
test('operationInputs: no body, duplicate op is null; fixture tagOrders', () => {
  const r = reg({ 'contracts/openapi/o.yaml': OPS });
  assert.deepStrictEqual(Core.operationInputs(r, 'plain'), { path: [], pathTemplate: '/plain', query: [], body: null });
  assert.equal(Core.operationInputs(r, 'dd'), null);
  assert.deepStrictEqual(Core.operationInputs(reg({ 'contracts/openapi/b.yml': B }), 'putTag'), { path: [], pathTemplate: '/tags', query: [], body: null });
  const fs = require('fs'), path = require('path');
  const fx = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'scenario-registry', 'contracts', 'openapi', 'orders.yaml'), 'utf8');
  assert.deepStrictEqual(Core.operationInputs(reg({ 'contracts/openapi/orders.yaml': fx }), 'tagOrders'), { path: [], pathTemplate: '/orders/tags', query: [],
    body: { required: true, mapping: true, properties: ['match', 'tag'], requiredProps: ['match', 'tag'], closed: true } });
  assert.deepStrictEqual(Core.operations(reg({ 'contracts/openapi/orders.yaml': fx })), { operations: [{ operationId: 'tagOrders', method: 'POST', path: '/orders/tags', file: 'contracts/openapi/orders.yaml' }], errors: [] });
});
