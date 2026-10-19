// Agent contracts (designc.json contracts): classic script after terminalview.js, used only after boot.
// Writes the design's agents to contracts/agents.json, runs the person's own command on it and shows contracts/out/result.json.
// Human only: no agent tool reaches it. The compiled files are not a gate input.
function contractsAgents() {
  try { return Core.handoverAgents(A.modelText); } catch { return { agents: [] }; }
}
function contractsSection() {
  const s = Contracts.settings(A.cfg.contracts), doc = contractsAgents();
  if (!s && !doc.agents.length) return '';
  const st = A.contractsState;
  const rows = st && st.result && st.result.agents ? st.result.agents.map(a => `<div class="item"><div class="l1"><span class="dot ${a.status === 'compiled' ? 'pass' : a.status === 'missing' ? '' : 'fail'}"></span><span class="id">${esc(a.name || a.id)}</span><span class="tag">${esc(a.status.replace('_', ' '))}</span></div>${a.reasons.length || a.files.length ? `<div class="l2">${esc([...a.reasons, ...a.files].join(' · '))}</div>` : ''}</div>`).join('') : '';
  const msg = st && st.error ? `<div class="hint">${esc(st.error)}</div>` : st && st.result && st.result.problems.length ? `<div class="hint">${st.result.problems.map(esc).join('<br>')}</div>` : '';
  const head = !s ? `<div class="hint">${plural(doc.agents.length, 'agent')} in the design. Set <b>contracts</b> in designc.json to a command that compiles them into agent contracts; designc passes it ${Contracts.PATHS.agents} and reads ${Contracts.PATHS.result}.</div>`
    : s.error ? `<div class="hint">${esc(s.error)}</div>`
    : !doc.agents.length ? '<div class="hint">The design has no agents yet.</div>'
    : `<button class="btn block" data-a="compilecontracts" title="Runs your contracts command on ${esc(Contracts.PATHS.agents)}. Needs a trusted folder.">${esc(s.label)}</button>`;
  return section('contracts', `Agent contracts (${doc.agents.length})`, head + msg + rows);
}
async function compileContracts() {
  const s = Contracts.settings(A.cfg.contracts);
  if (!s || s.error) return toast(s ? s.error : 'Set contracts in designc.json first.', 'error');
  if (A.running) return toast('Checks are already running.');
  if (dirtyBuffers()) return toast('Save your open files first: the contracts are compiled from what is on disk.', 'warning');
  let doc;
  try { doc = Core.handoverAgents(A.modelText); } catch (e) { return toast(e.message, 'error'); }
  if (!doc.agents.length) return toast('The design has no agents to compile.', 'warning');
  const cmd = Contracts.command(s.command, { agents: dispatchAbs(Contracts.PATHS.agents), out: dispatchAbs(Contracts.PATHS.out), registry: A.root.root }, A.platform);
  if (cmd.error) return toast(cmd.error, 'error');
  A.running = true; showPanel('output'); renderStatus();
  appendOutput(`\n── ${new Date().toLocaleTimeString()}  compiling ${plural(doc.agents.length, 'agent contract')}\n▶ $ ${cmd}\n`);
  try {
    await host.write(Contracts.PATHS.agents, JSON.stringify(doc, null, 2) + '\n');
    try { await host.remove(Contracts.PATHS.result); } catch {}
    const r = await host.runCheck(`contracts-${Date.now()}`, cmd);
    if (r.cancelled) { appendOutput('Cancelled: folder not trusted.\n'); return; }
    let raw = null;
    try { raw = await host.read(Contracts.PATHS.result); } catch {}
    if (raw == null) A.contractsState = { error: `The command ${r.code === 0 ? 'finished' : `exited with ${r.code}`} but wrote no ${Contracts.PATHS.result}. Check the command writes it into {out}.` };
    else { const res = Contracts.readResult(raw, doc); A.contractsState = res.error ? { error: res.error } : { result: res }; }
    A.contractsText = raw; recompile();
    appendOutput(A.contractsState.error ? `✗ ${A.contractsState.error}\n` : `✓ read ${Contracts.PATHS.result}\n`);
  } finally { A.running = false; renderStatus(); renderSidebar(); }
}
// Every compiled file path a result names, for the freeze to read (Contracts.forFreeze judges them).
function contractFiles(resultText) {
  try { return [...new Set(JSON.parse(resultText).agents.flatMap(a => [a.policy, ...(a.files || [])]).filter(f => typeof f === 'string'))]; } catch { return []; }
}
// Gate input: only when designc.json contracts has require: true (a team's choice, so a new project is never blocked).
function contractGaps() {
  const c = A.cfg.contracts, s = Contracts.settings(c);
  if (!s || s.error || c.require !== true || !A.model || A.model.errors.length) return [];
  let doc; try { doc = Core.handoverAgents(A.modelText); } catch { return []; }
  return Contracts.gaps({ resultText: A.contractsText == null ? null : A.contractsText, agentsDoc: doc, agentsText: JSON.stringify(doc, null, 2) + '\n', hash: Core._shared.hash16 });
}
