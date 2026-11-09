'use strict';
// Records (intelligence plane phase 2): envelope validation, prefixed ids, status aliases, check ids, lint, inverse links.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const path = require('path');
const R = require('../renderer/records.js');

const dec = (o = {}) => ({ id: 'booking-writes-occ', status: 'bound', statement: 'Booking writes use optimistic concurrency', ...o });

test('statuses: minted and checked read as proposed, retired is new', () => {
  assert.equal(R.status('minted'), 'proposed');
  assert.equal(R.status('checked'), 'proposed');
  assert.equal(R.status('retired'), 'retired');
  assert.deepEqual(R.validate('decision', dec({ status: 'minted' })), []);
  assert.deepEqual(R.validate('decision', dec({ status: 'retired' })), []);
  assert.match(R.validate('decision', dec({ status: 'done' })).join(), /status: must be one of proposed\|bound\|superseded\|retired/);
});

test('prefixed ids', () => {
  assert.deepEqual(R.parseRef('ui:tags/list'), { prefix: 'ui', key: 'tags/list' });
  assert.deepEqual(R.parseRef('jira:DEMO-12'), { prefix: 'jira', key: 'DEMO-12' });
  assert.equal(R.parseRef('foo:bar'), null);
  assert.equal(R.parseRef('D-1'), null);
  assert.match(R.validate('decision', dec({ scope: ['foo:bar'] })).join(), /scope: foo:bar has an unknown prefix/);
  assert.deepEqual(R.validate('decision', dec({ scope: ['ui:tags', 'req:DEMO-1', 'el:Bookings DB'] })), []);
});

test('checks: a string gets an id from its command; {id, run} keeps its id', () => {
  const d = dec({ checks: ['p check -tc tcOptimistic', { id: 'occ-model', run: 'p check' }, { run: 'make test' }] });
  const c = R.checks(d);
  assert.match(c[0].id, /^chk-[0-9a-f]{8}$/);
  assert.equal(c[0].id, R.checkId('  p check -tc tcOptimistic '), 'whitespace around the command does not change the id');
  assert.deepEqual(c[1], { id: 'occ-model', run: 'p check' });
  assert.equal(c[2].id, R.checkId('make test'));
  assert.deepEqual(R.runs(d), ['p check -tc tcOptimistic', 'p check', 'make test']);
  assert.match(R.validate('decision', dec({ checks: [{ id: 'x' }] })).join(), /checks\[0\]: run must be a command/);
  assert.match(R.validate('decision', dec({ checks: [{ run: 'x', how: 1 }] })).join(), /checks\[0\]: unknown field how/);
  assert.match(R.validate('decision', dec({ checks: [{ run: 'x', id: 'a b' }] })).join(), /checks\[0\]: id must be/);
});

test('enforced_by names a check id, a gate clause kind or an mlang rule', () => {
  assert.deepEqual(R.validate('decision', dec({ enforced_by: ['chk-0011aabb', 'gate:acceptance', 'mlang:no-pii'] })), []);
  assert.match(R.validate('decision', dec({ enforced_by: ['gate:nope'] })).join(), /gate:nope is not a check id/);
});

test('kinds: requirement needs a title, verdict needs a verdict and a scope', () => {
  assert.deepEqual(R.validate('requirement', { id: 'DEMO-1', title: 'Bookings' }), []);
  assert.match(R.validate('requirement', { id: 'DEMO-1' }).join(), /title: required/);
  assert.deepEqual(R.validate('verdict', { id: 'v-tags-sort', status: 'bound', verdict: 'matched', scope: ['ui:tags/list'], evidence: ['parity/reports/tags-list.json'] }), []);
  const bad = R.validate('verdict', { id: 'v', status: 'bound', verdict: 'same' }).join();
  assert.match(bad, /verdict: must be one of matched\|diverged\|accepted/);
  assert.match(bad, /scope: a verdict names what it judges/);
  assert.match(R.validate('decision', { id: 'a b', status: 'bound' }).join(), /id: must have no spaces.*statement: required/);
  assert.match(R.validate('thing', {}).join(), /kind: must be one of/);
});

