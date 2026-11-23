// N5 principles: d.style, d.api, d.ui are set on a system, inherited, and checked by DC012 to DC014.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Core = require('../renderer/core.js');

const run = (text, code, o) => Core.check(Core.parse(text), o).filter(f => f.code === code);
const wrap = (sysProps, body, extra = '') => `workspace { model {
  cust = person "Customer"
  shop = softwareSystem "Shop" { ${sysProps ? `properties { ${sysProps} }` : ''}
    ${body}
  }
  ${extra}
} }`;
const ED = '"d.style" "event-driven"';

// ---------- DC012 ----------
const style = (relBody, sys = ED) => wrap(sys, `
  orders = container "Orders" { oc = component "OrderCore"
    od = component "OrderLog" }
  warehouse = container "Warehouse"`, `orders -> warehouse "ships" { ${relBody} }`);

test('DC012: sync call between event-driven ends is a warning', () => {
  const f = run(style('properties { "d.interaction" "sync" }'), 'DC012');
  assert.equal(f.length, 1);
  assert.equal(f[0].sev, 'warning'); assert.equal(f[0].unknown, false);
  assert.equal(f[0].msg, 'sync call in an event-driven system');
  assert.equal(f[0].hint, 'make it async, or record why with d.suppress');
  assert.equal(f[0].loc.kind, 'relationship'); assert.deepEqual(f[0].loc.names, ['Orders', 'Warehouse']);
  assert.ok(f[0].loc.line > 0);
});

test('DC012: undeclared interaction is an unknown warning', () => {
  const f = run(style(''), 'DC012');
  assert.equal(f.length, 1);
  assert.equal(f[0].sev, 'warning'); assert.equal(f[0].unknown, true);
  assert.equal(f[0].msg, 'event-driven system, interaction undeclared');
  assert.equal(f[0].hint, 'set d.interaction: async | sync');
});

test('DC012: quiet for async, request-response, no principle, a nearer none, and a sibling-only value', () => {
  assert.equal(run(style('properties { "d.interaction" "async" }'), 'DC012').length, 0);
  assert.equal(run(style('properties { "d.interaction" "sync" }', '"d.style" "request-response"'), 'DC012').length, 0);
  assert.equal(run(style('properties { "d.interaction" "sync" }', ''), 'DC012').length, 0);
  const none = wrap(ED, `
    orders = container "Orders" { properties { "d.style" "none" } }
    warehouse = container "Warehouse"`, 'orders -> warehouse "ships" { properties { "d.interaction" "sync" } }');
  // "none" is not a style value, so it is a DC000 error; use the other end being plain via a sibling system instead
  const sib = `workspace { model {
    a = softwareSystem "Shop" { properties { ${ED} } orders = container "Orders" }
    b = softwareSystem "Billing" { ledger = container "Ledger" }
    orders -> ledger "posts" { properties { "d.interaction" "sync" } }
  } }`;
  assert.equal(run(sib, 'DC012').length, 0);
  assert.ok(run(none, 'DC000').length > 0);
});

test('DC012: quiet for a person, a structural pair and an in-process pair', () => {
  const t = wrap(ED, `
    orders = container "Orders" { oc = component "OrderCore"
      od = component "OrderLog" }
    warehouse = container "Warehouse"`, `cust -> orders "buys" { properties { "d.interaction" "sync" } }
    shop -> orders "owns" { properties { "d.interaction" "sync" } }
    oc -> od "logs" { properties { "d.interaction" "sync" } }`);
  assert.equal(run(t, 'DC012').length, 0);
});

test('DC012: a suppressed finding is marked suppressed', () => {
  const f = run(style('properties { "d.interaction" "sync" "d.suppress" "DC012: reviewed" }'), 'DC012');
  assert.equal(f.length, 1);
  assert.ok(f[0].suppressed);
});

// ---------- DC013 ----------
const api = (relBody, sys = '"d.api" "api-first"', body = '') => wrap(sys, `
  orders = container "Orders" { oc = component "OrderCore"
    od = component "OrderLog" }
  warehouse = container "Warehouse" { wc = component "Picker" }
  ${body}`, `orders -> warehouse "asks" { ${relBody} }`);

test('DC013: sync call to an api-first element without d.operation is an unknown warning', () => {
  for (const rel of ['', 'properties { "d.interaction" "sync" }']) {
    const f = run(api(rel), 'DC013');
    assert.equal(f.length, 1);
    assert.equal(f[0].sev, 'warning'); assert.equal(f[0].unknown, true);
    assert.equal(f[0].msg, 'calls an api-first element without naming d.operation');
    assert.equal(f[0].hint, 'set d.operation: <operationId>');
    assert.equal(f[0].loc.kind, 'relationship'); assert.deepEqual(f[0].loc.names, ['Orders', 'Warehouse']);
  }
});

