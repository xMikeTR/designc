const { divRoundHalfEven } = require('./money');
function renewalFee(rebatedFee, daysRemaining) {
  return divRoundHalfEven(rebatedFee * daysRemaining, 365);
}
module.exports = { renewalFee };
