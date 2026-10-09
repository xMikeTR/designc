const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const Cov = require('../extract/coverage.js');

const COBERTURA = `<?xml version="1.0"?>
<coverage line-rate="0.5" version="1.9">
  <sources><source>/build/agent/src</source></sources>
  <packages><package name="Shop.Api"><classes>
    <class name="Shop.Api.Orders" filename="Shop.Api/Orders.cs" line-rate="0.5">
      <methods/>
      <lines><line number="10" hits="3"/><line number="11" hits="0" branch="False"/><line number="12" hits="2"/></lines>
    </class>
    <class name="Shop.Api.Orders/Inner" filename="Shop.Api/Orders.cs">
      <lines><line hits="0" number="11"/><line number="30" hits="1"/></lines>
    </class>
    <class name="Other" filename="C:\\build\\src\\Shop.Api\\Repo.cs"><lines><line number="5" hits="1"/></lines></class>
  </classes></package></packages>
</coverage>`;

const LCOV = ['TN:', 'SF:/ci/work/web/src/cart.ts', 'DA:1,1', 'DA:2,0', 'DA:3,4', 'end_of_record', 'SF:web/src/other.ts', 'DA:7,0', 'end_of_record'].join('\n');

test('Cobertura: hits per file and line, merged across classes, Windows paths normalised', () => {
  const m = Cov.parse(COBERTURA);
  assert.deepEqual([...m.keys()].sort(), ['C:/build/src/Shop.Api/Repo.cs', 'Shop.Api/Orders.cs']);
  const o = m.get('Shop.Api/Orders.cs');
  assert.deepEqual([...o].sort((a, b) => a[0] - b[0]), [[10, 3], [11, 0], [12, 2], [30, 1]]);
});

test('lcov: DA lines per source file', () => {
  const m = Cov.parse(LCOV);
  assert.deepEqual([...m.get('/ci/work/web/src/cart.ts')], [[1, 1], [2, 0], [3, 4]]);
  assert.equal(m.size, 2);
});

test('an unknown format gives an empty map, never a throw', () => {
  assert.equal(Cov.parse('hello').size, 0);
  assert.equal(Cov.parse('').size, 0);
});

const code = () => ({ types: [
  { id: 't1', methods: [
    { name: 'Make', file: 'api/src/Shop.Api/Orders.cs', line: 10, endLine: 12, cc: 3, lines: 3 },
    { name: 'Gap', file: 'api/src/Shop.Api/Orders.cs', line: 20, endLine: 25, cc: 1, lines: 6 },
    { name: 'Get', file: 'api/src/Shop.Api/Repo.cs', line: 5, endLine: 5, cc: 1, lines: 1 },
    { name: 'None', file: 'api/src/Other.cs', line: 1, endLine: 2, cc: 1, lines: 2 },
  ] }] });

test('apply: coverage is covered lines over instrumented lines inside the method, matched by path suffix', () => {
  const c = code();
  const r = Cov.apply(c, Cov.parse(COBERTURA));
  const by = Object.fromEntries(c.types[0].methods.map(m => [m.name, m.coverage]));
  assert.equal(by.Make, 2 / 3);        // lines 10 and 12 hit, 11 not
  assert.equal(by.Get, 1);             // a Windows-rooted report path still matches by suffix
  assert.ok(!('coverage' in c.types[0].methods.find(m => m.name === 'Gap')), 'no instrumented line in range means unknown');
  assert.ok(!('coverage' in c.types[0].methods.find(m => m.name === 'None')), 'file not in any report means unknown');
  assert.deepEqual([r.methods, r.covered], [4, 2]);
});

test('apply: the longest matching suffix wins and a bare file name never matches by name alone across folders', () => {
  const m = Cov.parse('SF:a/b/Svc.ts\nDA:1,1\nend_of_record\nSF:Svc.ts\nDA:1,0\nend_of_record');
  const c = { types: [{ id: 't', methods: [{ name: 'f', file: 'x/a/b/Svc.ts', line: 1, endLine: 1, cc: 1, lines: 1 }, { name: 'g', file: 'x/z/Svc.ts', line: 1, endLine: 1, cc: 1, lines: 1 }] }] };
  Cov.apply(c, m);
  assert.equal(c.types[0].methods[0].coverage, 1);
  assert.ok(!('coverage' in c.types[0].methods[1]) || c.types[0].methods[1].coverage === 0);
});

test('find: reads report files named by repo-relative globs, skipping node_modules', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cov-'));
  fs.mkdirSync(path.join(d, 'TestResults/abc'), { recursive: true });
  fs.mkdirSync(path.join(d, 'node_modules/x'), { recursive: true });
  fs.writeFileSync(path.join(d, 'TestResults/abc/coverage.cobertura.xml'), COBERTURA);
  fs.writeFileSync(path.join(d, 'node_modules/x/coverage.cobertura.xml'), COBERTURA);
  fs.writeFileSync(path.join(d, 'lcov.info'), LCOV);
  const r = await Cov.load(d, ['**/coverage.cobertura.xml', 'lcov.info']);
  assert.deepEqual(r.files.sort(), ['TestResults/abc/coverage.cobertura.xml', 'lcov.info']);
  assert.ok(r.map.has('Shop.Api/Orders.cs') && r.map.has('/ci/work/web/src/cart.ts'));
  assert.deepEqual((await Cov.load(d, [])).files, []);
  assert.deepEqual((await Cov.load(d, 'nope')).problems.length, 1);
  const bad = await Cov.load(d, ['**/coverage.{cobertura,opencover}.xml', 'lcov.info']);
  assert.deepEqual(bad.files, ['lcov.info'], 'a rejected pattern finds nothing, the others still run');
  assert.equal(bad.problems.length, 1);
  assert.match(bad.problems[0], /extract\.coverage: character classes and braces are not supported/);
});
