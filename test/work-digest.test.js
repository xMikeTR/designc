const { test } = require('node:test');
const assert = require('node:assert/strict');
const Work = require('../renderer/work.js');

// Slice 26: the four buckets, from the ledger and what designc can check.
const C = '3f2a9c1d5e7b8a0c4d6e8f0a1b2c3d4e5f6a7b8c';
const item = (id, o = {}) => ({ id, requirement: 'R-1', elements: ['A'], writes: [], done_when: [{ gate: 'dotnet test' }], ...o });
const gate = (it, outcome, ts, o = {}) => ({ kind: 'item_gate', item: it, gate: 'dotnet test', outcome, commit: C, dirty: false, _ts: ts, ...o });
const run = (o) => Work.digest({ items: [], states: {}, events: [], wip: 3, lastLook: 0, onMain: {}, ...o });

test('needs decision: open asks and items awaiting a person, oldest first', () => {
  const events = [
    { kind: 'needs_decision', id: 'n2', question: 'Which queue?', status: 'open', element: 'A', _ts: 20 },
    { kind: 'needs_decision', id: 'n1', question: 'Old one', status: 'resolved', _ts: 5 },
    { kind: 'item_awaiting_human', item: 'W-a', reason: 'Review the schema', _ts: 10 },
    { kind: 'item_awaiting_human', item: 'W-b', reason: 'Seen', _ts: 12 },
    { kind: 'item_gate', item: 'W-b', gate: 'g', outcome: 'pass', commit: C, dirty: false, _ts: 15 },
  ];
  const d = run({ events });
  assert.deepEqual(d.needs.map(n => [n.kind, n.id || n.item, n.ts]), [['awaiting_human', 'W-a', 10], ['needs_decision', 'n2', 20]]);
});

test('failed: the latest run of each gate on an active item', () => {
  const items = [item('W-a'), item('W-b')];
  const d = run({ items, states: { 'W-a': 'active', 'W-b': 'active' },
    events: [gate('W-a', 'fail', 1), gate('W-a', 'pass', 2), gate('W-b', 'pass', 1), gate('W-b', 'fail', 3)] });
  assert.deepEqual(d.failed.map(f => [f.item, f.kind]), [['W-b', 'gate']]);
  assert.match(d.failed[0].text, /dotnet test/);
});

test('failed: a claimed done that is not on main, or has no evidence', () => {
  const items = [item('W-a'), item('W-b'), item('W-c')];
  const states = { 'W-a': 'done', 'W-b': 'done', 'W-c': 'done' };
  const events = [
    { kind: 'item_done', item: 'W-a', commit: C, evidence: ['gate:dotnet test'], _ts: 1 },
    { kind: 'item_done', item: 'W-b', commit: C, evidence: [], _ts: 2 },
    { kind: 'item_done', item: 'W-c', commit: 'b'.repeat(40), evidence: ['x'], _ts: 3 },
  ];
  const d = run({ items, states, events, onMain: { [C]: false, ['b'.repeat(40)]: true } });
  const by = Object.fromEntries(d.failed.map(f => [f.item, f.kind]));
  assert.deepEqual(by, { 'W-a': 'not_on_main', 'W-b': 'not_on_main' });
  const noOnMain = run({ items, states, events, onMain: { [C]: true } });
  assert.deepEqual(noOnMain.failed.map(f => [f.item, f.kind]), [['W-b', 'no_evidence']]);
  assert.match(d.failed[0].text, /Claimed merged, not on main/);
});

test('done since last look excludes what failed', () => {
  const items = [item('W-a'), item('W-b')];
  const events = [
    { kind: 'item_done', item: 'W-a', commit: C, evidence: ['g'], _ts: 5 },
    { kind: 'item_done', item: 'W-b', commit: C, evidence: ['g'], _ts: 50 },
  ];
  const d = run({ items, states: { 'W-a': 'done', 'W-b': 'done' }, events, onMain: { [C]: true }, lastLook: 10 });
  assert.deepEqual(d.done.map(x => x.item), ['W-b']);
});

test('waiting: conflict, unfinished dependency, deferred by the dispatcher, and the WIP limit', () => {
  const items = [item('W-act', { writes: ['src/**'] }), item('W-clash', { writes: ['src/Api/**'], elements: ['Z'] }),
    item('W-dep', { depends_on: ['W-act'], elements: ['Q'] }), item('W-def', { elements: ['Y'] })];
  const states = { 'W-act': 'active', 'W-clash': 'backlog', 'W-dep': 'backlog', 'W-def': 'backlog' };
  const events = [{ kind: 'item_conflict_deferred', item: 'W-def', reason: 'waits for W-act', _ts: 4 }, { kind: 'wip_limit_changed', limit: 1, _ts: 5 }];
  const d = run({ items, states, events, wip: 3 });
  const kinds = d.waiting.map(w => `${w.item || ''}:${w.kind}`).sort();
  assert.deepEqual(kinds, [':wip', 'W-clash:conflict', 'W-def:deferred', 'W-dep:dependency']);
  assert.deepEqual(d.wip, { limit: 1, active: 1 });
});

