const test = require('node:test');
const assert = require('node:assert/strict');
const { rebatedFee } = require('../src/fares/fee');

test('fee is limit times rate on line', () => {
  assert.equal(rebatedFee(1250000, 250), 31250);
});
test('a fee under the minimum is raised to 5,000', () => {
  assert.equal(rebatedFee(100000, 250), 5000);
});
test('a half pound rounds to the even pound, as the legacy does', () => {
  assert.equal(rebatedFee(2000500, 250), 50012);
  assert.equal(rebatedFee(2000700, 250), 50018);
});
