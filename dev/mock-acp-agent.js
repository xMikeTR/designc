// Scripted ACP agent (protocol v1) for demos and tests. It connects to the MCP servers designc passes in
// session/new, exactly as a real agent does. Add to designc.json:
//   "acpAgents": { "mock": { "label": "Mock agent", "command": "node", "args": ["<path>/dev/mock-acp-agent.js"] } }
const { spawn } = require('child_process');
const path = require('path');
let nextId = 1; const pending = new Map(); let cwd = null, sessionId = null, mcp = null, cancelled = false;
const out = m => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
const req = (method, params) => new Promise((res, rej) => { const id = nextId++; pending.set(id, { res, rej }); out({ id, method, params }); });
const update = u => out({ method: 'session/update', params: { sessionId, update: u } });
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function say(text) { for (const w of text.split(/(?<= )/)) { update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: w } }); await sleep(10); } }

function startMcp(spec) {
  const env = { ...process.env }; for (const e of spec.env || []) env[e.name] = e.value;
  const p = spawn(spec.command, spec.args || [], { env, stdio: ['pipe', 'pipe', 'inherit'] });
  let buf = '', id = 1; const waits = new Map();
  p.stdout.setEncoding('utf8');
  p.stdout.on('data', d => { buf += d; let nl; while ((nl = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, nl); buf = buf.slice(nl + 1); if (!l.trim()) continue; const m = JSON.parse(l); const w = waits.get(m.id); if (w) { waits.delete(m.id); m.error ? w.rej(new Error(m.error.message)) : w.res(m.result); } } });
  const call = (method, params) => new Promise((res, rej) => { const i = id++; waits.set(i, { res, rej }); p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: i, method, params }) + '\n'); });
  return { call, kill: () => p.kill() };
}
async function tool(toolCallId, title, kind, fn) {
  update({ sessionUpdate: 'tool_call', toolCallId, title, kind, status: 'pending' });
  update({ sessionUpdate: 'tool_call_update', toolCallId, status: 'in_progress' });
  try { const text = await fn(); update({ sessionUpdate: 'tool_call_update', toolCallId, status: 'completed', content: [{ type: 'content', content: { type: 'text', text } }] }); return text; }
  catch (e) { update({ sessionUpdate: 'tool_call_update', toolCallId, status: 'failed', content: [{ type: 'content', content: { type: 'text', text: e.message } }] }); return null; }
}

// MOCK_SCRIPT=study: the Researcher in a study notebook. Lists the topics, then adds a source and a finding
// citing it to the first open one, each through designc's approval card.
async function studyTurn() {
  const call = async (name, args) => { const r = await mcp.call('tools/call', { name, arguments: args }); if (r.isError) throw new Error(r.content[0].text); return r.content[0].text; };
  await say('Reading the study topics through designc. ');
  let topic = null;
  await tool('s1', 'designc: read_study', 'read', async () => { const list = JSON.parse(await call('read_study', {})); topic = (list.find(t => t.status === 'open') || {}).id; return `${list.length} topics`; });
  if (!topic) { await say('There is no open topic to research.'); return 'end_turn'; }
  await tool('s2', 'designc: add_source', 'other', () => call('add_source', { topic, url: 'https://github.com/example/compiler/blob/0123abc/src/passes.rs', note: 'Example pass manager' }));
  await tool('s3', 'designc: add_finding', 'other', () => call('add_finding', { topic, pattern: 'Passes declare what they preserve', why: 'The manager skips recomputing analyses that are still valid', good_or_bad: 'good', sources: [1] }));
  await say('I added one source and one finding. Read the source yourself; the opinion is yours.');
  return 'end_turn';
}