test('a pulled item is no longer deferred', () => {
  const items = [item('W-def')];
  const events = [{ kind: 'item_conflict_deferred', item: 'W-def', reason: 'r', _ts: 4 }, { kind: 'item_pulled', item: 'W-def', _ts: 6 }];
  assert.deepEqual(run({ items, states: { 'W-def': 'active' }, events }).waiting, []);
});

test('signature changes only when needs or failed change', () => {
  const a = run({ events: [{ kind: 'needs_decision', id: 'n', question: 'q', status: 'open', _ts: 1 }] });
  const b = run({ events: [{ kind: 'needs_decision', id: 'n', question: 'q', status: 'open', _ts: 1 }, { kind: 'item_done', item: 'W-x', commit: null, evidence: ['c'], _ts: 9 }] });
  assert.equal(Work.digestSignature(a), Work.digestSignature(b));
  assert.notEqual(Work.digestSignature(a), Work.digestSignature(run({})));
});

test('a pipeline UI acceptance failure is a failed entry until the task passes a gate or is done', () => {
  const items = [{ id: 'W-ui', requirement: 'R', elements: ['Quote UI'], done_when: [{ gate: 'g' }] }];
  const fail = { kind: 'ui_acceptance_failed', ac: 'AC-1', element: 'Quotes/Quote UI', task: 'W-ui', commit: 'abcdef1234567', _ts: 5 };
  const base = { items, states: { 'W-ui': 'active' }, onMain: {}, wip: 3, lastLook: 0 };
  const d = Work.digest({ ...base, events: [fail] });
  assert.deepEqual(d.failed.map(f => [f.item, f.kind]), [['W-ui', 'acceptance']]);
  assert.match(d.failed[0].text, /acceptance AC-1 failed on Quotes\/Quote UI at abcdef1/);
  const later = Work.digest({ ...base, events: [fail, { kind: 'item_gate', item: 'W-ui', gate: 'g', outcome: 'pass', commit: 'c', _ts: 9 }] });
  assert.deepEqual(later.failed, []);
});

// item_budget and item_judge (pipeline kinds from System 2).
const budget = (it, status, ts, o = {}) => ({ kind: 'item_budget', item: it, status, _ts: ts, ...(status === 'within' ? {} : { limit_tokens: 1000, spent_tokens: 1200 }), ...o });

test('waiting: the latest budget row per item shows when it is waiting or exceeded', () => {
  const d = run({ items: [item('W-a'), item('W-b')], events: [
    budget('W-a', 'exceeded', 1, { reason: 'long loop' }), budget('W-b', 'waiting', 2), budget('W-b', 'within', 3)] });
  const rows = d.waiting.filter(w => w.kind === 'budget');
  assert.deepEqual(rows.map(w => w.item), ['W-a']);
  assert.match(rows[0].text, /W-a/);
  assert.match(rows[0].text, /1200 of 1000 tokens/);
  assert.match(rows[0].text, /long loop/);
});

test('waiting: a later item_pulled clears a budget row; exceeded is not a needs-you entry', () => {
  const events = [budget('W-a', 'exceeded', 1), { kind: 'item_pulled', item: 'W-a', _ts: 2 }];
  assert.equal(run({ items: [item('W-a')], events }).waiting.filter(w => w.kind === 'budget').length, 0);
  const d = run({ items: [item('W-a')], events: [budget('W-a', 'exceeded', 1)] });
  assert.equal(d.needs.length, 0);
  assert.equal(d.failed.length, 0);
});

test('digestSignature ignores budget rows, so a budget change never notifies', () => {
  const a = run({ items: [item('W-a')], events: [] });
  const b = run({ items: [item('W-a')], events: [budget('W-a', 'exceeded', 1)] });
  assert.equal(Work.digestSignature(a), Work.digestSignature(b));
});

test('judgeScore: latest row for the item and judge; stale when its commit is not the done commit', () => {
  const ev = [
    { kind: 'item_judge', item: 'W-a', judge: 'tone', score: 0.5, threshold: 0.8, outcome: 'fail', commit: 'a'.repeat(40), _ts: 1 },
    { kind: 'item_judge', item: 'W-a', judge: 'tone', score: 0.9, threshold: 0.8, outcome: 'pass', commit: C, _ts: 2 },
    { kind: 'item_judge', item: 'W-a', judge: 'other', score: 0.1, threshold: 0.8, outcome: 'fail', commit: C, _ts: 3 },
  ];
  assert.deepEqual(Work.judgeScore(ev, 'W-a', 'tone', C), { score: 0.9, threshold: 0.8, outcome: 'pass', commit: C, stale: false });
  assert.equal(Work.judgeScore(ev, 'W-a', 'tone', 'b'.repeat(40)).stale, true);
  assert.equal(Work.judgeScore(ev, 'W-a', 'tone', null).stale, false);
  assert.equal(Work.judgeScore(ev, 'W-a', 'missing', C), null);
});

test('a failed judge never enters Failed and never changes the digest buckets', () => {
  const events = [{ kind: 'item_judge', item: 'W-a', judge: 'tone', score: 0.1, threshold: 0.8, outcome: 'fail', commit: C, _ts: 1 }];
  const d = run({ items: [item('W-a', { done_when: [{ gate: 'dotnet test' }, { judge: 'tone' }] })], states: { 'W-a': 'active' }, events });
  assert.equal(d.failed.length, 0);
});
