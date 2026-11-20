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
