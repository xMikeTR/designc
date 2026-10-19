/* designc desktop: deployment, agent topology and canvas-view shells. Classic script, shares the renderer's global scope with app.js (loaded after it; used only
   after boot, so nothing here runs at load). */
const deployKey = () => `designc.deployPick:${A.root ? (A.root.root || A.root.name) : ''}`;
function deployMemory(id) {
  try { if (id === undefined) return localStorage.getItem(deployKey()); if (id) localStorage.setItem(deployKey(), id); else localStorage.removeItem(deployKey()); } catch (e) { /* no storage: the pick lasts for this session */ }
  return null;
}
// The picker's current choice: this session's pick, the remembered one, the designc.json default, else the first.
// `list` is empty when the model declares no environment; `error` says a configured default names nothing.
function deploymentChoice() {
  const list = Core.deploymentChoices(A.model);
  if (!list.length) return { list, current: null };
  const byId = id => list.find(c => c.id === id);
  const dv = A.cfg.deployment ? Core.deploymentView(A.model, A.cfg.deployment) : null;
  const fromCfg = dv && !dv.error ? byId(dv.view ? `view:${dv.view.key || dv.view.scope}` : `env:${dv.env.name}`) : null;
  const current = byId(A.deployPick) || byId(deployMemory()) || fromCfg || list[0];
  return { list, current, error: !A.deployPick && dv && dv.error ? dv.error : null };
}
const deployPicker = d => d.list.some(c => c.view) || d.list.filter(c => !c.view).length > 1;
function deploymentSidebar() {
  const d = deploymentChoice();
  const rows = d.list.map(c => `<div class="row ${d.current && d.current.id === c.id ? 'active' : ''}" data-dppick="${esc(c.id)}"><span class="tw"></span><span class="lbl">${esc(c.label)}</span></div>`).join('');
  return section('deploy', 'Views', rows || '<div class="hint">This model declares no deploymentEnvironment.</div>') +
    '<div class="hint">Read-only. Pick a declared view or a whole environment; the default is "deployment" in designc.json. Edit the model in the Design view.</div>';
}
function deployInstHtml(n) {
  const missing = !n.ref;
  return `<div class="dp-inst ${missing ? 'dp-bad' : ''}"><b>${esc(n.name)}</b><span>${missing ? 'unknown element' : esc(n.kind === 'containerInstance' ? 'container instance' : 'system instance')}</span></div>`;
}
function deployNodeHtml(sn) {
  const n = sn.node;
  const meta = [n.technology, n.instances && n.instances !== '1' ? `${n.instances} instances` : ''].filter(Boolean).join(' · ');
  const shared = sn.shared.map(x => `<div class="dp-shared">+ ${x.count} from ${esc(x.system)}</div>`).join('');
  return `<div class="dp-node ${n.kind === 'infrastructureNode' ? 'dp-infra' : ''}"><div class="dp-h" data-dpnode="${esc(sn.path)}" title="Show what fails if this node is unavailable"><b>${esc(n.name)}</b>${meta ? `<span>${esc(meta)}</span>` : ''}</div>${sn.insts.map(deployInstHtml).join('')}${shared}${sn.children.map(deployNodeHtml).join('')}</div>`;
}
function unavailableHtml(path, env, view) {
  const r = Core.blastRadius(A.model, path, { mode: 'unavailable', environment: env });
  if (r.error) return `<div class="note">${esc(r.error)}</div>`;
  const sys = view && view.system ? view.system : null;
  const row = (label, l) => {
    if (!l.length) return '';
    if (!sys) return `<div><b>${label}</b> ${l.map(x => esc(x.name)).join(', ')}</div>`;
    return Core.splitBySystem(A.model, l, sys).map(side => `<div><b>${label}</b> <i>${side.here ? 'this view' : 'also affected (other systems)'}</i>: ${side.groups.map(g => `${g.system ? `${esc(g.system)}: ` : ''}${g.items.map(x => esc(x.name)).join(', ')}`).join('; ')}</div>`).join('');
  };
  return `<div class="dp-impact"><h3>If ${esc(path)} is unavailable</h3>${row('Lost', r.lost) || '<div>No element loses all its instances.</div>'}${row('Still running, reduced', r.survivors)}${row('Down (sync callers)', r.down)}${row('Degraded (async)', r.degraded)}${row('Unknown (undeclared interaction)', r.unknown)}</div>`;
}
function deployLinksHtml(rels) {
  if (!rels.length) return '';
  return `<div class="block"><h3>Links</h3><div class="tw2"><table class="t"><tr><th>From</th><th>To</th><th>What</th><th>Technology</th></tr>${rels.map(r => `<tr><td>${esc(r.src)}</td><td>${esc(r.dst)}</td><td>${esc(r.description || '')}</td><td>${esc(r.technology || '')}</td></tr>`).join('')}</table></div></div>`;
}
// Agent topology: read-only. The agents, what they call and who calls them, with tool effect and approval on each edge.
const TOPO_EFFECT = { irreversible: 'var(--err)', write: 'var(--warn)', read: 'var(--ink3)' };
function topologySidebar() {
  const t = Core.agentTopology(A.model);
  const rows = t.nodes.filter(n => n.agent).map(n => `<div class="item" data-topo="${esc(n.id)}"><div class="l1"><span class="id">${esc(n.name)}</span>${n.autonomy ? `<span class="tag">${esc(n.autonomy)}</span>` : ''}</div><div class="l2">${n.pattern ? esc(n.pattern) : 'pattern not declared'}</div></div>`).join('');
  return section('agents', `Agents (${t.agents})`, rows || '<div class="hint">No element is tagged Agent or declares d.agent.autonomy.</div>') +
    '<div class="hint">Read-only. Red edges are irreversible calls with no human approval. Edit the model in the Design view.</div>';
}
function renderTopology() {
  const el = $('#special'), t = Core.agentTopology(A.model);
  if (!t.agents) { el.innerHTML = '<div class="note">No element in this model is an agent. Give one the Agent tag or d.agent.autonomy in the Design view to see who it calls and who approves.</div>'; return; }
  const sub = { elements: new Map(t.nodes.map(n => [n.id, { ...A.model.elements.get(n.id), parent: null }])), rels: t.edges.map(e => A.model.rels.find(r => r.id === e.id)) };
  const by = new Map(t.edges.map(e => [e.id, e])), nodeBy = new Map(t.nodes.map(n => [n.id, n]));
  const L = layout(sub), zoom = 1;
  const edgeLabel = e => [e.description, e.effect].filter(Boolean).join(' · ');
  const svg = drawModel(sub, L, {
    attr: 'tp', zoom,
    edgeStyle: r => { const e = by.get(r.id); return { color: e.unguarded ? 'var(--err)' : TOPO_EFFECT[e.effect] || 'var(--ink3)', width: e.unguarded ? 2.4 : 1.4, dash: e.approval === 'human' ? '' : e.approval === 'policy' ? '6 4' : '', marker: e.unguarded ? 'error' : 'n', labelColor: e.unguarded ? 'var(--err)' : null, label: edgeLabel(e) }; },
    nodeStyle: n => { const x = nodeBy.get(n.id); return { stroke: 'var(--ink)', sw: x.agent ? 2.2 : 1.2, badge: x.agent ? (x.pattern || 'no pattern') : null, badgeColor: x.agent && !x.pattern ? 'var(--warn)' : 'var(--accent)' }; },
  });
  const table = `<table class="tp-table"><tr><th>From</th><th>To</th><th>Call</th><th>Effect</th><th>Approval</th></tr>${t.edges.map(e => `<tr class="${e.unguarded ? 'bad' : ''}"><td>${esc(nodeBy.get(e.src).name)}</td><td>${esc(nodeBy.get(e.dst).name)}</td><td>${esc(e.description)}</td><td>${esc(e.effect || '–')}</td><td>${esc(e.approval || '–')}${e.unguarded ? ' · unguarded' : ''}</td></tr>`).join('')}</table>`;
  el.innerHTML = `<div class="dp"><h2>Agent topology</h2><div class="note">${plural(t.agents, 'agent')}, ${plural(t.edges.length, 'call')}${t.unguarded ? `, ${t.unguarded} irreversible without human approval` : ''}. Solid line: human approval. Dashed: policy approval. Red: irreversible with no human approval.</div><div style="overflow:auto">${svg}</div>${table}</div>`;
  el.querySelectorAll('.node').forEach(g => g.addEventListener('click', () => { const e = A.model.elements.get(g.dataset.tp); if (e) openFile(A.cfg.model, e.line); }));
}
function renderDeployment() {
  const d = deploymentChoice(); const el = $('#special');
  if (!d.current) { el.innerHTML = '<div class="note">This model declares no deploymentEnvironment. Add one in the Design view to see where containers run.</div>'; return; }
  const c = d.current, sc = Core.deploymentScope(A.model, c.env, c.view);
  const picker = deployPicker(d) ? `<label class="dp-pick">View <select id="dpPick">${d.list.map(x => `<option value="${esc(x.id)}" ${x.id === c.id ? 'selected' : ''}>${esc(x.label)}</option>`).join('')}</select></label>` : '';
  const hidden = sc.scoped && sc.hidden ? `<div class="note">${sc.hidden} node${sc.hidden === 1 ? '' : 's'} outside ${esc(sc.system)} not shown. Pick "All of ${esc(c.env.name)}" to see them.</div>` : '';
  el.innerHTML = `<div class="dp"><h2>${esc(c.label)}</h2>${d.error ? `<div class="note">${esc(d.error)}</div>` : ''}${picker}${sc.nodes.map(deployNodeHtml).join('') || '<div class="note">This environment has no deployment nodes.</div>'}${hidden}${deployLinksHtml(sc.rels)}<div id="dpImpact"></div></div>`;
  el.querySelectorAll('[data-dpnode]').forEach(h => h.addEventListener('click', ev => { ev.stopPropagation(); $('#dpImpact').innerHTML = unavailableHtml(h.dataset.dpnode, c.env.name, c.view); }));
  const sel = $('#dpPick'); if (sel) sel.addEventListener('change', () => pickDeployment(sel.value));
}
function pickDeployment(id) { A.deployPick = id; deployMemory(id); renderSidebar(); renderSpecial(); }
function renderCanvasView() {
  const el = $('#special');
  if (A.canvasApi && el.querySelector('.dcv-stage')) { A.canvasApi.refresh(); return; }
  A.canvasApi = DesigncCanvas.canvas.mount(el, canvasHostFor());
}
