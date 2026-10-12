const { test } = require('node:test');
const assert = require('node:assert/strict');


test('driftModels names an extracted SPA whose design match is not tagged UI', () => {
  const Core = require('../renderer/core.js');
  const mk = (tags, tech) => Core.parse(`workspace "W" {\n  model {\n    s = softwareSystem "S" {\n      web = container "Web" "" "${tech}" ${tags}\n    }\n  }\n}\n`);
  assert.deepEqual(Core.driftModels(mk('', 'React'), mk('', 'React SPA (Vite)')).uiUntagged, ['Web']);
  assert.deepEqual(Core.driftModels(mk('"UI"', 'React'), mk('', 'React SPA (Vite)')).uiUntagged, []);
  assert.deepEqual(Core.driftModels(mk('', 'C#'), mk('', 'ASP.NET')).uiUntagged, []);
});
