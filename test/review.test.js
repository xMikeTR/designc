const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../renderer/core.js');
const V = require('../renderer/canvas/vocabulary.js');
const A = require('../renderer/canvas/agentic-rules.js');
const R = require('../renderer/canvas/review.js');
const T = require('../renderer/canvas/templates.js');
const D = require('../renderer/canvas/dsl-edit.js');
Core.registerProperties(V.coreSpecs()); Core.registerRules(A.makeRules(Core));

test('capacity arithmetic', () => {
  const c = R.capacity({ dailyActiveUsers: 86400, requestsPerUserPerDay: 1, peakFactor: 4, payloadKB: 1024, writeRatio: 1, retentionDays: 10, replicas: 2,
    agentRunsPerDay: 100, tokensPerRun: 10000, outputShare: 0, pricePerMTokIn: 2, pricePerMTokOut: 10, expectedAttempts: 1 });
  assert.equal(c.avgRps, 1); assert.equal(c.peakRps, 4);
  assert.ok(Math.abs(c.writeGBPerDay - 84.375) < 1e-9); assert.ok(Math.abs(c.storedGB - 1687.5) < 1e-9);
  assert.equal(c.agentTokensPerDay, 1e6); assert.equal(c.agentCostPerDay, 2);
});

test('review covers findings, quality, STRIDE and OWASP', () => {
  const src = D.insertSnippet(D.EMPTY, T.TEMPLATES.find(t => t.id === 'governed-agent'), 'g').text
    .replace('"Operator g" {', '"Operator g"').replace(/g_user = person "Operator g"/, 'g_user = person "Operator g" {\n      properties {\n        "d.zone" "corporate"\n      }\n    }');
  const m = Core.parse(src); assert.deepEqual(m.errors, []);
  const sys = [...m.elements.values()].find(e => e.name === 'Agent platform g'); sys.props['d.zone'] = 'platform';
  const r = R.generate(Core, m, Core.check(m), { date: '2026-09-26' });
  assert.equal(r.summary.agents, 1);
  assert.ok(r.threats.length >= 1 && r.threats[0].stride.length === 6);
  const a = r.agentic[0]; assert.equal(a.owasp.length, 10);
  assert.match(a.owasp.find(o => o.id === 'ASI08').status, /^ok: capped/);
  assert.match(a.owasp.find(o => o.id === 'ASI02').status, /^ok/);
  assert.ok(r.markdown.includes('# Design review') && r.markdown.includes('ASI01 Agent Goal Hijack') && r.markdown.includes('STRIDE'));
});

test('review flags risks on a risky agent', () => {
  const m = Core.parse('workspace { model {\n s = softwareSystem "S" {\n  a = container "A" "" "" "Agent" {\n   properties {\n    "d.agent.codeExec" "yes"\n    "d.agent.identity" "shared"\n   }\n  }\n }\n} }');
  const r = R.generate(Core, m, Core.check(m));
  const st = id => r.agentic[0].owasp.find(o => o.id === id).status;
  assert.match(st('ASI05'), /^risk/); assert.match(st('ASI03'), /^risk/); assert.match(st('ASI08'), /^risk/); assert.match(st('ASI10'), /^risk/);
  assert.ok(r.findings.some(f => f.code === 'AG006'));
});
