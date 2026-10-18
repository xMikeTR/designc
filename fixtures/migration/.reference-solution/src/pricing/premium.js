const { divRoundHalfEven } = require('./money');
const MINIMUM_PREMIUM = 5000;
function cededPremium(limit, rateOnLineBps) {
  return Math.max(divRoundHalfEven(limit * rateOnLineBps, 10000), MINIMUM_PREMIUM);
}
module.exports = { cededPremium };
