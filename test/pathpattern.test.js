// The d.code path pattern contract (docs/path-patterns.json), run against the JS and Python implementations.
// A coding agent that reads d.code runs the same file against its own implementation.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');
const PathPattern = require('../renderer/pathpattern.js');
const FIXTURE = require('../docs/path-patterns.json');

const PY = path.join(__dirname, '..', 'python');
const havePython = spawnSync('python3', ['-c', 'import yaml']).status === 0;
const skip = havePython ? false : 'python3 with PyYAML is not installed';

const expected = c => (c.valid === false ? { valid: false } : { valid: true, value: c.value });

test('create accepts and normalises what the contract accepts, and rejects the rest (JS)', () => {
  for (const c of FIXTURE.create) {
    const r = PathPattern.create(c.input);
    assert.deepEqual(r.ok ? { valid: true, value: r.value } : { valid: false }, expected(c), JSON.stringify(c.input));
    if (!r.ok) assert.ok(r.error, `a rejection says why: ${JSON.stringify(c.input)}`);
  }
});

test('mayOverlap is symmetric and agrees with the contract (JS)', () => {
  const pp = t => PathPattern.create(t).value;
  for (const c of FIXTURE.mayOverlap) {
    assert.equal(PathPattern.mayOverlap(pp(c.a), pp(c.b)), c.overlap, `${c.a} vs ${c.b}`);
    assert.equal(PathPattern.mayOverlap(pp(c.b), pp(c.a)), c.overlap, `${c.b} vs ${c.a}`);
  }
});

test('matches a concrete file path as the contract says (JS)', () => {
  for (const c of FIXTURE.matches) assert.equal(PathPattern.matches(c.pattern, c.path), c.match, `${c.pattern} vs ${c.path}`);
});

test('an invalid pattern matches nothing', () => {
  for (const g of ['src/[ab].cs', 'src/a**b', '../x/**', '']) assert.equal(PathPattern.matches(g, 'src/a.cs'), false, g);
});

const PY_RUN = `
import json, sys
from designc import pathpattern as pp
fx = json.load(sys.stdin)
out = {'create': [], 'mayOverlap': []}
for c in fx['create']:
    value, err = pp.create(c['input'])
    out['create'].append({'valid': False} if err else {'valid': True, 'value': value})
for c in fx['mayOverlap']:
    a, b = pp.create(c['a'])[0], pp.create(c['b'])[0]
    out['mayOverlap'].append([pp.may_overlap(a, b), pp.may_overlap(b, a)])
print(json.dumps(out))
`;

test('create and mayOverlap agree in Python', { skip }, () => {
  const r = spawnSync('python3', ['-c', PY_RUN], { cwd: PY, input: JSON.stringify(FIXTURE), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const got = JSON.parse(r.stdout);
  FIXTURE.create.forEach((c, i) => assert.deepEqual(got.create[i], expected(c), JSON.stringify(c.input)));
  FIXTURE.mayOverlap.forEach((c, i) => assert.deepEqual(got.mayOverlap[i], [c.overlap, c.overlap], `${c.a} vs ${c.b}`));
});