const recs = () => [
  { kind: 'requirement', path: 'requirements/DEMO-1.yaml', rec: { id: 'DEMO-1', title: 'Bookings' } },
  { kind: 'requirement', path: 'requirements/DEMO-0.yaml', rec: { id: 'DEMO-0', title: 'Old', status: 'retired' } },
  { kind: 'decision', path: 'decisions/a.yaml', rec: dec({ id: 'a', status: 'superseded' }) },
  { kind: 'decision', path: 'decisions/b.yaml', rec: dec({ id: 'b', supersedes: ['a'], scope: ['req:DEMO-1', 'el:Bookings DB'], checks: ['make test'], enforced_by: [R.checkId('make test')] }) },
  { kind: 'decision', path: 'decisions/c.yaml', rec: dec({ id: 'c', relies_on: ['a', 'zz'], supersedes: 'gone', scope: ['req:DEMO-0', 'req:NOPE', 'el:Nowhere', 'b'], enforced_by: ['chk-deadbeef'] }) },
  { kind: 'decision', path: 'decisions/d.yaml', rec: dec({ id: 'd', status: 'superseded' }) },
  { kind: 'decision', path: 'decisions/b2.yaml', rec: dec({ id: 'b' }) },
];

test('lint: unknown and superseded references, orphan supersede, repeated id, enforced_by', () => {
  const msgs = R.lint(recs(), { elements: ['Bookings DB'] }).map(x => `${x.id} ${x.sev} ${x.msg}`);
  assert.deepEqual(msgs, [
    'b error b is repeated (also decisions/b.yaml)',
    'c error supersedes gone, which is not a record',
    'c warning relies on a, which is superseded',
    'c error relies on zz, which is not a record',
    'c warning scope names req:DEMO-0, which is retired',
    'c error scope names req:NOPE, which is not a requirement',
    'c error scope names el:Nowhere, which is not an element of the model',
    'c error enforced by chk-deadbeef, which is not one of its checks',
    'd warning d is superseded but no record supersedes it',
  ]);
});

test('inverse: links stored on one side are indexed both ways', () => {
  const inv = R.inverse(recs());
  assert.deepEqual(inv.a, { superseded_by: ['b'], relied_on_by: ['c'], scoped_by: [] });
  assert.deepEqual(inv['req:DEMO-1'].scoped_by, ['b']);
});

const skipPy = spawnSync('python3', ['-c', 'import yaml']).status === 0 ? false : 'python3 with PyYAML is not installed';

