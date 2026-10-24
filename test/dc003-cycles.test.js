'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const Core = require('../renderer/core.js');

// Four elements call each other in a ring, and a caller sits above it: the ring is one finding, not one per way round.
const DSL = `workspace {
  model {
    s = softwareSystem "S" {
      top = container "Top"
      a = container "A"
      b = container "B"
      c = container "C"
      d = container "D"
      top -> a "calls"
      a -> b "calls"
      b -> c "calls"
      c -> d "calls"
      d -> a "calls"
    }
  }
}
`;
const dc003 = diags => diags.filter(d => d.code === 'DC003');

test('a sync cycle is reported once, and paths run over the condensed graph', () => {
  const m = Core.parse(DSL);
  const found = dc003(Core.check(m, { chainHops: 3 }));
  assert.equal(found.filter(d => /call each other synchronously in a cycle/.test(d.msg)).length, 1);
  assert.match(found.find(d => /in a cycle/.test(d.msg)).msg, /4 elements.*A, B, C, D/);
  assert.ok(found.length <= 2, `expected the cycle plus at most one path, got ${found.length}`);
});

test('the Python CLI reports the same DC003 findings', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc003-'));
  fs.mkdirSync(path.join(dir, 'model'));
  fs.writeFileSync(path.join(dir, 'model', 'workspace.dsl'), DSL);
  fs.writeFileSync(path.join(dir, 'designc.json'), JSON.stringify({ model: 'model/workspace.dsl', chainHops: 3 }));
  const r = spawnSync('python3', ['-m', 'designc', 'check', dir, '--json'], { cwd: path.join(__dirname, '..', 'python'), encoding: 'utf8' });
  const py = JSON.parse(r.stdout).findings.filter(f => f.code === 'DC003').map(f => f.msg || f.message).sort();
  const js = dc003(Core.check(Core.parse(DSL), { chainHops: 3 })).map(d => d.msg).sort();
  assert.deepEqual(py, js);
});
