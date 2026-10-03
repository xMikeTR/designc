const { test } = require('node:test');
const assert = require('node:assert/strict');
const Ledger = require('../renderer/ledger.js');

const ev = (kind, o) => ({ kind, _ts: 1, ...o });

test('agentActivity: one row per agent and role with turns, tokens, tool verdicts, permissions and approvals', () => {
  const rows = Ledger.agentActivity([
    ev('agent_turn', { agent: 'built-in', role: 'architect', via: 'builtin', tokens: 100 }),
    ev('agent_turn', { agent: 'built-in', role: 'architect', via: 'builtin', tokens_in: 30, tokens_out: 20 }),
    ev('agent_turn', { agent: 'claude', role: 'architect', via: 'acp', context_used: 500 }),
    ev('agent_tool', { agent: 'built-in', role: 'architect', tool: 'read_model', verdict: 'allow', outcome: 'ok', via: 'builtin' }),
    ev('agent_tool', { agent: 'built-in', role: 'architect', tool: 'mint_decision', verdict: 'ask', outcome: 'declined', via: 'builtin' }),
    ev('agent_tool', { agent: 'built-in', role: 'architect', tool: 'x', verdict: 'deny', outcome: 'denied', via: 'builtin' }),
    ev('agent_permission', { agent: 'claude', role: 'architect', tool: 'write', outcome: 'selected', via: 'acp' }),
    ev('agent_approval', { agent: 'maf', role: 'grill', tool: 'mint_decision', interrupt: 'i1', outcome: 'accept', via: 'agui' }),
    ev('escape', { id: 'E-1' }),
  ]);
  const by = (a, r) => rows.find(x => x.agent === a && x.role === r);
  assert.equal(rows.length, 3);
  assert.deepEqual(by('built-in', 'architect'), { agent: 'built-in', role: 'architect', via: 'builtin', turns: 2, tokens: 150, tools: 3, allowed: 1, asked: 1, denied: 1, declined: 1, permissions: 0, approvals: 0, unapproved: 0, last: 1 });
  assert.equal(by('claude', 'architect').permissions, 1);
  assert.equal(by('maf', 'grill').approvals, 1);
  assert.equal(by('maf', 'grill').via, 'agui');
});

test('agentActivity: unapproved changes count against the agent and are listed by path', () => {
  const evs = [
    ev('unapproved_change', { agent: 'claude', role: 'architect', path: 'model/workspace.dsl', via: 'acp' }),
    ev('unapproved_change', { agent: 'claude', role: 'architect', path: 'ledger/checks.jsonl', via: 'acp' }),
  ];
  assert.equal(Ledger.agentActivity(evs)[0].unapproved, 2);
  assert.deepEqual(Ledger.unapprovedChanges(evs).map(e => e.path), ['model/workspace.dsl', 'ledger/checks.jsonl']);
  assert.deepEqual(Ledger.agentActivity([]), []);
});
