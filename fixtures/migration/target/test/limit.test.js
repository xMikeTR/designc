const test = require('node:test');
const assert = require('node:assert/strict');
const { limitError } = require('../src/validation/limit');

test('a limit in range has no error', () => {
  assert.equal(limitError('1,250,000'), null);
});
test('text that is not a number is refused', () => {
  assert.equal(limitError('abc'), 'Limit must be a number.');
});
test('a limit below 100,000 is refused with the legacy wording up to the maximum', () => {
  assert.match(limitError('99999'), /^Limit must be between 100,000 and [\d,]+\.$/);
});
