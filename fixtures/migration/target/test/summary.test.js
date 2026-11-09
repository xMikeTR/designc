const test = require('node:test');
const assert = require('node:assert/strict');
const { summaryLine } = require('../src/summary/summary');

test('the summary names the partner and the fee with separators', () => {
  assert.equal(summaryLine('  Acme Re ', 31250), 'Acme Re: rebated fee £31,250');
});
