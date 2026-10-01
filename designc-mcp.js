// designc MCP server (stdio). ACP agents launch this from session/new's mcpServers.
// It holds no state: every tools/list and tools/call is forwarded to the running designc app over
// 127.0.0.1 with a per-run token, where the role policy and the approval cards apply.
// Runs under Electron's bundled Node (ELECTRON_RUN_AS_NODE=1), so Node need not be installed.
const http = require('http');

const URL_ = new URL(process.env.DESIGNC_MCP_URL || 'http://127.0.0.1:0');
const TOKEN = process.env.DESIGNC_MCP_TOKEN || '';
const SESSION = process.env.DESIGNC_MCP_SESSION || '';

function call(route, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ ...body, session: SESSION });
    const req = http.request({ host: URL_.hostname, port: URL_.port, path: route, method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, 'content-length': Buffer.byteLength(data) } }, res => {
      let out = ''; res.on('data', c => (out += c)); res.on('end', () => { try { resolve(JSON.parse(out)); } catch (e) { reject(e); } });
    });
    req.on('error', reject); req.end(data);
  });
}
const send = msg => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');

async function handle(msg) {
  const { id, method, params = {} } = msg;
  if (id == null) return; // notifications (initialized, cancelled)
  try {
    if (method === 'initialize') return send({ id, result: { protocolVersion: params.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'designc', version: '0.1.0' },
      instructions: 'Tools for the designc system design IDE: the design model, lint findings, the ready gate, decisions, the as-built code map, codebase search and Langfuse telemetry. Changes are proposals the user approves in designc.' } });
    if (method === 'ping') return send({ id, result: {} });
    if (method === 'tools/list') { const r = await call('/tools/list', {}); return send({ id, result: { tools: r.tools || [] } }); }
    if (method === 'tools/call') {
      const r = await call('/tools/call', { name: params.name, arguments: params.arguments || {} });
      return send({ id, result: { content: [{ type: 'text', text: String(r.text ?? '') }], isError: !!r.isError } });
    }
    send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
  } catch (e) { send({ id, error: { code: -32603, message: `designc is not reachable: ${e.message}` } }); }
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => {
  buf += d; let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    if (line) { try { handle(JSON.parse(line)); } catch { /* ignore malformed */ } }
  }
});
