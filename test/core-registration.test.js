// A1 slice 1: loading renderer/core.js alone gives the full rule set (vocabulary + agentic rules), the same one the IDE has.
const test = require('node:test');
const assert = require('node:assert/strict');

const Core = require('../renderer/core.js');

const REPRO = `workspace {
  model {
    s = softwareSystem "S" {
      t = container "Triage agent" { tags "Agent"  properties { "d.agent.pattern" "orchestrator-workers" } }
    }
  }
}
`;

test('core alone registers AG001-AG011 and the canvas properties', () => {
  const codes = Core.RULES.map(r => r.code);
  for (let n = 1; n <= 11; n++) assert.ok(codes.includes('AG' + String(n).padStart(3, '0')), `AG${n} missing`);
  assert.ok(Core.specsFor('element')['d.agent.pattern'], 'd.agent.pattern is a known property');
  assert.equal(Core.__dcvRegistered, true);
});

test('the rule-code set is the same whether core is loaded alone or by the renderer', () => {
  const alone = Core.RULES.map(r => r.code).sort();
  const V = require('../renderer/canvas/vocabulary.js'), AR = require('../renderer/canvas/agentic-rules.js');
  Core.registerProperties(V.coreSpecs()); Core.registerRules(AR.makeRules(Core)); // what a host that did not see the flag would do
  assert.deepEqual(Core.RULES.map(r => r.code).sort(), alone);
  assert.equal(new Set(alone).size, alone.length, 'no code registered twice');
});

test('the R1 repro model is blocked by AG001, AG003, AG005 and AG011 with no DC000', () => {
  const m = Core.parse(REPRO);
  const diags = Core.check(m, {});
  const codes = [...new Set(diags.filter(d => !d.suppressed).map(d => d.code))].sort();
  assert.deepEqual(codes.filter(c => c.startsWith('AG')), ['AG001', 'AG003', 'AG005', 'AG011']);
  assert.ok(!codes.includes('DC000'), codes.join(','));
});