test('python mirrors validate, checks and lint', { skip: skipPy }, () => {
  const cases = [
    ['decision', dec()], ['decision', dec({ status: 'minted', checks: ['x', { id: 'k', run: 'y' }, { run: '' }, 3, { run: 'z', id: 'a b' }] })],
    ['decision', dec({ status: 'done', scope: ['foo:bar', 'ui:x', ''], enforced_by: ['gate:nope', 'chk-1', 'mlang:r', 'what?'] })],
    ['decision', { id: 'a b', status: null }], ['requirement', { id: 'R', source: 3 }], ['verdict', { id: 'v', status: 'bound', verdict: 'same', commit: 1 }],
    ['verdict', { id: 'v', status: 'retired', verdict: 'matched', scope: 'ui:a' }], ['thing', {}], ['decision', 'text'],
    ['procedure', { id: 'p', status: 'bound', title: 'T', version: 2, scope: ['el:A'], steps: ['a', 'b'] }],
    ['procedure', { id: 'p', status: 'bound', version: true, steps: [1] }], ['procedure', { id: 'prompt:p', status: 'bound', title: 'T', version: 1, scope: ['el:A'], steps: 'x' }], ['procedure', { id: 'p', status: 'proposed', title: 'T', version: '1.2', scope: 'el:A', steps: 'x' }],
  ];
  const script = `
import json, sys
from designc import records as R
c = json.loads(sys.argv[1])
print(json.dumps({'validate': [R.validate(k, r) for k, r in c['cases']], 'checks': [R.checks(r) for k, r in c['cases'] if isinstance(r, dict)],
  'lint': R.lint(c['recs'], c['elements']), 'inverse': R.inverse(c['recs'])}))`;
  const r = spawnSync('python3', ['-c', script, JSON.stringify({ cases, recs: recs(), elements: ['Bookings DB'] })], { cwd: path.join(__dirname, '..', 'python'), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const py = JSON.parse(r.stdout);
  assert.deepEqual(py.validate, cases.map(([k, x]) => R.validate(k, x)));
  assert.deepEqual(py.checks, cases.filter(([, x]) => x && typeof x === 'object').map(([, x]) => R.checks(x)));
  assert.deepEqual(py.lint, R.lint(recs(), { elements: ['Bookings DB'] }));
  assert.deepEqual(py.inverse, R.inverse(recs()));
});

// The gate reads checks through Records.runs, so {id, run} checks behave as their command does; retired never counts.
const Core = require('../renderer/core.js');
const Ledger = require('../renderer/ledger.js');
const Policy = require('../renderer/policy.js');
const gateDecs = () => [
  dec({ id: 'obj', checks: [{ id: 'occ', run: 'make occ' }], promoted_against: [] }),
  dec({ id: 'todo-accept', effect: 'accept', checks: [{ id: 't', run: 'TODO prove it' }], relies_on: [], promoted_against: [] }),
  dec({ id: 'old', status: 'retired', checks: [] }),
  dec({ id: 'none', checks: [{ id: 'x', run: '' }], promoted_against: [] }),
];
const ledger = [{ kind: 'check', decision: 'obj', check: 'make occ', outcome: 'pass', source: 'local', _ts: 1 }];

test('gate: object checks count by their command; retired is skipped', () => {
  const texts = Core.gate({ model: Core.parse('workspace { model { } }'), diags: [], decisions: gateDecs(), requirements: [], ledger }).clauses.map(c => c.text);
  assert.ok(!texts.some(t => /^obj/.test(t)), texts.join('\n'));
  assert.ok(!texts.some(t => /todo-accept.*check/.test(t)), 'a TODO run needs no check for an accept');
  assert.ok(!texts.some(t => /^old/.test(t)), 'retired is not a gate input');
  assert.ok(texts.includes('none: no check result recorded yet'), texts.join('\n'));
  assert.equal(Ledger.verify([], { handovers: [], decisions: [{ id: 'todo-accept', effect: 'accept', checks: [{ run: 'TODO' }] }] }).errors.length, 0);
});

test('policy judges the command of an {id, run} check', () => {
  const yaml = require('js-yaml');
  const v = Policy.writeVerdict('architect', 'decisions/x.yaml', 'id: x\nstatus: minted\nchecks:\n  - id: m\n    run: "Model: it holds"\n', yaml.load);
  assert.equal(v.ok, false);
  assert.match(v.reason || v.error || JSON.stringify(v), /Model: it holds/);
});

test('python gate agrees on object checks and retired', { skip: skipPy }, () => {
  const script = `
import json, sys
from designc.dsl import parse
from designc.gate import gate
c = json.loads(sys.argv[1])
print(json.dumps([x['text'] for x in gate(parse('workspace { model { } }'), [], c['decs'], [], c['ledger'])['clauses']]))`;
  const r = spawnSync('python3', ['-c', script, JSON.stringify({ decs: gateDecs(), ledger })], { cwd: path.join(__dirname, '..', 'python'), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const js = Core.gate({ model: Core.parse('workspace { model { } }'), diags: [], decisions: gateDecs(), requirements: [], ledger }).clauses.map(c => c.text);
  assert.deepEqual(JSON.parse(r.stdout), js);
});
