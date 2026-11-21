// The CLI (the Node core, and `python -m designc check` as a shim over it) knows the same d.* properties as the app:
// the canvas vocabulary is the one source.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const Core = require('../renderer/core.js');
const V = require('../renderer/canvas/vocabulary.js');

const PY = path.join(__dirname, '..', 'python');
const skip = false;

function registry(dsl) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-specs-'));
  fs.mkdirSync(path.join(root, 'model'));
  fs.writeFileSync(path.join(root, 'model', 'workspace.dsl'), dsl);
  return root;
}

const DSL = `workspace {
  model {
    s = softwareSystem "Shop" {
      a = container "Agent" "" "MAF" "Agent" {
        properties {
          "d.agent.autonomy" "autonomous"
          "d.agent.maxSteps" "many"
          "d.agent.autonmy" "suggest"
        }
      }
    }
  }
}
`;

test('designc check (shim) reports the same DC000 findings as the app for d.agent properties', { skip }, () => {
  const js = Core.check(Core.parse(DSL), { chainHops: 4 }).filter(d => d.code === 'DC000').map(d => d.msg + '|' + (d.hint || '')).sort();
  const root = registry(DSL);
  const r = spawnSync('python3', ['-m', 'designc', 'check', root, '--json'], { cwd: PY, encoding: 'utf8' });
  const py = JSON.parse(r.stdout).findings.filter(f => f.code === 'DC000').map(f => f.msg + '|' + (f.hint || '')).sort();
  assert.equal(js.length, 2);
  assert.deepEqual(py.map(s => s.split('|')[0]), js.map(s => s.split('|')[0]));
});

test('a valid d.agent property is accepted by designc check', { skip }, () => {
  const root = registry(DSL.replace('"d.agent.maxSteps" "many"', '"d.agent.maxSteps" "5"').replace(/\s*"d.agent.autonmy" "suggest"/, ''));
  const r = spawnSync('python3', ['-m', 'designc', 'check', root, '--json'], { cwd: PY, encoding: 'utf8' });
  assert.deepEqual(JSON.parse(r.stdout).findings.filter(f => f.code === 'DC000'), []);
});
