const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Ajv = require('ajv/dist/2020');
const Core = require('../renderer/core.js');

const dsl = (rels) => `workspace "W" { model {
  user = person "User"
  s = softwareSystem "S" {
    web = container "Web" { properties { "d.code" "web/**" "d.repo" "Ui" } }
    api = container "Api" {
      ctl = component "Ctl" { properties { "d.code" "api/ctl/**" } }
      repo = component "Repo" { properties { "d.code" "api/repo/**" } }
    }
    db = container "Db" { properties { "d.code" "db/**" } }
    ${rels.join('\n    ')}
  }
} views { container s "C" { include * autoLayout } } }`;
const BASE = ['user -> web "Uses"', 'web -> api "Calls"', 'ctl -> repo "Uses"', 'repo -> db "Reads"', 'api -> ctl "Owns"'];
const deps = (rels = BASE, scope = null) => { const t = dsl(rels); return Core.handoverDependencies(t, Core.handoverElements(t, [], scope)); };
const allows = (d, id) => d.elements.find(e => e.element === id).allows;

test('allows are lifted to code areas, directed, and skip people and structural rels', () => {
  const d = deps();
  assert.equal(d.schema, 'designc.handover.dependencies/1');
  assert.deepEqual(d.elements.map(e => e.element), ['S/Api/Ctl', 'S/Api/Repo', 'S/Db', 'S/Web']);
  assert.deepEqual(allows(d, 'S/Web'), ['S/Api/Ctl', 'S/Api/Repo']);
  assert.deepEqual(allows(d, 'S/Api/Ctl'), ['S/Api/Repo']);
  assert.deepEqual(allows(d, 'S/Api/Repo'), ['S/Db']);
  assert.deepEqual(allows(d, 'S/Db'), []);
  assert.deepEqual(d.elements.map(e => e.repo), [undefined, undefined, undefined, 'Ui']);
  assert.deepEqual(d.elements.find(e => e.element === 'S/Web').code, ['web/**']);
});

test('a component of a coded container counts for the container; two components of one container add no self allow', () => {
  const t = `workspace "W" { model { s = softwareSystem "S" {
    a = container "A" { properties { "d.code" "a/**" } 
      a1 = component "A1"
      a2 = component "A2" }
    b = container "B" { properties { "d.code" "b/**" } }
    a1 -> a2 "x"
    a1 -> b "y" } } views { container s "C" { include * autoLayout } } }`;
  const d = Core.handoverDependencies(t, Core.handoverElements(t));
  assert.deepEqual(allows(d, 'S/A'), ['S/B']);
  assert.deepEqual(allows(d, 'S/B'), []);
});

test('adding a rel changes one allows; removing one empties it', () => {
  const base = deps();
  const added = deps([...BASE, 'db -> web "Back"']);
  assert.deepEqual(allows(added, 'S/Db'), ['S/Web']);
  for (const id of ['S/Web', 'S/Api/Ctl', 'S/Api/Repo']) assert.deepEqual(allows(added, id), allows(base, id));
  const removed = deps(BASE.filter(r => !r.startsWith('repo -> db')));
  assert.deepEqual(allows(removed, 'S/Api/Repo'), []);
  assert.deepEqual(allows(removed, 'S/Web'), allows(base, 'S/Web'));
});

test('rel order does not matter; an item freeze gives the same doc; no code gives null', () => {
  assert.equal(JSON.stringify(deps([...BASE].reverse())), JSON.stringify(deps()));
  assert.deepEqual(deps(BASE, ['Web']), deps());
  const t = 'workspace "W" { model { s = softwareSystem "S" { a = container "A" } } views { container s "C" { include * autoLayout } } }';
  assert.equal(Core.handoverDependencies(t, Core.handoverElements(t)), null);
});

const docs = f => JSON.parse(fs.readFileSync(path.join(__dirname, '../docs', f), 'utf8'));
const validate = new Ajv({ strict: false, allErrors: true }).compile(docs('handover-dependencies.schema.json'));
test('contract: the example is what the function writes and validates; bad shapes fail', () => {
  const schema = docs('handover-dependencies.schema.json'), example = docs('handover-dependencies.example.json');
  assert.equal(schema.$id, 'designc.handover.dependencies/1');
  assert.equal(schema.properties.schema.const, 'designc.handover.dependencies/1');
  assert.deepEqual(example, JSON.parse(JSON.stringify(deps())));
  assert.equal(validate(example), true);
  const bad1 = structuredClone(example); bad1.elements[0].extra = 1;
  const bad2 = structuredClone(example); bad2.elements[0].allows = [1];
  assert.equal(validate(bad1), false);
  assert.equal(validate(bad2), false);
});
