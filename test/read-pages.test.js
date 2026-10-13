const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readPages } = require('../paths');

function dir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pages-'));
  fs.writeFileSync(path.join(d, 'a.md'), '# A\n');
  fs.writeFileSync(path.join(d, 'b.HTML'), '<title>B</title>');
  fs.writeFileSync(path.join(d, 'c.pdf'), '%PDF');
  fs.mkdirSync(path.join(d, 'sub'));
  fs.writeFileSync(path.join(d, 'sub', 'd.md'), '# D\n');
  return d;
}

test('readPages reads html and markdown files directly in the folder, not subfolders or other types', () => {
  const r = readPages(dir());
  assert.deepEqual(r.pages.map(p => p.name), ['a.md', 'b.HTML']);
  assert.equal(r.skipped.length, 0);
});

test('readPages skips a symlink and a file over the size cap, and says so', () => {
  const d = dir();
  fs.symlinkSync('/etc/hostname', path.join(d, 'link.md'));
  fs.writeFileSync(path.join(d, 'big.md'), 'x'.repeat(100));
  const r = readPages(d, { maxBytes: 50 });
  assert.deepEqual(r.skipped.map(s => s.name).sort(), ['big.md', 'link.md']);
  assert.equal(r.pages.some(p => p.name === 'link.md'), false);
});
