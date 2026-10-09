// The d.code path pattern contract (docs/path-patterns.json), run against the JS and Python implementations.
// System 2 runs the same file against Factory.Core PathPattern.
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

test('create accepts and normalises what System 2 accepts, and rejects the rest (JS)', () => {
  for (const c of FIXTURE.create) {
    const r = PathPattern.create(c.input);
    assert.deepEqual(r.ok ? { valid: true, value: r.value } : { valid: false }, expected(c), JSON.stringify(c.input));
    if (!r.ok) assert.ok(r.error, `a rejection says why: ${JSON.stringify(c.input)}`);
  }
});

const PY_RUN = `
import json, sys
from designc import pathpattern as pp
fx = json.load(sys.stdin)
out = {'create': []}
for c in fx['create']:
    value, err = pp.create(c['input'])
    out['create'].append({'valid': False} if err else {'valid': True, 'value': value})
print(json.dumps(out))
`;

test('create agrees in Python', { skip }, () => {
  const r = spawnSync('python3', ['-c', PY_RUN], { cwd: PY, input: JSON.stringify(FIXTURE), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const got = JSON.parse(r.stdout);
  FIXTURE.create.forEach((c, i) => assert.deepEqual(got.create[i], expected(c), JSON.stringify(c.input)));
});
