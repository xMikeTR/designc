// designc desktop: main process. Owns the file system, the ledger, check runs and model calls.
const { app, BrowserWindow, ipcMain, dialog, Menu, shell, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const { spawn } = require('child_process');
const { extract } = require('./extract');
const { fetchTelemetry } = require('./telemetry');
const { AcpHub } = require('./acp');
const http = require('http');
const crypto = require('crypto');
const ledgerStore = require('./ledger-store');

let win = null, root = null, watcher = null, watchTimer = null, changed = new Set();
const running = new Map();
const STATE_FILE = () => path.join(app.getPath('userData'), 'state.json');
let state = { recent: [], trusted: [] };

function loadState() { try { state = { recent: [], trusted: [], ...JSON.parse(fs.readFileSync(STATE_FILE(), 'utf8')) }; } catch { /* first run */ } }
function saveState() { try { fs.mkdirSync(path.dirname(STATE_FILE()), { recursive: true }); fs.writeFileSync(STATE_FILE(), JSON.stringify(state, null, 2)); } catch { /* non-fatal */ } }

// Every renderer path is relative to the open folder and may not escape it.
function inside(rel) {
  if (!root) throw new Error('No folder is open');
  const abs = path.resolve(root, rel || '.');
  if (abs !== root && !abs.startsWith(root + path.sep)) throw new Error('Path is outside the open folder');
  return abs;
}
const toRel = abs => path.relative(root, abs).split(path.sep).join('/');
const SKIP = new Set(['.git', 'node_modules', '.venv', 'bin', 'obj', '.idea', '.vs']);

async function tree(abs, depth = 0) {
  if (depth > 8) return [];
  let entries;
  try { entries = await fsp.readdir(abs, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const e of entries) {
    if (SKIP.has(e.name) || e.name === '.DS_Store') continue;
    const p = path.join(abs, e.name);
    if (e.isDirectory()) out.push({ name: e.name, path: toRel(p), dir: true, children: await tree(p, depth + 1) });
    else out.push({ name: e.name, path: toRel(p), dir: false });
  }
  return out.sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name));
}

function setRoot(dir) {
  if (typeof hub !== 'undefined') hub.disconnectAll();
  root = path.resolve(dir);
  state.recent = [root, ...state.recent.filter(r => r !== root)].slice(0, 8);
  saveState(); buildMenu();
  if (watcher) { watcher.close(); watcher = null; }
  try {
    watcher = fs.watch(root, { recursive: true }, (_ev, file) => {
      if (!file) return;
      const rel = String(file).split(path.sep).join('/');
      if (rel.split('/').some(s => SKIP.has(s))) return;
      changed.add(rel);
      clearTimeout(watchTimer);
      watchTimer = setTimeout(() => { const list = [...changed]; changed.clear(); win && win.webContents.send('fs:changed', list); }, 200);
    });
  } catch { /* watching is best-effort */ }
  if (win) win.setTitle(`${path.basename(root)} - designc`);
  return { root, name: path.basename(root) };
}

async function openFolderDialog() {
  const r = await dialog.showOpenDialog(win, { title: 'Open registry folder', properties: ['openDirectory', 'createDirectory'] });
  if (r.canceled || !r.filePaths[0]) return null;
  const info = setRoot(r.filePaths[0]);
  win.webContents.send('folder:opened', info);
  return info;
}
async function openSample() {
  const docs = app.getPath('documents');
  const dest = path.join(docs, 'designc-sample-registry'), code = path.join(docs, 'designc-sample-codebase');
  if (!fs.existsSync(dest)) await fsp.cp(path.join(__dirname, 'sample-registry'), dest, { recursive: true });
  if (!fs.existsSync(code)) await fsp.cp(path.join(__dirname, 'sample-codebase'), code, { recursive: true });
  const info = setRoot(dest);
  win.webContents.send('folder:opened', info);
  return info;
}

