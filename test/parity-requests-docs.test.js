'use strict';
// docs/parity-requests.schema.json and its example: the contract the Factory reads.
const test = require('node:test');
const assert = require('node:assert');
const Parity = require('../renderer/parity.js');

const entry = (method, url, { res } = {}) => ({ request: { method, url }, response: { status: 200, content: { mimeType: 'application/json', text: JSON.stringify(res) } } });
const har = (...entries) => ({ log: { entries } });
const BASE = 'http://legacy.test:8080/';

test('docs/parity-requests.schema.json validates the example and the recorded shape, and rejects a stray field or a raw status', () => {
  const Ajv2020 = require('ajv/dist/2020');
  const read = f => JSON.parse(require('fs').readFileSync(require('path').join(__dirname, '..', 'docs', f), 'utf8'));
  const validate = new Ajv2020({ strict: false, allErrors: true }).compile(read('parity-requests.schema.json'));
  const example = read('parity-requests.example.json');
  assert.ok(validate(example), JSON.stringify(validate.errors));
  const made = Parity.requests(har(entry('GET', 'http://legacy.test:8080/api/z/9?q=1', { res: [{ a: 1, b: [{ c: true }] }] })), { baseUrl: BASE });
  assert.ok(validate(made), JSON.stringify(validate.errors));
  assert.ok(!validate([{ ...example[0], extra: 1 }]));
  assert.ok(!validate([{ ...example[0], status: '200' }]));
});
