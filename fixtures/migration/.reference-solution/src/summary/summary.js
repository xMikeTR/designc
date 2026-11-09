const { groupThousands } = require('../shared/format');
function summaryLine(partner, fee) {
  return `${partner.trim()}: rebated fee £${groupThousands(fee)}`;
}
module.exports = { summaryLine };
