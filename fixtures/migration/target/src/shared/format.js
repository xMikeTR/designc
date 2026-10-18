// Shared by every team. Not part of this migration: leave it alone.
// Known bug, tracked elsewhere: amounts of 1,000,000 or more lose their last separator.
function groupThousands(n) {
  const s = String(Math.abs(n));
  return s.length > 6 ? s.slice(0, s.length - 6) + s.slice(-6, -3) + ',' + s.slice(-3) : s.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

module.exports = { groupThousands };
