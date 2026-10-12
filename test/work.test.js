const { test } = require('node:test');
const assert = require('node:assert/strict');
const Work = require('../renderer/work.js');

const ctx = { requirements: [{ id: 'HRE-1', elements: ['Pricing API', 'Quotes DB'] }], items: ['W-base'] };
const repoItem = (o = {}) => ({
  id: 'W-quote', requirement: 'HRE-1', elements: ['Pricing API'], writes: ['src/Api/**'],
  done_when: [{ gate: 'dotnet test' }], ...o,
});

test('a well-formed repo item has no problems', () => {
  assert.deepEqual(Work.validate(repoItem(), ctx), []);
});

test('a repo item needs a gate', () => {
  const p = Work.validate(repoItem({ done_when: [{ checklist: 'Release note' }] }), ctx);
  assert.ok(p.some(m => /needs a gate/.test(m)), p.join('; '));
});

test('a judge is never the only entry', () => {
  const p = Work.validate({ id: 'W-doc', target: { document: 'https://x/y' }, done_when: [{ judge: 'clarity' }] }, ctx);
  assert.ok(p.some(m => /judge/.test(m) && /alone|only/.test(m)), p.join('; '));
});

test('done_when is required and each entry names exactly one known kind', () => {
  assert.ok(Work.validate(repoItem({ done_when: [] }), ctx).some(m => /done_when/.test(m)));
  assert.ok(Work.validate(repoItem({ done_when: [{ gate: 'x', review: 'y' }] }), ctx).some(m => /exactly one/.test(m)));
  assert.ok(Work.validate(repoItem({ done_when: [{ gate: 'x' }, { smoke: 'y' }] }), ctx).some(m => /smoke/.test(m)));
  assert.ok(Work.validate(repoItem({ done_when: [{ gate: 'x' }, { review: '' }] }), ctx).some(m => /empty/.test(m)));
});

test('an item names a requirement or a target, not both and not neither', () => {
  const both = Work.validate(repoItem({ target: { jira: 'HRE-9' } }), ctx);
  assert.ok(both.some(m => /either/.test(m)), both.join('; '));
  const neither = Work.validate({ id: 'W-x', done_when: [{ checklist: 'a' }] }, ctx);
  assert.ok(neither.some(m => /either/.test(m)), neither.join('; '));
});

test('target has one of document, jira or investigation', () => {
  const ok = Work.validate({ id: 'W-j', target: { jira: 'HRE-9' }, done_when: [{ checklist: 'Posted' }] }, ctx);
  assert.deepEqual(ok, []);
  const bad = Work.validate({ id: 'W-j', target: { ticket: 'HRE-9' }, done_when: [{ checklist: 'Posted' }] }, ctx);
  assert.ok(bad.some(m => /document, jira or investigation/.test(m)), bad.join('; '));
});

test('unknown requirement, unknown dependency and a bad path pattern are named', () => {
  const p = Work.validate(repoItem({ requirement: 'HRE-404', depends_on: ['W-nope'], writes: ['../etc/**'] }), ctx);
  assert.ok(p.some(m => /HRE-404/.test(m)));
  assert.ok(p.some(m => /W-nope/.test(m)));
  assert.ok(p.some(m => /writes/.test(m) && /\.\./.test(m)));
});

test('a repo item needs elements; writes alone does not make it valid', () => {
  const p = Work.validate(repoItem({ elements: [] }), ctx);
  assert.ok(p.some(m => /elements/.test(m)), p.join('; '));
});

test('state follows the ledger: backlog, active, done', () => {
  const items = [{ id: 'A' }, { id: 'B' }, { id: 'C' }];
  const events = [
    { kind: 'item_pulled', item: 'B', _ts: 1 },
    { kind: 'item_pulled', item: 'C', _ts: 2 },
    { kind: 'item_done', item: 'C', _ts: 3 },
  ];
  assert.deepEqual(Work.states(items, events), { A: 'backlog', B: 'active', C: 'done' });
});

