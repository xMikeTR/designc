// d.code and d.risk: where an element's code lives and how risky it is to change. The handover's
// elements.json carries them for a coding agent to scope task writes and judge merges.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const Core = require('../renderer/core.js');
const { CORE } = require('./helpers/parity.js');


const dsl = (code, risk) => `workspace {
  model {
    s = softwareSystem "Fares" {
      db = container "Bookings DB" "" "SQL" "Database" {
        properties {
          "d.code" "${code}"
          "d.risk" "${risk}"
        }
      }
    }
  }
}
`;

const dc000 = ds => ds.filter(d => d.code === 'DC000');
function pyFindings(text) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-factory-'));
  fs.mkdirSync(path.join(root, 'model'));
  fs.writeFileSync(path.join(root, 'model', 'workspace.dsl'), text);
  const r = spawnSync(process.execPath, [CORE, 'check', root, '--json'], { encoding: 'utf8' });
  return JSON.parse(r.stdout).findings;
}

test('d.code (list) and d.risk (low|medium|high) are known element properties', () => {
  const m = Core.parse(dsl('src/Fares.Data/**, db/migrations/**', 'high'));
  assert.deepEqual(dc000(Core.check(m, { chainHops: 4 })), []);
  const db = [...m.elements.values()].find(e => e.name === 'Bookings DB');
  assert.deepEqual(Core.get(db, 'd.code'), ['src/Fares.Data/**', 'db/migrations/**']);
  assert.equal(Core.get(db, 'd.risk'), 'high');
});

test('d.risk outside low|medium|high is a DC000 error', () => {
  const ds = dc000(Core.check(Core.parse(dsl('src/**', 'extreme')), { chainHops: 4 }));
  assert.equal(ds.length, 1);
  assert.match(ds[0].msg + (ds[0].hint || ''), /low \| medium \| high/);
});

test('designc check agrees with the app on d.code and d.risk', () => {
  assert.deepEqual(dc000(pyFindings(dsl('src/Fares.Data/**', 'medium'))), []);
  assert.equal(dc000(pyFindings(dsl('src/**', 'extreme'))).length, 1);
});
