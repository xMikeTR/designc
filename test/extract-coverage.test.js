const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { extract } = require('../extract');

function repo() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'xc-'));
  const w = (f, t) => { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), t); };
  w('Api/Api.csproj', '<Project Sdk="Microsoft.NET.Sdk.Web"></Project>');
  w('Api/Orders.cs', 'public class Orders\n{\n  public int Pick(int a)\n  {\n    if (a > 1) return 1;\n    return 2;\n  }\n}\n');
  return { d, w };
}

test('extract reads coverage reports named in settings and fills method.coverage', async () => {
  const { d, w } = repo();
  w('TestResults/g/coverage.cobertura.xml', '<coverage><packages><package><classes><class name="Orders" filename="Api/Orders.cs"><lines><line number="5" hits="0"/><line number="6" hits="4"/></lines></class></classes></package></packages></coverage>');
  const r = await extract(d, { coverage: ['**/coverage.cobertura.xml'] });
  const m = r.facts.code.types.find(t => t.name === 'Orders').methods[0];
  assert.equal(m.coverage, 0.5);
  assert.deepEqual([r.facts.code.coverage.reports, r.facts.code.coverage.covered], [['TestResults/g/coverage.cobertura.xml'], 1]);
});

test('no setting means no coverage field at all, and a bad report is named in unresolved', async () => {
  const { d, w } = repo();
  const none = await extract(d, {});
  assert.ok(!('coverage' in none.facts.code.types[0].methods[0]) && !none.facts.code.coverage);
  w('lcov.info', 'garbage');
  const bad = await extract(d, { coverage: ['lcov.info'] });
  assert.ok(bad.facts.unresolved.some(u => u.where === 'designc.json' && /lcov\.info/.test(u.what)));
  assert.ok(!('coverage' in bad.facts.code.types[0].methods[0]));
});
