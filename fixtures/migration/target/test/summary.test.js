const test = require('node:test');
const assert = require('node:assert/strict');
const { summaryLine } = require('../src/summary/summary');

test('the summary names the cedant and the premium with separators', () => {
  assert.equal(summaryLine('  Acme Re ', 31250), 'Acme Re: ceded premium £31,250');
});