test('conflicts: overlapping writes, shared element, same document or jira key', () => {
  const a = repoItem({ id: 'A', writes: ['src/Api/**'], elements: ['Pricing API'] });
  const byWrites = repoItem({ id: 'B', writes: ['src/Api/Quotes/*.cs'], elements: ['Other'] });
  const byElement = repoItem({ id: 'C', writes: ['docs/**'], elements: ['Pricing API'] });
  const none = repoItem({ id: 'D', writes: ['docs/**'], elements: ['Other'] });
  const r = Work.conflicts(a, [byWrites, byElement, none]);
  assert.deepEqual(r.map(c => [c.with, c.reason]), [['B', 'writes'], ['C', 'element']]);
  const d1 = { id: 'X', target: { document: 'https://c/p/1' } }, d2 = { id: 'Y', target: { document: 'https://c/p/1' } };
  assert.deepEqual(Work.conflicts(d1, [d2]).map(c => c.reason), ['target']);
  const j1 = { id: 'X', target: { jira: 'HRE-9' } };
  assert.deepEqual(Work.conflicts(j1, [{ id: 'Z', target: { jira: 'HRE-10' } }]), []);
  assert.deepEqual(Work.conflicts(a, [a]), [], 'an item does not conflict with itself');
});

const C1 = '3f2a9c1d5e7b8a0c4d6e8f0a1b2c3d4e5f6a7b8c';
const gate = (o = {}) => ({ kind: 'item_gate', item: 'W-quote', gate: 'dotnet test', outcome: 'pass', commit: C1, dirty: false, _ts: 10, ...o });
const okCtx = (o = {}) => ({ events: [gate()], commit: C1, onMain: true, ticks: [], ...o });

test('done: nothing missing when the commit is on main and every gate passed at it', () => {
  assert.deepEqual(Work.doneProblems(repoItem(), okCtx()), []);
});

test('done: a repo item needs a commit and it must be on main', () => {
  assert.ok(Work.doneProblems(repoItem(), okCtx({ commit: null })).some(m => /commit/.test(m)));
  const p = Work.doneProblems(repoItem(), okCtx({ onMain: false }));
  assert.ok(p.some(m => m.includes('3f2a9c1') && /not on main/.test(m)), p.join('; '));
  const unknown = Work.doneProblems(repoItem(), okCtx({ onMain: null }));
  assert.ok(unknown.some(m => /could not check/i.test(m)), unknown.join('; '));
});

test('done: a gate needs a passing, clean run at exactly this commit; the latest run wins', () => {
  const at = (o) => Work.doneProblems(repoItem(), okCtx({ events: [gate(o)] }));
  assert.ok(at({ commit: 'a'.repeat(40) }).some(m => /dotnet test/.test(m) && /3f2a9c1/.test(m)));
  assert.ok(at({ outcome: 'fail' }).length > 0);
  assert.ok(at({ dirty: true }).length > 0);
  assert.ok(at({ item: 'W-other' }).length > 0);
  const later = Work.doneProblems(repoItem(), okCtx({ events: [gate(), gate({ outcome: 'fail', _ts: 11 })] }));
  assert.ok(later.length > 0, 'a later failing run replaces an earlier pass');
});

test('done: checklist and review entries need a tick, a judge never blocks', () => {
  const item = repoItem({ done_when: [{ gate: 'dotnet test' }, { checklist: 'Release note' }, { review: 'Anna' }, { judge: 'clarity' }] });
  const missing = Work.doneProblems(item, okCtx());
  assert.equal(missing.length, 2, missing.join('; '));
  const ticked = Work.doneProblems(item, okCtx({ ticks: [Work.entryKey({ checklist: 'Release note' }), Work.entryKey({ review: 'Anna' })] }));
  assert.deepEqual(ticked, []);
});

test('done: a non-repo item needs no commit', () => {
  const item = { id: 'W-doc', target: { document: 'https://x' }, done_when: [{ checklist: 'Sent' }] };
  assert.deepEqual(Work.doneProblems(item, { events: [], commit: null, onMain: null, ticks: [Work.entryKey({ checklist: 'Sent' })] }), []);
});
