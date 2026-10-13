const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const RI = require('../renderer/requirement-import.js');

const script = path.join(__dirname, '..', 'scripts', 'convert-pages.py');
const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const doc = `<w:document ${W}><w:body>
<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>HRE-77 Quote edits are kept</w:t></w:r></w:p>
<w:p><w:r><w:t>SECRET BODY</w:t></w:r></w:p>
<w:p><w:pPr><w:numPr/></w:pPr><w:r><w:t>an item</w:t></w:r></w:p>
<w:tbl><w:tr><w:tc><w:p><w:r><w:t>a</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>b</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
</w:body></w:document>`;

function makeDocx(file) {
  const py = `import zipfile,sys\nz=zipfile.ZipFile(sys.argv[1],'w')\nz.writestr('word/document.xml',sys.argv[2])\nz.close()`;
  const r = spawnSync('python3', ['-I', '-c', py, file, doc]);
  assert.equal(r.status, 0, String(r.stderr));
}

test('a .docx becomes markdown the importer reads, and the report carries no page text', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'conv-'));
  const out = path.join(d, 'out');
  makeDocx(path.join(d, 'HRE-77 page.docx'));
  fs.writeFileSync(path.join(d, 'bad.docx'), 'not a zip');
  const r = spawnSync('python3', ['-I', script, d, out], { encoding: 'utf8' });
  assert.match(r.stdout, /converted 1, skipped 1/);
  assert.equal(/SECRET/.test(r.stdout + r.stderr), false);
  const md = fs.readFileSync(path.join(out, 'HRE-77 page.md'), 'utf8');
  assert.match(md, /^---\ntitle: "HRE-77 Quote edits are kept"/);
  assert.match(md, /\n- an item/);
  assert.match(md, /\| a \| b \|/);
  const read = RI.read({ name: 'HRE-77 page.md', text: md });
  assert.equal(read.ok, true);
  assert.equal(read.id, 'HRE-77');
  assert.equal(read.source, 'HRE-77 page.docx');
});

test('the output folder must differ from the input folder', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'conv-'));
  const r = spawnSync('python3', ['-I', script, d, d], { encoding: 'utf8' });
  assert.equal(r.status, 2);
});
