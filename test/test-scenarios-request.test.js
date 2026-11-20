// C4b slice 1: the request shape on structured scenario examples (Records part).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const yaml = require('js-yaml');
const Rec = require('../renderer/records.js');
const TS = require('../renderer/test-scenarios.js');

const BASE = { id: 'ORD-1-ts-01', requirement: 'ORD-1', title: 't', source: 's', screen: 'orders-tag',
  steps: [{ click: { role: 'button', name: 'Apply' } }], effect: { operation: 'tagOrders', body: { match: '{match}' } },
  by: 'grill', status: 'bound' };
const withEx = ex => ({ ...BASE, examples: [{ title: 'a', match: 'A-', ...ex }] });
const errs = rec => Rec.validate('test_scenario', rec);

test('the brief example validates', () => {
  const rec = yaml.load(`
id: ORD-1-ts-01
requirement: ORD-1
title: t
source: s
screen: orders-tag
by: grill
status: bound
steps: [{click: {role: button, name: Apply}}]
effect: {operation: tagOrders, body: {match: '{match}'}}
examples:
  - title: prefix match
    match: A-
    given: { Order: [{ id: 1, ref: A-100 }] }
    then:  { Order: [{ id: 1, tag: Priority }] }
    request: { query: { dryRun: false } }
`);
  assert.deepEqual(errs(rec), []);
  assert.deepEqual(errs(withEx({ request: {} })), []);
  assert.deepEqual(errs(withEx({ request: { path: { id: 7 }, query: { a: 'x' }, body: [1, { a: 2 }] } })), []);
});
test('each request message fires', () => {
  assert.deepEqual(errs(withEx({ request: [] })), ['examples[0].request: a mapping with path, query and body only']);
  assert.deepEqual(errs(withEx({ request: { headers: {} } })), ['examples[0].request: a mapping with path, query and body only']);
  assert.deepEqual(errs(withEx({ request: { query: { x: [1] } } })), ['examples[0].request.query: a mapping of parameter name to a string, number or boolean']);
  assert.deepEqual(errs(withEx({ request: { path: 'x' } })), ['examples[0].request.path: a mapping of parameter name to a string, number or boolean']);
  assert.deepEqual(errs(withEx({ request: { path: { a: null } } })), ['examples[0].request.path: a mapping of parameter name to a string, number or boolean']);
  const ph = { ...withEx({}), steps: [{ fill: { role: 'textbox', name: 'M' }, value: '{request}' }] };
  assert.deepEqual(errs(ph), ["steps[0] uses {request}: {request} is reserved for an example's rows: rename the placeholder"]);
});
test('flat records are unchanged and bindProblem returns the first request error', () => {
  assert.deepEqual(Rec.validate('test_scenario', { id: 'X-1', requirement: 'X', title: 't', given: ['a'], when: ['b'], then: ['c'], by: 'qa' }), []);
  assert.equal(TS.bindProblem(withEx({ request: { headers: 1 } })), 'examples[0].request: a mapping with path, query and body only');
  assert.equal(TS.bindProblem(withEx({ request: {} })), null);
});

// ---- slice 2: mint refusals (requestProblems) ----
const fs = require('fs'), path = require('path');
const Core = require('../renderer/core.js');
const ORDERS = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'scenario-registry', 'contracts', 'openapi', 'orders.yaml'), 'utf8');
const DRY = ORDERS.replace('      requestBody:', "      parameters: [{ name: dryRun, in: query, schema: { type: boolean } }]\n      requestBody:");
const PATHS = `openapi: 3.0.3
info: {title: t, version: '1'}
paths:
  /orders/{orderId}:
    get:
      operationId: getOrder
      parameters: [{name: page, in: query, required: true}, {name: size, in: query}]
    put:
      operationId: putOrder
      requestBody: {content: {application/json: {schema: {type: object, properties: {a: {}}}}}}
  /free:
    post:
      operationId: freeBody
      requestBody: {content: {application/json: {schema: {type: object, properties: {a: {}}, additionalProperties: true}}}}
`;
const inputsOf = (text, id) => Core.operationInputs({ files: { 'contracts/openapi/x.yaml': text }, yamlLoad: yaml.load }, id);
const ROWSX = { given: { Order: [{ id: 1, ref: 'A-1' }] }, then: { Order: [{ id: 1, tag: 'P' }] } };
const mk = (ex, op = 'tagOrders', effect = { operation: op, body: { match: '{match}', tag: '{tag}' } }) =>
  ({ ...BASE, effect, examples: (Array.isArray(ex) ? ex : [ex]).map((e, i) => ({ title: `e${i}`, match: 'A-', tag: 'P', ...ROWSX, ...e })) });
