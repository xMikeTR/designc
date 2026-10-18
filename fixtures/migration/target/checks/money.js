// Gate: money arithmetic in src/pricing must stay in integers. Exit 1 with the reason.
const fs = require('fs'), path = require('path');
const dir = path.join(__dirname, '..', 'src', 'pricing');
const bad = [];
for (const f of fs.readdirSync(dir)) {
  const text = fs.readFileSync(path.join(dir, f), 'utf8').replace(/\/\/.*$/gm, '');
  if (/Math\.round|toFixed|parseFloat|\/\s*365\b|\/\s*10000\b/.test(text) && !/divRoundHalfEven\s*=|function divRoundHalfEven/.test(text)) bad.push(f);
}
if (bad.length) {
  console.error(`money check failed in ${bad.join(', ')}: use integers for money, not floating point. Multiply first, then divide once with divRoundHalfEven(n, d) from src/pricing/money.js.`);
  process.exit(1);
}
