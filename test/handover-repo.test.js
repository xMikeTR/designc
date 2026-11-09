// elements.json carries the repo of each element that has code (d.repo, inherited from the container), only when declared.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../renderer/core.js');

const dsl = `workspace { model { s = softwareSystem "S" {
  api = container "Api" { properties { "d.repo" "Api" "d.risk" "low" }
    ctl = component "Ctl" { properties { "d.code" "src/ctl/**" } }
  }
  ui = container "Ui" { properties { "d.repo" "Ui" "d.code" "src/ui/**" "d.risk" "low" } }
  lone = container "Lone" { properties { "d.code" "src/lone/**" "d.risk" "low" } }
} } }`;

for (const scoped of [null, ['Ui']]) {
  test(`elements.json repo field (${scoped ? 'item' : 'full'} handover)`, () => {
    const byId = Object.fromEntries(Core.handoverElements(dsl, [], scoped).elements.map(e => [e.id, e]));
    assert.equal(byId['S/Api/Ctl'].repo, 'Api');  // inherited
    assert.equal(byId['S/Ui'].repo, 'Ui');
    assert.equal('repo' in byId['S/Lone'], false); // none declared: absent
    assert.equal('repo' in byId['S/Api'], true);   // declared on the container itself
  });
}