const probs = (rec, inputs) => TS.requestProblems(rec, inputs).map(p => [p.reason, p.message]);
const dry = inputsOf(DRY, 'tagOrders');

test('valid requests give no problems; none at all gives none', () => {
  assert.deepEqual(probs(mk({ request: { query: { dryRun: false } } }), dry), []);
  assert.deepEqual(probs(mk({ request: {} }), dry), []);
  assert.deepEqual(probs(mk({}), dry), []);
  assert.deepEqual(probs(mk({ request: { query: { nope: 1 } } }), null), []);
});
test('query and path parameters', () => {
  assert.deepEqual(probs(mk({ request: { query: { dryRunn: 1 } } }), dry), [['request_param', 'examples[0].request.query.dryRunn: tagOrders has no query parameter dryRunn (query: dryRun)']]);
  assert.deepEqual(probs(mk({ request: { path: { id: 1 } } }), dry), [['request_param', 'examples[0].request.path.id: tagOrders has no path parameter id (path: (none))']]);
  const g = inputsOf(PATHS, 'getOrder');
  const rec = (rq, ex = {}) => mk({ ...ex, request: rq }, 'getOrder', { operation: 'getOrder' });
  assert.deepEqual(probs(rec({ query: { page: 1 } }), g), [['request_param', 'examples[0].request.path: {orderId} of /orders/{orderId} has no value']]);
  assert.deepEqual(probs(rec({ path: { orderId: 7 } }), g), [['request_param', 'examples[0].request.query: required query parameter page has no value']]);
  assert.deepEqual(probs(rec({ path: { orderId: 7 }, query: { page: 1, size: 2 } }), g), []);
  assert.deepEqual(probs(rec({ path: { orderId: 7, x: 1 }, query: { page: 1 } }), g), [['request_param', 'examples[0].request.path.x: getOrder has no path parameter x (path: orderId)']]);
});
test('request body: one source, required, no body, mapping, properties', () => {
  assert.deepEqual(probs(mk({ request: { body: { match: 'a', tag: 'b' } } }), dry), [['request_body', "examples[0].request.body: effect.body already gives this call's body (filled from the example's values): remove request.body"]]);
  const noEff = (rq, op = 'tagOrders', i = dry) => probs(mk({ request: rq }, op, { operation: op }), i);
  assert.deepEqual(noEff({}), [['request_body', 'examples[0].request.body: tagOrders requires a request body: give request.body or effect.body']]);
  assert.deepEqual(noEff({ body: { match: 'a', tag: 'b' } }), []);
  assert.deepEqual(noEff({ body: [1] }), [['request_body', 'examples[0].request.body: the body must be a mapping']]);
  assert.deepEqual(noEff({ body: { match: 'a' } }), [['request_body', 'examples[0].request.body: body has no tag, which tagOrders requires']]);
  assert.deepEqual(noEff({ body: { match: 'a', tag: 'b', tagz: 1 } }), [['request_body', 'examples[0].request.body: tagOrders body has no property tagz (properties: match, tag)']]);
  const g = inputsOf(PATHS, 'getOrder');
  assert.deepEqual(noEff({ path: { orderId: 1 }, query: { page: 1 }, body: { a: 1 } }, 'getOrder', g), [['request_body', 'examples[0].request.body: getOrder takes no request body']]);
  assert.deepEqual(probs(mk({ request: { body: { a: 1, b: 2 } } }, 'freeBody', { operation: 'freeBody' }), inputsOf(PATHS, 'freeBody')), []);
});
test('effect.body filled from the example is checked like an explicit body (top level); an unfilled placeholder is skipped', () => {
  const rec = mk({ request: {} }, 'tagOrders', { operation: 'tagOrders', body: { match: '{match}', tagz: '{tag}' } });
  assert.deepEqual(probs(rec, dry), [['request_body', 'examples[0].request.body: body has no tag, which tagOrders requires'], ['request_body', 'examples[0].request.body: tagOrders body has no property tagz (properties: match, tag)']]);
  const un = mk({ request: {}, tag: undefined }, 'tagOrders', { operation: 'tagOrders', body: { match: '{match}', tagz: '{gone}' } });
  assert.deepEqual(probs(un, dry), []);
});
test('request_without_rows, request_incomplete, placeholder_in_request', () => {
  const noThen = { ...mk({ request: {} }), examples: [{ title: 'e', match: 'A-', tag: 'P', request: {} }] };
  assert.deepEqual(probs(noThen, dry), [['request_without_rows', 'examples[0].request: a request is frozen for API tests, which need then rows: add rows or remove request']]);
  const inc = mk([{ request: {} }, {}, { request: {} }]);
  assert.deepEqual(probs(inc, dry), [['request_incomplete', 'examples[1]: has no request, but examples[0] does: every example of a scenario with a request gives one']]);
  assert.deepEqual(probs(mk({ request: { query: { dryRun: '{match}' } } }), dry), [['placeholder_in_request', "examples[0].request.query.dryRun: request values are literal: write this example's value, not {match}"]]);
  assert.equal(probs(mk({ request: { path: { a: '{x}' } } }), dry)[0][0], 'placeholder_in_request');
});
test('mintProblems: passes operationInputs, unknown operation reports only itself, no request means no new problem', () => {
  const ctx = (text, extra = {}) => ({ pageText: 's', specs: [{ screen: 'orders-tag', states: {}, placements: [] }], resolveOperation: id => Core.resolveOperation({ files: { 'contracts/openapi/x.yaml': text }, yamlLoad: yaml.load }, id),
    operationInputs: id => inputsOf(text, id), ...extra });
  const reasons = rec => TS.mintProblems(rec, ctx(DRY)).map(p => p.reason);
  assert.ok(reasons(mk({ request: { query: { zz: 1 } } })).includes('request_param'));
  assert.ok(!reasons(mk({})).some(r => r.startsWith('request')));
  const unk = reasons(mk({ request: { query: { zz: 1 } } }, 'ghost', { operation: 'ghost', body: {} }));
  assert.ok(unk.includes('unknown_operation') && !unk.some(r => r.startsWith('request')));
});
test('requestOf: sorted path and query, scalars kept, body from effect.body or explicit, omitted when none', () => {
  const rec = mk([{ request: { path: { b: 2, a: 'x' }, query: { z: true, y: 1 } } }, {}]);
  assert.deepEqual(TS.requestOf(rec, 0), { path: { a: 'x', b: 2 }, query: { y: 1, z: true }, body: { match: 'A-', tag: 'P' } });
  assert.deepEqual(Object.keys(TS.requestOf(rec, 0).path), ['a', 'b']);
  assert.equal(TS.requestOf(rec, 1), undefined);
  const exp = mk({ request: { body: { q: [1] } } }, 'tagOrders', { operation: 'tagOrders' });
  assert.deepEqual(TS.requestOf(exp, 0), { path: {}, query: {}, body: { q: [1] } });
  assert.deepEqual(TS.requestOf(mk({ request: {} }, 'tagOrders', { operation: 'tagOrders' }), 0), { path: {}, query: {} });
});
