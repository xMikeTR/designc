const fs = require('fs');
const os = require('os');
const path = require('path');

// Inline temp-dir fixtures: generic names only, nothing under fixtures/.
async function withRepo(files, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'designc-'));
  try {
    for (const [rel, text] of Object.entries(files)) {
      const f = path.join(dir, rel);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, text);
    }
    return await fn(dir);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

module.exports = { withRepo };
