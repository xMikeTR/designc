const { test } = require('node:test');
const assert = require('node:assert/strict');
const Ledger = require('../renderer/ledger.js');

test('legacy agent events upcast to snake_case with via inferred', () => {
  const acp = Ledger.upcast({ kind: 'agent_turn', model: 'claude', stopReason: 'end_turn', tokens: 5000, ms: 10 });
  assert.equal(acp.via, 'acp');
  assert.equal(acp.stop_reason, 'end_turn');
  assert.equal(acp.context_used, 5000);
  assert.equal(acp.tokens, undefined);
  assert.equal('stopReason' in acp, false);

  const agui = Ledger.upcast({ kind: 'agent_turn', model: 'agui:maf', runId: 'r1', ms: 3 });
  assert.equal(agui.via, 'agui');
  assert.equal(agui.run_id, 'r1');
  assert.equal('runId' in agui, false);

  const builtin = Ledger.upcast({ kind: 'agent_turn', model: 'gpt', tokens: 42 });
  assert.equal(builtin.via, 'builtin');
  assert.equal(builtin.tokens, 42);

  const tool = Ledger.upcast({ kind: 'agent_tool', tool: 'edit_model', toolKind: 'edit', verdict: 'agent', outcome: 'ok', via: 'acp' });
  assert.equal(tool.tool_kind, 'edit');
  assert.equal('toolKind' in tool, false);

  for (const e of [acp, agui, builtin, tool]) {
    assert.equal(typeof e.agent, 'undefined');
    assert.equal(typeof e.role, 'undefined');
  }
  // agent/role/by presence is asserted separately, on events that carry them.
  const withAgentRole = Ledger.upcast({ kind: 'agent_turn', model: 'gpt', tokens: 1, agent: 'builtin', role: 'architect', by: 'app' });
  assert.equal(withAgentRole.agent, 'builtin');
  assert.equal(withAgentRole.role, 'architect');
  assert.equal(withAgentRole.by, 'app');
});

test('v1 agent and extraction events enforce the schema', () => {
  const base = { schema_version: 1, by: 'app', agent: 'builtin', role: 'architect' };
  assert.ok(Ledger.validate({ ...base, kind: 'agent_turn', via: 'builtin', stopReason: 'end_turn' })
    .some(e => /stopReason: unknown field/.test(e)));
  assert.ok(Ledger.validate({ ...base, kind: 'agent_turn', model: 'gpt' })
    .some(e => /agent_turn.via: required/.test(e)));
  assert.deepEqual(Ledger.validate({ ...base, kind: 'agent_turn', via: 'builtin', tokens: 5 }), []);

  assert.ok(Ledger.validate({ ...base, kind: 'unapproved_change', path: 'model/workspace.dsl', via: 'builtin' })
    .some(e => /unapproved_change.via: must be one of/.test(e)));
  assert.deepEqual(Ledger.validate({ ...base, kind: 'unapproved_change', path: 'model/workspace.dsl', via: 'acp' }), []);

  const extractionBase = { schema_version: 1, by: 'app', kind: 'extraction', repo: 'r', revision: 'r-1',
    projects: 1, deployables: 1, tests: 0, elements: 5, edges: 3, unresolved: 0 };
  assert.ok(Ledger.validate({ ...extractionBase, modules: 5 }).some(e => /modules: unknown field/.test(e)));
  assert.deepEqual(Ledger.validate({ ...extractionBase, payload: { stats: { modules: 5 } } }), []);
});