const send = (cmd) => () => win && win.webContents.send('cmd', cmd);
function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    { label: 'File', submenu: [
      { label: 'Open Folder…', accelerator: 'CmdOrCtrl+O', click: () => openFolderDialog() },
      { label: 'Open Recent', submenu: state.recent.length ? state.recent.map(r => ({ label: r, click: () => { const i = setRoot(r); win.webContents.send('folder:opened', i); } })) : [{ label: 'No recent folders', enabled: false }] },
      { label: 'Open Sample Registry', click: () => openSample() },
      { type: 'separator' },
      { label: 'Save', accelerator: 'CmdOrCtrl+S', click: send('save') },
      { label: 'Close Editor', accelerator: 'CmdOrCtrl+W', click: send('close-tab') },
      { type: 'separator' },
      isMac ? { role: 'close' } : { role: 'quit' },
    ] },
    { role: 'editMenu' },
    { label: 'View', submenu: [
      { label: 'Explorer', accelerator: 'CmdOrCtrl+Shift+E', click: send('view:explorer') },
      { label: 'Design (System 1)', accelerator: 'CmdOrCtrl+Shift+D', click: send('view:design') },
      { label: 'Code Map (as built)', accelerator: 'CmdOrCtrl+Shift+K', click: send('view:codemap') },
      { label: 'Build (System 2)', click: send('view:build') },
      { label: 'Improve (System 4)', click: send('view:improve') },
      { type: 'separator' },
      { label: 'Toggle C4 Sheet', accelerator: 'CmdOrCtrl+Alt+V', click: send('toggle-sheet') },
      { label: 'Agent Panel', accelerator: 'CmdOrCtrl+Alt+I', click: send('toggle-agent') },
      { label: 'Problems', accelerator: 'CmdOrCtrl+Shift+M', click: send('panel:problems') },
      { label: 'Output', accelerator: 'CmdOrCtrl+Shift+U', click: send('panel:output') },
      { type: 'separator' },
      { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
      { type: 'separator' },
      { role: 'toggleDevTools' }, { role: 'togglefullscreen' },
    ] },
    { label: 'Run', submenu: [
      { label: 'Run All Decision Checks', accelerator: 'CmdOrCtrl+Shift+B', click: send('run-checks') },
      { label: 'Ask Grill-me', accelerator: 'CmdOrCtrl+Shift+G', click: send('grill') },
      { label: 'Extract Code Map', accelerator: 'CmdOrCtrl+Shift+R', click: send('extract') },
      { label: 'Freeze Handover', click: send('freeze') },
    ] },
    { label: 'Help', submenu: [
      { label: 'Design Properties Reference', click: send('help:props') },
      { label: 'Open Settings File (designc.json)', click: send('open-settings') },
    ] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440, height: 920, minWidth: 960, minHeight: 600, title: 'designc',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1b1f24' : '#f3f4f6',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', e => e.preventDefault());
  // Headless screenshots for CI/docs: DESIGNC_SNAPSHOT=prefix, DESIGNC_STEPS=JSON array of renderer scripts.
  if (process.env.DESIGNC_SNAPSHOT) {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    win.webContents.on('console-message', (_e, level, msg) => { if (level >= 2) console.log('[renderer]', msg); });
    win.webContents.once('did-finish-load', async () => {
      const steps = JSON.parse(process.env.DESIGNC_STEPS || '[]'); await wait(4000);
      let i = 0;
      for (const s of [''].concat(steps)) {
        try { if (s) console.log('[step]', JSON.stringify(await win.webContents.executeJavaScript(s))); } catch (e) { console.log('[step error]', e.message); }
        await wait(1500);
        fs.writeFileSync(`${process.env.DESIGNC_SNAPSHOT}-${i++}.png`, (await win.webContents.capturePage()).toPNG());
      }
      app.quit();
    });
  }
}

// ---------- IPC ----------
const handle = (ch, fn) => ipcMain.handle(ch, async (_e, ...a) => fn(...a));
handle('app:boot', async () => ({ recent: state.recent, root: root ? { root, name: path.basename(root) } : null, user: os.userInfo().username, platform: process.platform }));
handle('folder:open', () => openFolderDialog());
handle('folder:openPath', p => { const i = setRoot(p); return i; });
handle('folder:sample', () => openSample());
handle('fs:tree', async () => (root ? tree(root) : []));
handle('fs:read', async rel => fsp.readFile(inside(rel), 'utf8'));
handle('fs:exists', async rel => { try { await fsp.access(inside(rel)); return true; } catch { return false; } });
handle('fs:write', async (rel, text) => { const abs = inside(rel); await fsp.mkdir(path.dirname(abs), { recursive: true }); await fsp.writeFile(abs, text, 'utf8'); return true; });
handle('fs:list', async (relDir, ext) => {
  const abs = inside(relDir); let names = [];
  try { names = await fsp.readdir(abs); } catch { return []; }
  const out = [];
  for (const n of names.filter(n => !ext || ext.some(x => n.endsWith(x))).sort()) {
    try { out.push({ path: toRel(path.join(abs, n)), text: await fsp.readFile(path.join(abs, n), 'utf8') }); } catch { /* skip */ }
  }
  return out;
});
// The single validated append path for both ledger envelopes (renderer/ledger.js). See
// plan/ledger-schema-s1-manifest.json R-5 — every other write goes through here or is legacy above.
handle('ledger:event', async event => ledgerStore.appendEvent(root, event));

// Codebase (read-only): a separate folder, usually another repo, named in designc.json as "codebase".
function codebaseDir(p) { if (!root || !p) throw new Error('No codebase is configured'); return path.resolve(root, p); }
handle('codebase:choose', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Choose the codebase to map', properties: ['openDirectory'] });
  if (r.canceled || !r.filePaths[0]) return null;
  const rel = path.relative(root, r.filePaths[0]).split(path.sep).join('/');
  return rel && !path.isAbsolute(rel) ? rel : r.filePaths[0];
});
handle('codebase:extract', async p => {
  const dir = codebaseDir(p);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return { error: `Codebase folder not found: ${dir}` };
  try { return await extract(dir, readSettings().extract || {}); } catch (e) { return { error: `Extraction failed: ${e.message}` }; }
});
handle('codebase:read', async (p, rel) => {
  const base = codebaseDir(p), abs = path.resolve(base, rel);
  if (abs !== base && !abs.startsWith(base + path.sep)) throw new Error('Path is outside the codebase');
  return fsp.readFile(abs, 'utf8');
});

