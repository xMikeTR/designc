// designc MCP server (stdio). ACP agents launch this from session/new's mcpServers.
// It holds no state: every tools/list and tools/call is forwarded to the running designc app over
// 127.0.0.1 with a per-run token, where the role policy and the approval cards apply.
// Runs under Electron's bundled Node (ELECTRON_RUN_AS_NODE=1), so Node need not be installed.
const http = require('http');

// Two modes. App mode (DESIGNC_MCP_URL set and the app answers): forwards to the running app. Headless mode (no URL, or the
// app refuses the connection): serves read_model, get_findings, get_gate and get_code_map from the registry on disk through
// headless/index.js, reading fresh on every call. The registry is --registry <dir>, else DESIGNC_REGISTRY, else the cwd.
const argv = process.argv.slice(2);
const ri = argv.indexOf('--registry');
const REGISTRY = require('path').resolve(ri >= 0 && argv[ri + 1] ? argv[ri + 1] : process.env.DESIGNC_REGISTRY || process.cwd());
const URL_ = new URL(process.env.DESIGNC_MCP_URL || 'http://127.0.0.1:0');
let headless = !process.env.DESIGNC_MCP_URL;
const Headless = () => require('./headless/index.js');
const unreachable = e => ['ECONNREFUSED', 'EHOSTUNREACH', 'ENOTFOUND'].includes(e && (e.code || (e.errors && e.errors[0] && e.errors[0].code)));
const INSTR_APP = 'Tools for the designc system design IDE: the design model, lint findings, the ready gate, decisions, the as-built code map, codebase search and Langfuse telemetry. Changes are proposals the user approves in designc.';
const INSTR_HEADLESS = `designc app not running: headless mode on ${REGISTRY}. Four read tools are available (read_model, get_findings, get_gate, get_code_map), read fresh from disk. Everything else needs the designc app open on this registry.`;
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

// In app mode, find out now whether the app is there, so initialize can say which mode is active. True when headless.
async function probe() {
  if (headless) return true;
  try { await call('/tools/list', {}); } catch (e) { if (unreachable(e)) headless = true; }
  return headless;
}

async function handle(msg) {
  const { id, method, params = {} } = msg;
  if (id == null) return; // notifications (initialized, cancelled)
  try {
    if (method === 'initialize') return send({ id, result: { protocolVersion: params.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'designc', version: '0.1.0' },
      instructions: await probe() ? INSTR_HEADLESS : INSTR_APP } });
    if (method === 'ping') return send({ id, result: {} });
    if (method === 'tools/list') {
      if (!headless) { try { const r = await call('/tools/list', {}); return send({ id, result: { tools: r.tools || [] } }); } catch (e) { if (!unreachable(e)) throw e; headless = true; } }
      return send({ id, result: { tools: Headless().mcpTools() } });
    }
    if (method === 'tools/call') {
      if (!headless) {
        try {
          const r = await call('/tools/call', { name: params.name, arguments: params.arguments || {} });
          return send({ id, result: { content: [{ type: 'text', text: String(r.text ?? '') }], isError: !!r.isError } });
        } catch (e) { if (!unreachable(e)) throw e; headless = true; }
      }
      const r = Headless().callTool(REGISTRY, params.name, params.arguments || {});
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
// The agent that launched this server is gone (or closed our stdin): nothing more can arrive, so leave.
process.stdin.on('end', () => process.exit(0));
