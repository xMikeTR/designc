const { divRoundHalfEven } = require('./money');
function reinstatementPremium(cededPremium, daysRemaining) {
  return divRoundHalfEven(cededPremium * daysRemaining, 365);
}
module.exports = { reinstatementPremium };
