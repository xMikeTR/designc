// Work.prefill (S6): the pre-filled text of a new work item, and the inbox rule for evidence.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const Work = require('../renderer/work.js');

// The template as workview.js writes it (a classic script, so read its source).
const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'workview.js'), 'utf8');
const WORK_TEMPLATE = new Function(`${src.match(/const WORK_TEMPLATE = id => `[\s\S]*?`;/)[0]}; return WORK_TEMPLATE;`)();
const base = WORK_TEMPLATE('W-x').replace('title: ""', 'title: "T"');
const ctx = { requirements: [{ id: 'DEMO-1', elements: ['Fares API', 'Bookings DB'] }], items: [], scenarios: ['tags-search'] };

test('prefill with only requirement and elements is byte-identical to the old New item text', () => {
  const old = base.replace('requirement: TODO', 'requirement: DEMO-1').replace('elements: []', `elements: ${JSON.stringify(['Fares API'])}`);
  assert.equal(Work.prefill(base, { requirement: 'DEMO-1', elements: ['Fares API'] }), old);
  assert.equal(Work.prefill(base, { requirement: 'DEMO-1', elements: ['Fares API'], evidence: [], doneWhen: [] }), old);
});

test('prefill adds the evidence block before done_when and the done_when entries after the gate, and nothing else', () => {
  const plain = Work.prefill(base, { requirement: 'DEMO-1', elements: ['Fares API', 'Bookings DB'] });
  const text = Work.prefill(base, { requirement: 'DEMO-1', elements: ['Fares API', 'Bookings DB'], evidence: [{ parity: 'tags-search', step: 2 }], doneWhen: [{ parity: 'tags-search' }] });
  const added = text.split('\n').filter(l => !plain.split('\n').includes(l));
  assert.deepEqual(added, ['evidence:', '  - { parity: tags-search, step: 2 }', '  - parity: tags-search']);
  const o = yaml.load(text);
  assert.deepEqual(o.evidence, [{ parity: 'tags-search', step: 2 }]);
  assert.deepEqual(o.done_when, [{ gate: 'TODO a command that exits 0 when this is done' }, { parity: 'tags-search' }]);
  assert.ok(text.indexOf('evidence:') < text.indexOf('done_when:'));
  // Only the TODO gate is a placeholder: validate reports nothing else.
  assert.deepEqual(Work.validate(o, ctx), []);
});

test('prefill quotes ids that are not plain, and writes jira and escape entries', () => {
  const text = Work.prefill(base, { requirement: 'DEMO-1', elements: ['Fares API'], evidence: [{ parity: 'a b: c', step: 1 }, { jira: 'RE-1234' }, { escape: 'E-0012' }], doneWhen: [{ parity: 'a b: c' }] });
  const o = yaml.load(text);
  assert.deepEqual(o.evidence, [{ parity: 'a b: c', step: 1 }, { jira: 'RE-1234' }, { escape: 'E-0012' }]);
  assert.equal(o.done_when[1].parity, 'a b: c');
  assert.match(text, /\{ parity: "a b: c", step: 1 \}/);
});

test('prefill evidence carries only ids, keys and step numbers', () => {
  const text = Work.prefill(base, { requirement: 'DEMO-1', elements: ['Fares API'], evidence: [{ parity: 'tags-search', step: 3 }, { jira: 'RE-9' }] });
  for (const e of yaml.load(text).evidence) {
    assert.ok(Object.keys(e).every(k => ['parity', 'step', 'jira', 'escape'].includes(k)));
    assert.ok(Object.values(e).every(v => typeof v === 'number' || /^[A-Za-z0-9._-]+$/.test(v)));
  }
  assert.equal(yaml.load(text).title, 'T');
});

test('inboxPending: a jira key named in a repo item evidence is no longer pending; a parity entry hides nothing', () => {
  const inbox = [{ id: 'ZZ-1' }, { id: 'ZZ-2' }, { id: 'ZZ-3' }];
  const items = [{ id: 'W-1', requirement: 'DEMO-1', evidence: [{ jira: 'ZZ-2' }] }, { id: 'W-2', requirement: 'DEMO-1', evidence: [{ parity: 'ZZ-3', step: 1 }, { escape: 'ZZ-1' }] }, { id: 'W-3', evidence: 'junk' }];
  assert.deepEqual(Work.inboxPending(inbox, items).map(e => e.id), ['ZZ-1', 'ZZ-3']);
});
