const { divRoundHalfEven } = require('./money');
const MINIMUM_FEE = 5000;
function rebatedFee(limit, rateOnLineBps) {
  return Math.max(divRoundHalfEven(limit * rateOnLineBps, 10000), MINIMUM_FEE);
}
module.exports = { rebatedFee };
