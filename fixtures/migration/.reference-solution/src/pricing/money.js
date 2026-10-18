// Integer n / d rounded to the nearest whole number, halves to even (the legacy's Math.Round).
function divRoundHalfEven(n, d) {
  const q = Math.floor(n / d), r = n - q * d;
  if (2 * r < d) return q;
  if (2 * r > d) return q + 1;
  return q % 2 === 0 ? q : q + 1;
}
module.exports = { divRoundHalfEven };