test('DC013: quiet with an operation, async, no principle, a nearer none, a person, structural and in-process', () => {
  assert.equal(run(api('properties { "d.operation" "listStock" }'), 'DC013').length, 0);
  assert.equal(run(api('properties { "d.interaction" "async" }'), 'DC013').length, 0);
  assert.equal(run(api('', ''), 'DC013').length, 0);
  assert.equal(run(api('', '"d.api" "api-first"', ''), 'DC013').length, 1);
  const none = `workspace { model {
    s = softwareSystem "Shop" { properties { "d.api" "api-first" }
      orders = container "Orders"
      warehouse = container "Warehouse" { properties { "d.api" "none" } wc = component "Picker" } }
    orders -> warehouse "asks"
    orders -> wc "asks too"
  } }`;
  assert.equal(run(none, 'DC013').length, 0);
  const sib = `workspace { model {
    a = softwareSystem "Shop" { properties { "d.api" "api-first" } orders = container "Orders" }
    b = softwareSystem "Billing" { ledger = container "Ledger" }
    b -> orders "x"
    orders -> ledger "y"
  } }`;
  assert.deepEqual(run(sib, 'DC013').map(f => f.loc.names), [['Billing', 'Orders']]);
  const t = wrap('"d.api" "api-first"', `
    orders = container "Orders" { oc = component "OrderCore"
      od = component "OrderLog" }
    warehouse = container "Warehouse"`, `cust -> orders "buys"
    shop -> orders "owns"
    oc -> od "logs"`);
  assert.equal(run(t, 'DC013').length, 0);
});

test('DC013: does not repeat DC011 for a repo crossing without a name', () => {
  const t = (rel) => `workspace { model {
    s = softwareSystem "Shop" { properties { "d.api" "api-first" }
      orders = container "Orders" { properties { "d.repo" "OrdersRepo" } }
      warehouse = container "Warehouse" { properties { "d.repo" "StockRepo" } } }
    orders -> warehouse "asks" { ${rel} }
  } }`;
  const text = t('');
  assert.equal(run(text, 'DC011').length, 1);
  assert.equal(run(text, 'DC013').length, 0);
  // a message without an operation is not DC011's gap, so DC013 still reports it
  assert.equal(run(t('properties { "d.message" "StockAsked" }'), 'DC013').length, 1);
});

test('DC013: a d.operation missing from a pinned file stays DC011 only', () => {
  const o = { boundary: { operations: { operations: [], errors: [] }, events: [] } };
  const text = api('properties { "d.operation" "nope" }');
  assert.equal(run(text, 'DC011', o).length, 1);
  assert.equal(run(text, 'DC013', o).length, 0);
});

// ---------- DC014 ----------
const ui = (sys = '"d.ui" "thin"', rel = 'orders', body = '') => wrap(sys, `
  web = container "Web" { tags "UI"
    page = component "Page" }
  orders = container "Orders"
  db = container "Orders DB" { tags "Database" }
  ${body}`, rel);

test('DC014: a thin UI reaching a store is an error, from the UI or a component inside it', () => {
  for (const src of ['web', 'page']) {
    const f = run(ui('"d.ui" "thin"', `${src} -> db "reads"`), 'DC014');
    assert.equal(f.length, 1);
    assert.equal(f[0].sev, 'error');
    assert.equal(f[0].msg, 'a thin UI reaches the store "Orders DB" directly');
    assert.equal(f[0].hint, 'go through the API, or record why with d.suppress');
    assert.equal(f[0].loc.kind, 'relationship');
  }
});

test('DC014: a thin UI that owns data is a warning on the element', () => {
  const t = wrap('"d.ui" "thin"', `web = container "Web" { tags "UI"
    properties { "d.owns" "Order, Cart" } }`);
  const f = run(t, 'DC014');
  assert.equal(f.length, 1);
  assert.equal(f[0].sev, 'warning');
  assert.equal(f[0].msg, 'a thin UI owns data (Order, Cart)');
  assert.equal(f[0].hint, 'move ownership to the service behind it');
  assert.equal(f[0].loc.kind, 'element'); assert.deepEqual(f[0].loc.names, ['Web']);
});

test('DC014: quiet for non-store targets, no principle, none below, a non-UI, a sibling system and a person', () => {
  assert.equal(run(ui('"d.ui" "thin"', 'web -> orders "calls"'), 'DC014').length, 0);
  assert.equal(run(ui('', 'web -> db "reads"'), 'DC014').length, 0);
  assert.equal(run(ui('"d.ui" "thin"', 'orders -> db "reads"'), 'DC014').length, 0);
  assert.equal(run(ui('"d.ui" "thin"', 'cust -> db "reads"'), 'DC014').length, 0);
  assert.equal(run(ui('"d.ui" "thin"', 'shop -> db "contains"'), 'DC014').length, 0);
  const none = wrap('"d.ui" "thin"', `web = container "Web" { tags "UI" properties { "d.ui" "none" "d.owns" "Cart" }
    page = component "Page" }
    db = container "Orders DB" { tags "Database" }`, 'page -> db "reads"');
  assert.equal(run(none, 'DC014').length, 0);
  const sib = `workspace { model {
    a = softwareSystem "Shop" { properties { "d.ui" "thin" } orders = container "Orders" }
    b = softwareSystem "Admin" { web = container "Web" { tags "UI" properties { "d.owns" "Cart" } } db = container "DB" { tags "Database" } }
    web -> db "reads"
  } }`;
  assert.equal(run(sib, 'DC014').length, 0);
});

