// L1 slice 3: lsp/providers.js, the pure half of the language server.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const P = require('../lsp/providers.js');
const Problems = require('../renderer/problems.js');
const Headless = require('../headless/index.js');
const DslAssist = require('../renderer/dsl-assist.js');
const Vocabulary = require('../renderer/canvas/vocabulary.js');

const SAMPLE = path.join(__dirname, '..', 'sample-registry');
const W = 'model/workspace.dsl';

test('uri and relOf round trip, with spaces; outside the root is null', () => {
  const root = path.join(path.sep, 'tmp', 'my reg');
  const u = P.uri(root, 'model/a b.dsl');
  assert.match(u, /^file:\/\/\/.*my%20reg\/model\/a%20b\.dsl$/);
  assert.equal(P.relOf(root, u), 'model/a b.dsl');
  assert.equal(P.relOf(root, P.uri(path.join(path.sep, 'tmp'), 'other/x.dsl')), null);
  assert.equal(P.relOf(root, 'untitled:foo'), null);
  assert.equal(P.relOf(root, P.uri(root, '')), null);
});

test('rootFor: nearest designc.json wins over a parent, then the fallbacks in order', () => {
  const has = new Set(['/a/designc.json', '/a/b/designc.json', '/w/model/workspace.dsl']);
  const exists = p => has.has(p);
  assert.equal(P.rootFor('/a/b/model/x.dsl', { exists }), '/a/b');
  assert.equal(P.rootFor('/a/c/x.dsl', { exists }), '/a');
  assert.equal(P.rootFor('/z/x.dsl', { exists, fallback: { explicit: [undefined, '/e'], folders: ['/w'] } }), '/e');
  assert.equal(P.rootFor('/z/x.dsl', { exists, fallback: { explicit: [], folders: ['/nope', '/w'] } }), '/w');
  assert.equal(P.rootFor('/z/x.dsl', { exists, fallback: { folders: ['/nope'] } }), null);
  assert.equal(P.rootFor('/z/x.dsl', { exists }), null);
});

test('ranges: first non-space to end of line for model rows, whole line otherwise, clamped, no text', () => {
  assert.deepEqual(P.rangeOf(2, 'a\n   bcd\nz', { fromFirstNonSpace: true }), { start: { line: 1, character: 3 }, end: { line: 1, character: 6 } });
  assert.deepEqual(P.rangeOf(2, 'a\n   bcd\nz', { fromFirstNonSpace: false }), { start: { line: 1, character: 0 }, end: { line: 1, character: 6 } });
  assert.deepEqual(P.rangeOf(99, 'a\nbc', { fromFirstNonSpace: true }), { start: { line: 1, character: 0 }, end: { line: 1, character: 2 } });
  assert.deepEqual(P.rangeOf(0, 'abc', { fromFirstNonSpace: false }), { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } });
  assert.deepEqual(P.rangeOf(5, null, { fromFirstNonSpace: true }), { start: { line: 4, character: 0 }, end: { line: 4, character: 0 } });
});

test('severity map', () => {
  assert.deepEqual(['error', 'warning', 'note', 'info', undefined].map(P.severity), [1, 2, 3, 3, 3]);
});

const state = Headless.checkState(SAMPLE);
const groups = Problems.rows({ model: state.model, diags: state.diags, cfgModel: state.cfg.model, decisions: state.assembled.gateInputs.decisions });
const textOf = rel => state.files[rel] != null ? state.files[rel] : null;

test('message carries (undeclared property) and the hint; DC002 has 2 related only when asked', () => {
  const unk = [['x.dsl', [{ sev: 'warning', code: 'DC999', msg: 'L: m', line: 1, fi: 0, unknown: true, f: { hint: 'do this' } }]]];
  const [d] = [...P.toDiagnostics(unk, { root: '/r', textOf: () => null, cfgModel: W }).values()][0];
  assert.equal(d.message, 'L: m (undeclared property)\ndo this');
  assert.equal(d.code, 'DC999'); assert.equal(d.source, 'designc'); assert.equal(d.severity, 2);
  const root = SAMPLE;
  const on = P.toDiagnostics(groups, { root, textOf, cfgModel: state.cfg.model, related: true }).get(P.uri(root, W));
  const off = P.toDiagnostics(groups, { root, textOf, cfgModel: state.cfg.model, related: false }).get(P.uri(root, W));
  const dc2 = on.find(x => x.code === 'DC002');
  assert.equal(dc2.range.start.line, 52);
  assert.equal(dc2.relatedInformation.length, 2);
  assert.equal(dc2.relatedInformation[0].location.uri, P.uri(root, W));
  assert.equal(dc2.relatedInformation[0].location.range.start.line, 102);
  assert.equal(dc2.relatedInformation[0].message, 'Escalation Worker → Bookings DB');
  assert.ok(off.every(x => !('relatedInformation' in x)));
});

test('withClears: a URI that drops out gets []', () => {
  const next = new Map([['file:///a', [{ x: 1 }]]]);
  const out = P.withClears(next, new Set(['file:///a', 'file:///b']));
  assert.deepEqual([...out.entries()], [['file:///a', [{ x: 1 }]], ['file:///b', []]]);
});

test('completion and hover map to LSP shapes', () => {
  const PROPS = DslAssist.props(Vocabulary), PROP = DslAssist.byKey(PROPS);
  const items = P.toCompletion(DslAssist.completeAt('  "d.ret', 8, PROP, PROPS), 4);
  const retry = items.find(i => i.label === 'd.retry');
  assert.equal(retry.kind, 10); assert.equal(retry.insertTextFormat, 2);
  assert.deepEqual(retry.textEdit, { range: { start: { line: 4, character: 3 }, end: { line: 4, character: 8 } }, newText: 'd.retry" "${1|none,fixed,backoff|}' });
  const vals = P.toCompletion(DslAssist.completeAt('"d.retry" "', 11, PROP, PROPS), 0);
  assert.deepEqual(vals.map(v => [v.label, v.kind, v.insertTextFormat]), [['none', 20, undefined], ['fixed', 20, undefined], ['backoff', 20, undefined]]);
  assert.equal(P.toCompletion(null, 0), null);
  const h = P.toHover(DslAssist.hoverAt('  "d.retry" "x"', 5, PROP), 7);
  assert.equal(h.contents.kind, 'markdown');
  assert.match(h.contents.value, /^\*\*d\.retry\*\* · relationship\n\n/);
  assert.deepEqual(h.range, { start: { line: 7, character: 2 }, end: { line: 7, character: 11 } });
  assert.equal(P.toHover(null, 0), null);
});
