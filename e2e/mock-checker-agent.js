// Scripted ACP agent for the checker-draft journeys: on any prompt it calls write_check on the decision in
// MOCK_DECISION with the script in MOCK_SCRIPT_BODY and the summary in MOCK_SUMMARY, then says it is done. It talks to
// designc's MCP server as a real agent does (same protocol as dev/mock-acp-agent.js). It never reaches a model.
const { spawn } = require('child_process');
let nextId = 1, sessionId = null, mcp = null;
const out = m => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
const update = u => out({ method: 'session/update', params: { sessionId, update: u } });
function startMcp(spec) {
  const env = { ...process.env }; for (const e of spec.env || []) env[e.name] = e.value;
  const p = spawn(spec.command, spec.args || [], { env, stdio: ['pipe', 'pipe', 'inherit'] });
  let buf = '', id = 1; const waits = new Map();
  p.stdout.setEncoding('utf8');
  p.stdout.on('data', d => { buf += d; let nl; while ((nl = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, nl); buf = buf.slice(nl + 1); if (!l.trim()) continue; const m = JSON.parse(l), w = waits.get(m.id); if (w) { waits.delete(m.id); m.error ? w.rej(new Error(m.error.message)) : w.res(m.result); } } });
  return { call: (method, params) => new Promise((res, rej) => { const i = id++; waits.set(i, { res, rej }); p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: i, method, params }) + '\n'); }), kill: () => p.kill() };
}
async function turn() {
  update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Drafting the check. ' } });
  update({ sessionUpdate: 'tool_call', toolCallId: 'c1', title: 'designc: write_check', kind: 'other', status: 'pending' });
  const r = await mcp.call('tools/call', { name: 'write_check', arguments: { decision: process.env.MOCK_DECISION, script: process.env.MOCK_SCRIPT_BODY, summary: process.env.MOCK_SUMMARY } });
  update({ sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: r.isError ? 'failed' : 'completed', content: [{ type: 'content', content: { type: 'text', text: r.content[0].text } }] });
  update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Done.' } });
  return 'end_turn';
}
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', async d => {
  buf += d; let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1); if (!line) continue;
    const m = JSON.parse(line);
    if (m.id != null && !m.method) continue;
    if (m.method === 'initialize') out({ id: m.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: false, promptCapabilities: { image: false } }, agentInfo: { name: 'mock-checker', title: 'Mock checker agent', version: '0.1.0' }, authMethods: [] } });
    else if (m.method === 'session/new') {
      sessionId = 'sess_' + Date.now();
      mcp = startMcp((m.params.mcpServers || []).find(s => s.name === 'designc')); await mcp.call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'mock-checker' } });
      out({ id: m.id, result: { sessionId } });
    } else if (m.method === 'session/prompt') out({ id: m.id, result: { stopReason: await turn() } });
    else if (m.id != null) out({ id: m.id, error: { code: -32601, message: 'not supported' } });
  }
});
process.stdin.on('end', () => { if (mcp) mcp.kill(); process.exit(0); });
process.on('SIGTERM', () => { if (mcp) mcp.kill(); process.exit(0); });