test('DC014: a suppressed finding is marked suppressed', () => {
  const f = run(ui('"d.ui" "thin"', 'web -> db "reads" { properties { "d.suppress" "DC014: legacy" } }'), 'DC014');
  assert.equal(f.length, 1); assert.ok(f[0].suppressed);
});

// ---------- inheritance ----------
test('principle(): own value, else nearest ancestor; a nearer none switches it off', () => {
  const m = Core.parse(`workspace { model {
    s = softwareSystem "Shop" { properties { "d.ui" "thin" "d.api" "api-first" }
      a = container "A" { c1 = component "C1" }
      b = container "B" { properties { "d.ui" "none" } c2 = component "C2" } }
    t = softwareSystem "Other" { z = container "Z" }
  } }`);
  const id = n => [...m.elements.values()].find(e => e.name === n).id;
  assert.deepEqual(Core.principle(m, id('C1'), 'd.ui'), { value: 'thin', from: id('Shop') });
  assert.deepEqual(Core.principle(m, id('Shop'), 'd.ui'), { value: 'thin', from: id('Shop') });
  assert.deepEqual(Core.principle(m, id('C2'), 'd.ui'), { value: 'none', from: id('B') });
  assert.deepEqual(Core.principle(m, id('C2'), 'd.api'), { value: 'api-first', from: id('Shop') });
  assert.deepEqual(Core.principle(m, id('Z'), 'd.ui'), { value: null, from: null });
  assert.deepEqual(Core.principle(m, id('C1'), 'd.style'), { value: null, from: null });
});

// ---------- opt-in ----------
function* models(dir) {
  for (const n of fs.readdirSync(dir, { withFileTypes: true })) {
    if (n.name === 'node_modules' || n.name === '.git') continue;
    const p = path.join(dir, n.name);
    if (n.isDirectory()) yield* models(p);
    else if (n.name === 'workspace.dsl') yield p;
  }
}
test('opt-in: no DC012 to DC014 finding on any registry model without a principle', () => {
  const root = path.join(__dirname, '..');
  let n = 0;
  for (const dir of ['fixtures', 'sample-registry', 'demo', path.join('e2e', 'fixtures')]) {
    const d = path.join(root, dir); if (!fs.existsSync(d)) continue;
    for (const f of models(d)) {
      const text = fs.readFileSync(f, 'utf8');
      if (/d\.(style|api|ui)"/.test(text)) continue;
      let m; try { m = Core.parse(text); } catch { continue; }
      n++;
      assert.deepEqual(Core.check(m).filter(x => ['DC012', 'DC013', 'DC014'].includes(x.code)), [], f);
    }
  }
  assert.ok(n >= 10, `checked ${n} models`);
});

// ---------- fingerprint and gate ----------
test('fingerprint: a principle changes the system only; the gate says so for a bound system, not a container below', () => {
  const dsl = extra => `workspace { model {
    shop = softwareSystem "Shop" { properties { "d.owner" "shop" ${extra} }
      orders = container "Orders" { oc = component "OrderCore" }
      warehouse = container "Warehouse" }
  } }`;
  const before = Core.parse(dsl('')), after = Core.parse(dsl('"d.style" "event-driven"'));
  const id = (m, n) => [...m.elements.values()].find(e => e.name === n).id;
  const fp = (m, n) => Core.fingerprint(m, id(m, n)).hash;
  assert.notEqual(fp(before, 'Shop'), fp(after, 'Shop'));
  for (const n of ['Orders', 'Warehouse', 'OrderCore']) assert.equal(fp(before, n), fp(after, n));
  const dec = (bind, i) => ({ id: `d-${i}`, status: 'bound', kind: 'technical', effect: 'accept', checks: ['x'], binds: [bind], resolves: [], relies_on: [],
    promoted_against: [{ element: id(before, bind), name: bind, hash: fp(before, bind) }] });
  const clauses = Core.gate({ model: after, diags: Core.check(after), decisions: [dec('Orders', 1), dec('Shop', 2)], requirements: [], ledger: [] })
    .clauses.filter(c => c.kind === 'promotion').map(c => c.text);
  assert.deepEqual(clauses, ['d-2: Shop changed since promotion']);
});

// ---------- schema ----------
test('unknown principle values are a DC000 error', () => {
  for (const [k, v] of [['d.ui', 'fat'], ['d.api', 'maybe'], ['d.style', 'chatty']]) {
    const f = run(wrap(`"${k}" "${v}"`, 'orders = container "Orders"'), 'DC000');
    assert.ok(f.some(x => x.sev === "error" && x.msg.includes(`= "${v}"`)), `${k}: ${JSON.stringify(f)}`);
  }
});