async function turn() {
  cancelled = false;
  if (process.env.MOCK_SCRIPT === 'study') return studyTurn();
  const plan = s => update({ sessionUpdate: 'plan', entries: [
    { content: 'Read the lint findings through designc', priority: 'high', status: s[0] },
    { content: 'Run the tests', priority: 'medium', status: s[1] },
    { content: 'Fix the lost update in the model', priority: 'high', status: s[2] },
    { content: 'Record the decision', priority: 'medium', status: s[3] }] });
  plan(['in_progress', 'pending', 'pending', 'pending']);
  await say('Checking the design through the designc tools first. ');
  const tools = await mcp.call('tools/list', {});
  const findings = await tool('t1', `designc: get_findings (${tools.tools.length} designc tools available)`, 'read', async () => {
    const r = await mcp.call('tools/call', { name: 'get_findings', arguments: {} });
    const list = JSON.parse(r.content[0].text); return `${list.filter(f => f.severity === 'error' && !f.suppressed).length} errors, ${list.filter(f => f.severity === 'warning' && !f.suppressed).length} warnings; first: ${list[0].code} ${list[0].where}`;
  });
  plan(['completed', 'in_progress', 'pending', 'pending']);
  update({ sessionUpdate: 'tool_call', toolCallId: 't2', title: 'Run `dotnet test Pricing.sln`', kind: 'execute', status: 'pending', rawInput: { command: 'dotnet test Pricing.sln' } });
  const perm = await req('session/request_permission', { sessionId, toolCall: { toolCallId: 't2', title: 'Run `dotnet test Pricing.sln`', kind: 'execute', rawInput: { command: 'dotnet test Pricing.sln' } },
    options: [{ optionId: 'allow', name: 'Allow once', kind: 'allow_once' }, { optionId: 'always', name: 'Always allow', kind: 'allow_always' }, { optionId: 'reject', name: 'Reject', kind: 'reject_once' }] });
  const allowed = perm.outcome.outcome === 'selected' && perm.outcome.optionId !== 'reject';
  update({ sessionUpdate: 'tool_call_update', toolCallId: 't2', status: allowed ? 'completed' : 'failed', content: [{ type: 'content', content: { type: 'text', text: allowed ? '(mock) 42 passed, 0 failed' : 'Not run: permission rejected' } }] });
  if (cancelled) return 'cancelled';
  plan(['completed', 'completed', 'in_progress', 'pending']);
  const model = path.join(cwd, 'model', 'workspace.dsl');
  await tool('t3', 'Edit model/workspace.dsl', 'edit', async () => {
    const { content } = await req('fs/read_text_file', { sessionId, path: model });
    await req('fs/write_text_file', { sessionId, path: model, content: content.replace('"d.concurrency" "none"', '"d.concurrency" "optimistic"') });
    return 'Referral Worker → Quotes DB now uses optimistic concurrency';
  });
  const cb = path.resolve(cwd, require(path.join(cwd, 'designc.json')).codebase || '..', 'src', 'Referral.Worker', 'ReferralHandler.cs');
  await tool('t4', 'Edit src/Referral.Worker/ReferralHandler.cs', 'edit', async () => {
    await req('fs/write_text_file', { sessionId, path: cb, content: '// add rowversion check\n' }); return 'edited';
  });
  plan(['completed', 'completed', 'completed', 'in_progress']);
  await tool('t5', 'designc: mint_decision', 'other', async () => {
    const r = await mcp.call('tools/call', { name: 'mint_decision', arguments: { statement: 'Referral Worker writes Quote with optimistic concurrency', effect: 'fix', binds: ['Quotes DB'], resolves: ['DC002'], checks: ['p check -tc tcOptimistic'], rationale: 'Two writers, no owner.' } });
    if (r.isError) throw new Error(r.content[0].text); return r.content[0].text;
  });
  if (process.env.MOCK_BYPASS) { require('fs').writeFileSync(path.join(cwd, 'decisions', 'D-9999.yaml'), 'id: D-9999\nstatus: bound\n'); await sleep(900); }
  // Also under MOCK_BYPASS: an ACP write that climbs out of the registry through `..`, a decision written
  // as bound with the status quoted, and a passing check forged straight into the ledger. designc must
  // refuse the first two and flag the third.
  if (process.env.MOCK_BYPASS) {
    await tool('t6', 'Edit model/../../escaped.txt', 'edit', async () => { await req('fs/write_text_file', { sessionId, path: `${cwd}/model/../../escaped.txt`, content: 'outside\n' }); return 'edited'; });
    await tool('t7', 'Edit decisions/D-9998.yaml', 'edit', async () => { await req('fs/write_text_file', { sessionId, path: path.join(cwd, 'decisions', 'D-9998.yaml'), content: 'id: D-9998\nstatus: "bound"\n' }); return 'edited'; });
    require('fs').appendFileSync(path.join(cwd, 'ledger', 'checks.jsonl'), JSON.stringify({ schema_version: 1, event_id: 'forged-1', ts: Date.now(), kind: 'check', by: 'agent', decision: 'D-0001', check: 'p check -tc tcOptimistic', outcome: 'pass', source: 'pipeline' }) + '\n');
    await sleep(900);
  }
  plan(['completed', 'completed', 'completed', 'completed']);
  await say('Done. I changed the model and minted a decision; designc refused my edit to the C# code, which is right: code changes belong to the pipeline. Bind the decision when you are happy with it.');
  return 'end_turn';
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', async d => {
  buf += d; let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1); if (!line) continue;
    const m = JSON.parse(line);
    if (m.id != null && !m.method) { const p = pending.get(m.id); if (p) { pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); } continue; }
    if (m.method === 'initialize') out({ id: m.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: false, promptCapabilities: { image: false } }, agentInfo: { name: 'mock-agent', title: 'Mock agent', version: '0.1.0' }, authMethods: [] } });
    else if (m.method === 'session/new') {
      cwd = m.params.cwd; sessionId = 'sess_' + Date.now();
      const spec = (m.params.mcpServers || []).find(s => s.name === 'designc');
      mcp = startMcp(spec); await mcp.call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'mock-agent' } });
      out({ id: m.id, result: { sessionId } });
    } else if (m.method === 'session/prompt') { const stopReason = await turn(); out({ id: m.id, result: { stopReason } }); }
    else if (m.method === 'session/cancel') cancelled = true;
    else if (m.id != null) out({ id: m.id, error: { code: -32601, message: 'not supported' } });
  }
});
process.stdin.on('end', () => { if (mcp) mcp.kill(); process.exit(0); });
process.on('SIGTERM', () => { if (mcp) mcp.kill(); process.exit(0); });
