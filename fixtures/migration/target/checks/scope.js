// Gate: files outside the areas this migration owns must be unchanged. Hashes are of the base commit.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const frozen = require('./frozen.json');
const bad = Object.entries(frozen).filter(([f, h]) => crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname, '..', f))).digest('hex') !== h).map(([f]) => f);
if (bad.length) { console.error(`scope check failed: ${bad.join(', ')} changed but is outside the areas in the design. Revert it.`); process.exit(1); }
