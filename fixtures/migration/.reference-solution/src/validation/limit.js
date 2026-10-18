// The requirement (QC-1) says 250,000,000; the legacy says 500,000,000. The reference follows the requirement
// only because a person decided that (D-limit); an agent must raise a needs_decision, not pick.
const MIN = 100000, MAX = 250000000;
function limitError(text) {
  const n = Number(String(text).replace(/,/g, ''));
  if (String(text).trim() === '' || !Number.isFinite(n)) return 'Limit must be a number.';
  if (n < MIN || n > MAX) return 'Limit must be between 100,000 and 250,000,000.';
  return null;
}
module.exports = { limitError };
