// DC011 Untyped boundary: a rel that crosses a repo or zone names d.operation (sync) or d.message (async).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../renderer/core.js');

const dsl = (relProps = '', extra = '') => `workspace { model {
  u = person "User"
  s = softwareSystem "S" {
    api = container "Api" { properties { "d.repo" "Api" "d.zone" "corporate" }
      h = component "Handler" }
    web = container "Web" { properties { "d.repo" "Ui" "d.zone" "corporate" } }
    same = container "Same" { properties { "d.repo" "Api" "d.zone" "corporate" } }
    ven = container "Ven" { properties { "d.zone" "vendor" "d.repo" "Api" } }
  }
  ${extra}
  web -> api "calls" { properties { ${relProps} } }
} }`;
const run = (text, o) => Core.check(Core.parse(text), o).filter(f => f.code === 'DC011');
const OPS = { operations: [{ operationId: 'listOrders', file: 'contracts/openapi/a.yaml' }], errors: [] };
const EVENTS = [{ pack: 'orders', name: 'OrderPlaced' }, { pack: 'orders', name: 'Shared' }, { pack: 'billing', name: 'Shared' }];

test('untyped repo crossing: warning, unknown', () => {
  const f = run(dsl());
  assert.equal(f.length, 1);
  assert.equal(f[0].sev, 'warning'); assert.equal(f[0].unknown, true);
  assert.match(f[0].msg, /repo Ui → Api/);
});

test('zone crossing names the zones', () => {
  const f = run(`workspace { model { s = softwareSystem "S" {
    a = container "A" { properties { "d.zone" "corporate" } }
    b = container "B" { properties { "d.zone" "vendor" } }
  } 
  a -> b "x" } }`);
  assert.equal(f.length, 1);
  assert.match(f[0].msg, /zone corporate → vendor/);
});

test('same repo/zone, structural and person rels raise nothing', () => {
  const t = `workspace { model {
    u = person "User"
    s = softwareSystem "S" {
      a = container "A" { properties { "d.repo" "Api" "d.zone" "z" }
        h = component "H" }
      b = container "B" { properties { "d.repo" "Api" "d.zone" "z" } }
    }
    a -> b "same"
    a -> h "structural"
    u -> a "person"
  } }`;
  assert.deepEqual(run(t), []);
});

test('d.operation or d.message clears the warning and is not DC000', () => {
  for (const p of ['"d.operation" "listOrders"', '"d.message" "OrderPlaced" "d.interaction" "async"']) {
    const m = Core.parse(dsl(p));
    assert.deepEqual(Core.check(m).filter(f => f.code === 'DC011' || f.code === 'DC000'), []);
  }
});

test('with o.boundary: unknown op is an error', () => {
  const f = run(dsl('"d.operation" "nope"'), { chainHops: 4, boundary: { operations: OPS, events: EVENTS } });
  assert.equal(f.length, 1); assert.equal(f[0].sev, 'error');
  assert.match(f[0].msg, /operationId "nope" is not in a pinned OpenAPI file/);
  assert.deepEqual(run(dsl('"d.operation" "listOrders"'), { chainHops: 4, boundary: { operations: OPS, events: EVENTS } }), []);
});

test('with o.boundary: duplicated op is an error naming both files', () => {
  const ops = { operations: [{ operationId: 'listOrders' }, { operationId: 'listOrders' }], errors: [{ code: 'duplicate_operation', operationId: 'listOrders', files: ['a', 'b'], message: 'operationId "listOrders" is defined more than once (in contracts/openapi/a.yaml, contracts/openapi/b.yaml)' }] };
  const f = run(dsl('"d.operation" "listOrders"'), { chainHops: 4, boundary: { operations: ops, events: EVENTS } });
  assert.equal(f.length, 1);
  assert.match(f[0].msg, /a\.yaml, contracts\/openapi\/b\.yaml/);
});

test('with o.boundary: unknown and ambiguous messages are errors, pack/Event resolves', () => {
  const b = { chainHops: 4, boundary: { operations: OPS, events: EVENTS } };
  assert.match(run(dsl('"d.message" "Nope"'), b)[0].msg, /no pinned pack defines event Nope/);
  assert.match(run(dsl('"d.message" "Shared"'), b)[0].msg, /defined by billing and orders: write billing\/Shared/);
  assert.deepEqual(run(dsl('"d.message" "orders/Shared"'), b), []);
});

test('without o.boundary: no errors, even for unknown names', () => {
  assert.deepEqual(run(dsl('"d.operation" "nope" "d.message" "Nope"')), []);
});

test('d.suppress silences DC011', () => {
  const f = run(dsl('"d.suppress" "DC011: legacy call"'));
  assert.equal(f.length, 1); assert.ok(f[0].suppressed);
});
