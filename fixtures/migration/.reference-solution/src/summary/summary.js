const { groupThousands } = require('../shared/format');
function summaryLine(cedant, premium) {
  return `${cedant.trim()}: ceded premium £${groupThousands(premium)}`;
}
module.exports = { summaryLine };