// Langfuse telemetry for Run (S2) and Improve (S4). Keys come from the environment, never the repo.
handle('telemetry:fetch', async () => {
  if (!root) return { error: 'no_folder' };
  let cfg = null;
  try { cfg = JSON.parse(await fsp.readFile(inside('designc.json'), 'utf8')).langfuse || null; } catch { /* no settings */ }
  if (!cfg) return { error: 'not_configured' };
  return fetchTelemetry(root, cfg);
});

// ---------- agent panel: streaming chat with tools through the OpenAI-compatible gateway ----------
const streams = new Map();
handle('agent:chat', async (id, payload) => {
  let cfg = {}, agents = {};
  try { const j = JSON.parse(await fsp.readFile(inside('designc.json'), 'utf8')); cfg = j.llm || {}; agents = j.agents || {}; } catch { /* no settings */ }
  const baseUrl = cfg.baseUrl || process.env.DESIGNC_LLM_BASE_URL;
  const key = process.env[cfg.apiKeyEnv || 'DESIGNC_LLM_API_KEY'];
  const model = (agents[payload.role] && agents[payload.role].model) || cfg.model || process.env.DESIGNC_LLM_MODEL;
  if (!baseUrl || !model) return { error: 'not_configured' };
  if (!key) return { error: 'no_key', env: cfg.apiKeyEnv || 'DESIGNC_LLM_API_KEY' };
  const body = { model, messages: payload.messages, tools: payload.tools && payload.tools.length ? payload.tools : undefined, stream: true, temperature: 0.2 };
  // LiteLLM forwards these to Langfuse, so IDE agent turns show up under the same convention.
  if (cfg.litellmMetadata) body.metadata = { tags: ['designc', 'ide-agent'], trace_name: `agent ${payload.role}`, trace_metadata: { system: payload.system, role: payload.role, session: payload.session } };
  const ac = new AbortController(); streams.set(id, ac);
  try {
    const res = await fetch(baseUrl.replace(/\/$/, '') + '/chat/completions', {
      method: 'POST', signal: ac.signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}`, accept: 'text/event-stream' },
      body: JSON.stringify(body),
    });
    if (!res.ok) { const b = await res.json().catch(() => ({})); return { error: 'http', status: res.status, message: (b.error && b.error.message) || res.statusText, model }; }
    let content = '', usage = null; const calls = [];
    if (!(res.headers.get('content-type') || '').includes('event-stream')) {
      const b = await res.json(); const m = (b.choices && b.choices[0] && b.choices[0].message) || {};
      if (m.content) win.webContents.send('agent:delta', id, m.content);
      return { message: { role: 'assistant', content: m.content || null, tool_calls: m.tool_calls }, usage: b.usage || null, model };
    }
    const reader = res.body.getReader(), dec = new TextDecoder(); let buf = '';
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim(); if (data === '[DONE]') continue;
        let j; try { j = JSON.parse(data); } catch { continue; }
        if (j.usage) usage = j.usage;
        const delta = j.choices && j.choices[0] && j.choices[0].delta; if (!delta) continue;
        if (delta.content) { content += delta.content; win.webContents.send('agent:delta', id, delta.content); }
        for (const tc of delta.tool_calls || []) {
          const i = tc.index ?? 0;
          const t = calls[i] || (calls[i] = { id: '', type: 'function', function: { name: '', arguments: '' } });
          if (tc.id) t.id = tc.id;
          if (tc.function && tc.function.name) t.function.name += tc.function.name;
          if (tc.function && tc.function.arguments) t.function.arguments += tc.function.arguments;
        }
      }
    }
    const tool_calls = calls.filter(Boolean).map((t, i) => ({ ...t, id: t.id || `call_${id}_${i}` }));
    return { message: { role: 'assistant', content: content || null, tool_calls: tool_calls.length ? tool_calls : undefined }, usage, model };
  } catch (e) {
    if (e.name === 'AbortError') return { cancelled: true };
    return { error: 'network', message: e.message };
  } finally { streams.delete(id); }
});
handle('agent:cancel', id => { const s = streams.get(id); if (s) s.abort(); return true; });

// Read-only search of the codebase for the agent panel.
const SEARCH_EXT = /\.(cs|fs|fsx|fsi|json|csproj|fsproj|props|targets|ya?ml|md|ts|tsx|js|py|sql|bicep|tf|config|xml|http)$/i;
handle('codebase:search', async (p, query, max = 60) => {
  const base = codebaseDir(p); const out = []; const q = String(query || '').toLowerCase(); if (!q) return out;
  const walk = async dir => {
    if (out.length >= max) return;
    let entries = []; try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (out.length >= max) return;
      if (SKIP.has(e.name) || e.name.startsWith('.')) continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) await walk(abs);
      else if (SEARCH_EXT.test(e.name)) {
        let t; try { t = await fsp.readFile(abs, 'utf8'); } catch { continue; }
        t.split(/\r?\n/).forEach((line, i) => { if (out.length < max && line.toLowerCase().includes(q)) out.push({ file: path.relative(base, abs).split(path.sep).join('/'), line: i + 1, text: line.trim().slice(0, 200) }); });
      }
    }
  };
  await walk(base); return out;
});

// ---------- request/reply into the UI (approvals, policy, tool execution live in the renderer) ----------
const uiWaits = new Map(); let uiSeq = 0;
function askUi(channel, ...args) {
  return new Promise(resolve => { const id = ++uiSeq; uiWaits.set(id, resolve); if (!win) return resolve(null); win.webContents.send('ui:call', id, channel, ...args); });
}
ipcMain.handle('ui:reply', (_e, id, value) => { const r = uiWaits.get(id); if (r) { uiWaits.delete(id); r(value); } return true; });

// ---------- MCP bridge: designc's tools for ACP agents, on 127.0.0.1 with a per-run token ----------
const MCP_TOKEN = crypto.randomBytes(24).toString('hex');
let mcpUrl = null;
const bridge = http.createServer((req, res) => {
  if (req.headers.authorization !== `Bearer ${MCP_TOKEN}` || req.method !== 'POST') { res.writeHead(403); return res.end(); }
  let body = ''; req.on('data', c => { body += c; if (body.length > 2e6) req.destroy(); });
  req.on('end', async () => {
    let j = {}; try { j = JSON.parse(body); } catch { /* empty */ }
    const out = req.url === '/tools/list' ? await askUi('mcp:list', j.session) : req.url === '/tools/call' ? await askUi('mcp:call', j) : null;
    res.writeHead(out ? 200 : 404, { 'content-type': 'application/json' }); res.end(JSON.stringify(out || {}));
  });
});
bridge.listen(0, '127.0.0.1', () => { mcpUrl = `http://127.0.0.1:${bridge.address().port}`; });
function mcpScript() { return path.join(__dirname, 'designc-mcp.js').replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`); }

// ---------- ACP agents ----------
const ACP_PRESETS = {
  claude: { label: 'Claude Code', command: 'npx', args: ['-y', '@agentclientprotocol/claude-agent-acp'] },
  codex: { label: 'Codex', command: 'npx', args: ['-y', '@zed-industries/codex-acp'] },
  gemini: { label: 'Gemini CLI', command: 'npx', args: ['-y', '@google/gemini-cli', '--acp'] },
  copilot: { label: 'GitHub Copilot', command: 'copilot', args: ['--acp', '--stdio'] },
};
function readSettings() { try { return JSON.parse(fs.readFileSync(inside('designc.json'), 'utf8')); } catch { return {}; } }
function acpSpecs() {
  const cfg = readSettings().acpAgents || {};
  const out = {}; for (const [k, v] of Object.entries({ ...ACP_PRESETS, ...cfg })) if (v && v.command && v.enabled !== false) out[k] = v;
  return out;
}
const hub = new AcpHub({
  getRoot: () => root,
  getCodebase: () => { const c = readSettings().codebase; return root && c ? path.resolve(root, c) : null; },
  mcpServer: meta => ({ name: 'designc', command: process.execPath, args: [mcpScript()], env: [
    { name: 'ELECTRON_RUN_AS_NODE', value: '1' }, { name: 'DESIGNC_MCP_URL', value: mcpUrl || '' },
    { name: 'DESIGNC_MCP_TOKEN', value: MCP_TOKEN }, { name: 'DESIGNC_MCP_SESSION', value: (meta && meta.session) || '' }] }),
  ui: (channel, ...args) => (channel === 'acp:write' || channel === 'acp:permission') ? askUi(channel, ...args) : (win && win.webContents.send(channel, ...args)),
});
handle('acp:agents', () => Object.fromEntries(Object.entries(acpSpecs()).map(([k, v]) => [k, { label: v.label || k, command: [v.command, ...(v.args || [])].join(' ') }])));
handle('acp:connect', async (key, meta) => {
  const spec = acpSpecs()[key]; if (!spec) return { error: `No ACP agent "${key}" is configured.` };
  try { return { info: await hub.connect(key, spec, meta) }; } catch (e) { hub.disconnect(key); return { error: e.message }; }
});
handle('acp:prompt', async (key, text) => { try { return await hub.prompt(key, text); } catch (e) { return { error: e.message }; } });
handle('acp:cancel', key => { hub.cancel(key); return true; });
handle('acp:disconnect', key => { hub.disconnect(key); return true; });
app.on('before-quit', () => hub.disconnectAll());

// ---------- AG-UI agents: remote agent services (e.g. MAF hosts via MapAGUIServer), HTTP POST + SSE ----------
// Header values may reference environment variables as ${env:NAME}, so tokens never live in designc.json.
const withEnv = v => String(v).replace(/\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, n) => process.env[n] || '');
function aguiSpecs() { const cfg = readSettings().aguiAgents || {}; const out = {}; for (const [k, v] of Object.entries(cfg)) if (v && v.url && v.enabled !== false) out[k] = v; return out; }
handle('agui:agents', () => Object.fromEntries(Object.entries(aguiSpecs()).map(([k, v]) => [k, { label: v.label || k, url: v.url, clientTools: v.clientTools !== false, sendState: v.sendState !== false }])));
const aguiRuns = new Map();
handle('agui:run', async (id, key, body) => {
  const spec = aguiSpecs()[key]; if (!spec) return { error: `No AG-UI agent "${key}" is configured.` };
  const headers = { 'content-type': 'application/json', accept: 'text/event-stream' };
  for (const [h, v] of Object.entries(spec.headers || {})) headers[h] = withEnv(v);
  const ac = new AbortController(); aguiRuns.set(id, ac);
  try {
    const res = await fetch(spec.url, { method: 'POST', headers, body: JSON.stringify(body), signal: ac.signal });
    if (!res.ok) { const t = await res.text().catch(() => ''); return { error: `HTTP ${res.status}${t ? ': ' + t.slice(0, 300) : ''}` }; }
    const reader = res.body.getReader(), dec = new TextDecoder(); let buf = '', data = [], sent = 0;
    const flush = () => { if (!data.length) return; const raw = data.join('\n'); data = []; let ev; try { ev = JSON.parse(raw); } catch { return; } sent++; win.webContents.send('agui:event', id, ev, sent); };
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream: true }); let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, ''); buf = buf.slice(nl + 1);
        if (line === '') flush(); else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      }
    }
    flush();
    return { ok: true, events: sent };   // the renderer waits until it has seen this many: IPC events and replies aren't ordered
  } catch (e) { return e.name === 'AbortError' ? { cancelled: true } : { error: e.message }; }
  finally { aguiRuns.delete(id); }
});
handle('agui:cancel', id => { const r = aguiRuns.get(id); if (r) r.abort(); return true; });

// Decision checks are shell commands from the repository, so the folder must be trusted first.
handle('check:run', async (runId, cmd) => {
  if (!state.trusted.includes(root)) {
    const r = await dialog.showMessageBox(win, {
      type: 'warning', buttons: ['Trust folder and run', 'Cancel'], defaultId: 1, cancelId: 1,
      title: 'Run commands from this folder?',
      message: `Decision checks are shell commands written in this repository.`,
      detail: `Only trust ${root} if you trust whoever can edit its decisions.\n\nFirst command:\n${cmd}`,
    });
    if (r.response !== 0) return { code: null, cancelled: true };
    state.trusted.push(root); saveState();
  }
  const t0 = Date.now();
  return new Promise(resolve => {
    const child = spawn(cmd, { cwd: root, shell: true, env: process.env });
    running.set(runId, child);
    const out = chunk => win && win.webContents.send('check:output', runId, chunk.toString());
    child.stdout.on('data', out); child.stderr.on('data', out);
    child.on('error', err => { out(`\n${err.message}\n`); });
    child.on('close', code => { running.delete(runId); resolve({ code, ms: Date.now() - t0 }); });
  });
});
handle('check:cancel', runId => { const c = running.get(runId); if (c) c.kill(); return true; });

// Model calls go through an OpenAI-compatible endpoint (the LiteLLM gateway), configured in designc.json.
handle('llm:chat', async (messages) => {
  let cfg = {};
  try { cfg = JSON.parse(await fsp.readFile(inside('designc.json'), 'utf8')).llm || {}; } catch { /* no settings */ }
  const baseUrl = cfg.baseUrl || process.env.DESIGNC_LLM_BASE_URL;
  const key = process.env[cfg.apiKeyEnv || 'DESIGNC_LLM_API_KEY'];
  const model = cfg.model || process.env.DESIGNC_LLM_MODEL;
  if (!baseUrl || !model) return { error: 'not_configured' };
  if (!key) return { error: 'no_key', env: cfg.apiKeyEnv || 'DESIGNC_LLM_API_KEY' };
  try {
    const res = await fetch(baseUrl.replace(/\/$/, '') + '/chat/completions', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, messages, temperature: 0.2 }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return { error: 'http', status: res.status, message: (body.error && body.error.message) || res.statusText };
    return { text: body.choices && body.choices[0] && body.choices[0].message ? body.choices[0].message.content : '' };
  } catch (e) { return { error: 'network', message: e.message }; }
});

app.whenReady().then(() => {
  loadState(); buildMenu(); createWindow();
  const arg = process.argv.slice(app.isPackaged ? 1 : 2).find(a => !a.startsWith('-'));
  if (arg && fs.existsSync(arg) && fs.statSync(arg).isDirectory()) setRoot(arg);
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
