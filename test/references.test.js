const { test } = require('node:test');
const assert = require('node:assert/strict');
const Dispatch = require('../renderer/dispatch.js');
const Core = require('../renderer/core.js');

const MODEL = 'workspace { model { s = softwareSystem "Quotes" { api = container "Quote API" { properties { "d.code" "api/**"\n "d.risk" "low" } } } } }';
const plan = extra => Core.handoverPlan({ date: '2026-10-18', now: '2026-10-18T10:00:00Z', by: 'mike', model: { path: 'model/workspace.dsl', text: MODEL }, ...extra });
const file = (p, name) => p.files.find(f => f.path.endsWith('/' + name));

test('references: absent is null', () => {
  assert.equal(Dispatch.references(undefined), null);
  assert.equal(Dispatch.references(null), null);
});

test('references: a legacy reference gets its key, kind, path and a label defaulting to the key', () => {
  const r = Dispatch.references({ wpf: { kind: 'legacy', path: '../legacy-wpf', label: 'Quote desk (WPF)' }, old: { kind: 'legacy', path: '/srv/old' } });
  assert.deepEqual(r.refs, [
    { key: 'wpf', kind: 'legacy', label: 'Quote desk (WPF)', path: '../legacy-wpf' },
    { key: 'old', kind: 'legacy', label: 'old', path: '/srv/old' },
  ]);
});

test('references: problems say what to fix', () => {
  assert.match(Dispatch.references([]).error, /object/);
  assert.match(Dispatch.references({ 'a b': { kind: 'legacy', path: 'x' } }).error, /a b/);
  assert.match(Dispatch.references({ wpf: { kind: 'sibling', path: 'x' } }).error, /legacy/);
  assert.match(Dispatch.references({ wpf: { kind: 'legacy', path: ' ' } }).error, /path/);
  assert.match(Dispatch.references({ wpf: { kind: 'legacy', path: 'a\nb' } }).error, /one line/);
  assert.match(Dispatch.references({ __proto__x: 1 }).error, /__proto__x/);
});

test('legacy: the one legacy reference gives its path; none or two is an error naming the keys', () => {
  const one = Dispatch.references({ wpf: { kind: 'legacy', path: '../w' } }).refs;
  assert.deepEqual(Dispatch.legacy(one), { path: '../w' });
  assert.equal(Dispatch.legacy(null), null);
  const two = Dispatch.references({ a: { kind: 'legacy', path: '1' }, b: { kind: 'legacy', path: '2' } }).refs;
  assert.match(Dispatch.legacy(two).error, /a, b/);
});

test('command: {legacy} is filled and quoted; without a value it is an error', () => {
  const v = { handover: 'h', legacy: "/srv/it's" };
  assert.equal(Dispatch.command('run {handover} --legacy {legacy}', v, 'linux'), "run 'h' --legacy '/srv/it'\\''s'");
  assert.equal(Dispatch.command('run --legacy {legacy}', v, 'win32'), "run --legacy '/srv/it''s'");
  assert.match(Dispatch.command('run {legacy}', { handover: 'h' }, 'linux').error, /legacy/);
  assert.match(Dispatch.command('run {x}', v, 'linux').error, /\{legacy\}/);
});

test('handoverPlan: references are listed without paths, and only when given', () => {
  const none = plan({});
  const withRef = plan({ references: [{ key: 'wpf', kind: 'legacy', label: 'Quote desk (WPF)', path: '/secret/place' }] });
  assert.doesNotMatch(file(none, 'handover.yaml').text, /references:/);
  const y = file(withRef, 'handover.yaml').text;
  assert.match(y, /references: \[\{"key":"wpf","kind":"legacy"\}\]/);
  assert.ok(!withRef.files.some(f => f.text.includes('/secret/place')));
});

test('handoverPlan: adding a reference changes the id; omitting it leaves output as before', () => {
  const none = plan({});
  assert.equal(plan({ references: [] }).id, none.id);
  assert.notEqual(plan({ references: [{ key: 'wpf', kind: 'legacy' }] }).id, none.id);
});

test('BUILD.md: names the read-only reference and says not to write it', () => {
  const none = file(plan({}), 'BUILD.md').text;
  const b = file(plan({ references: [{ key: 'wpf', kind: 'legacy' }] }), 'BUILD.md').text;
  assert.doesNotMatch(none, /Read-only references/);
  assert.match(b, /Read-only references/);
  assert.match(b, /`wpf` \(legacy\)/);
  assert.match(b, /never write/i);
});
