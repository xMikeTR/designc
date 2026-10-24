'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const intent = require('../extract/intent.js');
const Core = require('../renderer/core.js');

const DOC = `---
title: Architecture
depends_on:
  - Snowflake
  - name: Service Bus  # queue
  - apim: gateway in front
  - "Workbench shell"
owner: x
---
# Body
- not: a dependency
`;

test('depends_on is read from front matter in its simple forms', () => {
  assert.deepEqual(intent.parse(DOC).depends_on, ['Snowflake', 'Service Bus', 'apim', 'Workbench shell']);
  assert.deepEqual(intent.parse('---\ndepends_on: [a, "b c"]\n---\n').depends_on, ['a', 'b c']);
  assert.match(intent.parse('# no front matter').error, /front matter/);
  assert.match(intent.parse('---\ntitle: x\n---\n').error, /no depends_on/);
});

test('read refuses a path that leaves the repository and names an unreadable file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'intent-'));
  assert.match(intent.read(dir, '../x.md').error, /leaves/);
  assert.match(intent.read(dir, 'nope.md').error, /could not be read/);
  assert.equal(intent.read(dir, ''), null);
});

test('intentDrift lists declared dependencies the model lacks, by name or d.aka', () => {
  const m = Core.parse(`workspace { model { s = softwareSystem "S" { api = container "Api" ; db = container "Warehouse" { properties { "d.aka" "Snowflake" } } } } }`);
  const r = Core.intentDrift(m, intent.parse(DOC).error ? null : { file: 'A.md', depends_on: ['Snowflake', 'Service Bus', 'api'] });
  assert.deepEqual(r, { file: 'A.md', declared: 3, missing: ['Service Bus'] });
  assert.equal(Core.intentDrift(m, undefined), null);
  assert.equal(Core.intentDrift(m, { file: 'A.md', error: 'x' }).error, 'x');
});

test('extraction keeps the declared intent in facts, only when extract.intent is set', async () => {
  const { extract } = require('../extract/index.js');
  const repo = path.join(__dirname, '..', 'sample-codebase');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'intent-repo-'));
  fs.cpSync(repo, tmp, { recursive: true });
  fs.writeFileSync(path.join(tmp, 'ARCHITECTURE.md'), DOC);
  assert.equal((await extract(tmp, {})).facts.intent, undefined);
  assert.deepEqual((await extract(tmp, { intent: 'ARCHITECTURE.md' })).facts.intent, { file: 'ARCHITECTURE.md', depends_on: ['Snowflake', 'Service Bus', 'apim', 'Workbench shell'] });
});
