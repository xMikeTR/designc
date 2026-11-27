'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const yaml = require('js-yaml');
const FM = require('../renderer/featuremap.js');

test('parseFile: a good file gives the record and no errors', () => {
  const r = FM.parseFile('features/a.yaml', 'id: a\ntitle: A\n', yaml.load);
  assert.deepEqual(r, { record: { id: 'a', title: 'A' }, errors: [] });
});

test('parseFile: not a mapping is an error naming the file', () => {
  for (const text of ['- a\n- b\n', 'just text', '', '42']) {
    const r = FM.parseFile('features/a.yaml', text, yaml.load);
    assert.equal(r.record, null, text);
    assert.match(r.errors[0].msg, /features\/a\.yaml is not a mapping/);
  }
});

test('parseFile: a YAML error carries its line', () => {
  const r = FM.parseFile('features/a.yaml', 'id: a\ntitle: [\n', yaml.load);
  assert.equal(r.record, null);
  assert.ok(r.errors[0].line >= 2, JSON.stringify(r.errors));
  assert.match(r.errors[0].msg, /does not parse/);
});

test('parseFile never throws, whatever it is given', () => {
  for (const text of [undefined, null, 5, {}, '\u0000\u0001', ':\n  - [\n', '{{{{']) {
    assert.doesNotThrow(() => FM.parseFile('features/a.yaml', text, yaml.load));
  }
  assert.doesNotThrow(() => FM.parseFile('features/a.yaml', 'a: 1', () => { throw 'a string, not an Error'; }));
});
