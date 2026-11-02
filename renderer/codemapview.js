/* designc desktop: code map (as built) view. Classic script, shares the renderer's global scope with app.js (loaded after it; used only
   after boot, so nothing here runs at load). */
async function chooseCodebase() {
  const p = await host.chooseCodebase(); if (!p) return false;
  let cfg = {}; const t = await readText('designc.json');
  if (t) { try { cfg = JSON.parse(t); } catch { toast('designc.json is not valid JSON; fix it first.', 'error'); return false; } }
  cfg.model = cfg.model || A.cfg.model; cfg.codebase = p;
  await host.write('designc.json', JSON.stringify(cfg, null, 2) + '\n'); A.cfg.codebase = p; return true;
}
async function extractCodebase() {
  if (!A.root || A.extracting) return;
  if (!A.cfg.codebase && !(await chooseCodebase())) return;
  A.extracting = true; renderSidebar(); if (A.active === 'special:codemap') renderCodemap();
  const r = await host.extract(A.cfg.codebase);
  A.extracting = false;
  if (r.error) { toast(r.error, 'error'); renderSidebar(); renderCodemap(); return; }
  await host.write('asbuilt/workspace.dsl', r.dsl);
  await host.write('asbuilt/facts.json', JSON.stringify(r.facts, null, 2) + '\n');
  {
    const { projects, deployables, tests, elements, edges, unresolved, ...extraStats } = r.stats;
    await recordEvent('extraction', { repo: r.facts.repo, revision: hash(r.dsl), projects, deployables, tests, elements, edges, unresolved,
      ...(Object.keys(extraStats).length ? { payload: { stats: extraStats } } : {}) });
  }
  await loadAsbuilt(); recompile(); openSpecial('special:codemap'); renderAll();
  toast(`Mapped ${plural(r.stats.deployables, 'deployable')}, ${plural(r.stats.edges, 'dependency', )} from ${plural(r.stats.projects, 'project')}${r.stats.unresolved ? `; ${r.stats.unresolved} could not be resolved` : ''}.`);
}
async function adoptAsDesign() {
  if (A.model.elements.size && !confirm(`Replace ${A.cfg.model} with the as-built map? Your current design is overwritten.`)) return;
  const dsl = Core.containerLevelText(await readText('asbuilt/workspace.dsl')).replace(/^\/\/.*\n/gm, '').replace(/\(as built\)/, '');
  await host.write(A.cfg.model, dsl); await loadModel(); recompile(); await openFile(A.cfg.model); renderAll();
  toast('The design now starts from the code as it is. Add d.* properties where they matter.');
}
async function adoptComponents(builtId, designId) {
  const b = A.buffers.get(A.cfg.model);
  if (b && b.dirty) return toast(`Save ${A.cfg.model} first. Adopting writes to the file and would overwrite your unsaved edits.`, 'error');
  const built = A.asbuiltFull.elements.get(builtId), want = A.model.elements.get(designId);
  const r = Core.spliceComponents(A.modelText, A.model, designId, A.asbuiltFull, builtId);
  if (r.error) return toast(r.error, 'error');
  const n = [...A.asbuiltFull.elements.values()].filter(e => e.kind === 'component' && e.parent === builtId).length;
  if (!confirm(`Add ${plural(n, 'component')} from ${built.name} to ${want.name} in ${A.cfg.model}?`)) return;
  await host.write(A.cfg.model, r.text); await loadModel(); recompile(); await openFile(A.cfg.model, want.line); renderAll();
  toast(`Adopted ${plural(n, 'component')} into ${want.name}.`);
}
function codemapSidebar() {
  const cb = A.cfg.codebase, f = A.facts, d = A.drift;
  let h = section('cb', 'Codebase', cb
    ? `<div class="hint"><b>${esc(cb)}</b>${f ? `<br>Extracted ${esc(new Date(f.extractedAt).toLocaleString())}` : '<br>Not extracted yet'}</div>
       <button class="btn ${A.asbuilt ? '' : 'primary'} block" data-a="extract" ${A.extracting ? 'disabled' : ''}>${A.extracting ? 'Extracting…' : A.asbuilt ? 'Re-extract' : 'Extract the as-built map'}</button>
       <div style="padding:0 20px 8px"><button class="lnk" data-a="choosecode">Change folder</button></div>`
    : `<div class="hint">Point designc at a repository to map what exists today. It only reads the folder.</div><button class="btn primary block" data-a="choosecode">Choose codebase folder</button>`);
  if (f) h += section('cbstats', 'Found', `<div class="hint">${plural(f.projects.length, 'project')}: ${plural(f.projects.filter(p => ['web', 'worker', 'app'].includes(p.kind)).length, 'deployable')}, ${plural(f.projects.filter(p => p.kind === 'library').length, 'library')}, ${plural(f.projects.filter(p => p.kind === 'test').length, 'test project')} (not mapped). ${plural(f.edges.length, 'dependency', )} with evidence.</div>`);
  if (A.asbuilt && !A.model.elements.size) h += `<button class="btn primary block" data-a="adopt">Start the design from this map</button>`;
  if (d) {
    const row = (label, desc, attrs) => `<div class="row" style="--indent:20px;height:auto;min-height:22px;white-space:normal;padding-top:3px;padding-bottom:3px" ${attrs}><span class="lbl">${label}</span>${desc ? `<span class="desc">${desc}</span>` : ''}</div>`;
    const byName = n => { const e = [...A.asbuilt.elements.values()].find(x => x.name === n); return e ? `data-cmsel="${esc(e.id)}"` : ''; };
    const body = (d.undeclared.length ? `<div class="hint" style="padding-bottom:2px"><b>In code, not in the design</b></div>` + d.undeclared.map(u => row(`${esc(u.from)} → ${esc(u.to)}`, 'dependency', `data-cmsel="${esc(A.asbuilt.relById.get(u.builtRel).src)}"`)).join('') + d.unknownEls.map(n => row(esc(n), 'element', byName(n))).join('') : d.unknownEls.map(n => row(esc(n), 'element in code only', byName(n))).join(''))
      + (d.unrealised.length || d.missingEls.length ? `<div class="hint" style="padding-bottom:2px"><b>Designed, not found in code</b></div>` + d.unrealised.map(u => row(`${esc(u.from)} → ${esc(u.to)}`, 'dependency', `data-cmsel="${esc(u.src)}"`)).join('') + d.missingEls.map(n => row(esc(n), 'element', '')).join('') : '')
      + ((d.uiUntagged || []).length ? `<div class="hint" style="padding-bottom:2px"><b>Single-page app not tagged UI</b></div>` + d.uiUntagged.map(n => row(esc(n), 'add the UI tag so acceptance criteria apply', '')).join('') : '')
      || '<div class="hint">The code matches the design.</div>';
    h += section('drift', `Drift (${d.undeclared.length + d.unknownEls.length + d.unrealised.length + d.missingEls.length + (d.uiUntagged || []).length})`, body);
  } else if (A.asbuilt) h += section('drift', 'Drift', `<div class="hint">Drift appears once ${esc(A.cfg.model)} has elements to compare against.</div>`);
  if (A.intent) h += section('intent', `Declared intent (${A.intent.missing.length})`, intentBody());
  if (A.cdrift && cmHasComponents()) h += section('cdrift', 'Components', cmDriftBody());
  if (f) h += codeAreasSection();
  if (f && f.unresolved.length) h += section('unres', `Unresolved (${f.unresolved.length})`, `<div class="hint">Extraction saw these but could not tie them to an element, so they are not on the map.</div>` +
    f.unresolved.map(u => `<div class="item" data-code="${esc(u.file)}" data-line="${u.line}"><div class="l1"><span class="id">${esc(u.where)}</span></div><div class="l2">${esc(u.what)}</div><div class="l2" style="font-family:var(--mono);font-size:11px">${esc(u.file)}:${u.line}</div></div>`).join(''));
  return h;
}
// What a repo document declares it depends on (designc.json extract.intent) against the model. Display only.
function intentBody() {
  const i = A.intent;
  if (i.error) return `<div class="hint">${esc(i.file)}: ${esc(i.error)}. Fix the file or the extract.intent path, then re-extract.</div>`;
  const row = n => `<div class="row" style="--indent:20px;height:auto;min-height:22px;white-space:normal;padding-top:3px;padding-bottom:3px"><span class="lbl">${esc(n)}</span><span class="desc">declared, not in the design</span></div>`;
  return `<div class="hint">${esc(i.file)} declares ${plural(i.declared, 'dependency')}; ${i.missing.length ? `${i.missing.length} not found by name or d.aka in ${esc(A.cfg.model)}.` : 'all are in the design.'}</div>` + i.missing.map(row).join('');
}
// d.code against the files in the codebase. Display only: not in Problems, the gate or the CLI.
function codeAreasSection() {
  const ar = A.areas;
  if (!ar) return section('areas', 'Code areas', '<div class="hint">Re-extract to see code areas: this map was extracted before designc kept the file list.</div>');
  if (!ar.areas.length) return section('areas', 'Code areas', '<div class="hint">No areas defined, so drift is container-level only: a change inside a container, or code in no area, cannot show. Set d.code on a container or its components to say where that code lives; a coding agent confines each task to it.</div>' + codeAreasButton());
  const row = (label, desc, attrs) => `<div class="row" style="--indent:20px;height:auto;min-height:22px;white-space:normal;padding-top:3px;padding-bottom:3px" ${attrs}><span class="lbl">${label}</span>${desc ? `<span class="desc">${desc}</span>` : ''}</div>`;
  const empty = ar.areas.filter(a => !a.matched).length, MAX = 50;
  const body = `<div class="hint">Code areas cover ${ar.files - ar.unclaimed.length} of the ${plural(ar.files, 'file')} in the codebase.</div>`
    + ar.areas.map(a => row(`${esc(a.name)}: <code>${esc(a.pattern)}</code>`, a.matched ? plural(a.matched, 'file') : esc(a.hint || 'matches no file in the codebase'), `data-open="${esc(A.cfg.model)}" data-line="${A.model.elements.get(a.id).line}"`)).join('')
    + (ar.unclaimed.length ? `<div class="hint" style="padding-bottom:2px"><b>In no code area</b></div>` + ar.unclaimed.slice(0, MAX).map(x => row(esc(x), '', `data-code="${esc(x)}" data-line="1"`)).join('')
      + (ar.unclaimed.length > MAX ? `<div class="hint">and ${ar.unclaimed.length - MAX} more</div>` : '') : '');
  return section('areas', `Code areas (${empty + ar.unclaimed.length})`, body);
}
function cmDriftBody() {
  const c = A.cdrift, M = A.asbuiltFull, row = (label, desc, attrs) => `<div class="row" style="--indent:20px;height:auto;min-height:22px;white-space:normal;padding-top:3px;padding-bottom:3px" ${attrs}><span class="lbl">${label}</span>${desc ? `<span class="desc">${desc}</span>` : ''}</div>`;
  const kids = id => [...M.elements.values()].filter(e => e.kind === 'component' && e.parent === id);
  let h = '';
  for (const id of c.scored) {
    const cont = M.elements.get(id), dc = c.toDesign.get(id);
    const rows = kids(id).filter(e => !c.toDesign.has(e.id)).map(e => row(esc(e.name), 'component in code only', `data-cmsel="${esc(e.id)}"`)).join('')
      + M.rels.filter(r => c.relStatus.get(r.id) === 'undeclared' && M.elements.get(r.src).parent === id || c.relStatus.get(r.id) === 'undeclared' && M.elements.get(r.dst).parent === id)
        .map(r => row(`${esc(M.elements.get(r.src).name)} → ${esc(M.elements.get(r.dst).name)}`, 'dependency', `data-cmsel="${esc(r.src)}"`)).join('')
      + [...A.model.elements.values()].filter(x => x.kind === 'component' && x.parent === dc.id && !c.toBuilt.has(x.id)).map(x => row(esc(x.name), 'designed, not found in code', '')).join('');
    h += `<div class="hint" style="padding-bottom:2px"><b>${esc(cont.name)}</b></div>${rows || '<div class="hint">The components match the design.</div>'}`;
  }
  for (const a of c.adoptable) h += row(`${esc(M.elements.get(a.built).name)}: design has no components (${kids(a.built).length} found)`, '', `data-cmsel="${esc(a.built)}"`) + cmAdoptBtn(a.built);
  return h || '<div class="hint">No container in the design has components to compare.</div>';
}
const BASIS_WORDS = { anchor: 'function class, controller or endpoint class', 'output-binding': 'function output-binding type', library: 'library', 'first-folder': 'folder', 'app-shell': 'App shell', shared: 'Shared', override: 'designc.json override' };
function cmComponentSide(e) {
  const f = A.facts || {}, M = A.asbuiltFull, c = (f.components || []).find(x => x.id === e.id), cd = A.cdrift;
  const evRows = list => list.map(v => `<div class="evrow" data-code="${esc(v.file)}" data-line="${v.line}"><div class="evfile">${esc(v.file)}:${v.line}</div><code>${esc(v.text)}</code></div>`).join('');
  const edges = dir => (f.componentEdges || []).filter(x => (dir === 'out' ? x.from : x.to) === e.id).map(x => {
    const other = M.elements.get(dir === 'out' ? x.to : x.from), r = M.rels.find(y => y.src === x.from && y.dst === x.to);
    const st = cd && r ? cd.relStatus.get(r.id) : '';
    const tag = st === 'matched' ? '<span class="tag pass">in design</span>' : st === 'undeclared' ? '<span class="tag warning">not in design</span>' : '';
    return `<div class="evgroup"><div><b>${dir === 'out' ? '→ ' : '← '}${esc(other ? other.name : '?')}</b> ${esc(x.label)} <span class="desc">${esc(x.tech || '')}</span> ${tag}</div>${evRows(x.evidence || [])}</div>`;
  }).join('');
  const match = cd && cd.toDesign.get(e.id), parent = M.elements.get(e.parent);
  const status = !cd ? '' : match ? `<p>Design: <b>${esc(match.name)}</b></p>` : cd.scored.has(e.parent) ? `<p style="color:var(--warn)"><b>Not in the design.</b> Add it under ${esc(parent.name)}, or put <span class="code">"d.aka" "${esc(e.name)}"</span> on the designed component if it is the same thing.</p>` : '';
  return `<h3>${esc(e.name)}</h3><div class="muted">Component of ${esc(parent ? parent.name : '')}${c ? ` · ${esc(BASIS_WORDS[c.basis] || c.basis)}` : ''}</div>${status}
    ${c && c.files.length ? `<h4>Files</h4>${c.files.map(x => `<div class="evrow" data-code="${esc(x)}" data-line="1"><div class="evfile">${esc(x)}</div></div>`).join('')}` : ''}
    <h4>Why it's on the map</h4>${c ? evRows(c.evidence) : '<p class="muted">No evidence recorded.</p>'}
    ${edges('out') ? `<h4>Depends on</h4>${edges('out')}` : ''}${edges('in') ? `<h4>Used by</h4>${edges('in')}` : ''}`;
}
function cmAdoptBtn(builtId) {
  const a = A.cdrift && A.cdrift.adoptable.find(x => x.built === builtId);
  return a ? `<div style="padding:0 20px 8px"><button class="btn block" data-a="adoptcomp" data-built="${esc(a.built)}" data-design="${esc(a.design)}">Adopt these components</button></div>` : '';
}
function cmHasComponents() { return !!A.asbuiltFull && [...A.asbuiltFull.elements.values()].some(e => e.kind === 'component'); }
// The UI level's repos (7e): the codebase, then each designc.json references key that a ui.screens entry names.
function cmUiRepos() {
  const refs = Dispatch.references(A.cfg.references), screens = (A.cfg.ui && A.cfg.ui.screens) || {};
  const named = k => Object.values(screens).some(d => d && typeof d === 'object' && d[k] != null);
  return ['codebase', ...(refs && refs.refs ? refs.refs.map(r => r.key).filter(named) : [])];
}
const cmUiHasScreens = g => !!(g && g.screens && g.screens.length);
// The graph shown: facts.ui for the codebase, else asbuilt/ui-<key>.json (null until that repo is extracted).
function cmUiGraph() { return A.cmRepo && A.cmRepo !== 'codebase' ? (A.uiRefs || {})[A.cmRepo] || null : A.facts && A.facts.ui; }
function cmHasUi() { return cmUiHasScreens(A.facts && A.facts.ui) || cmUiRepos().length > 1; }
function cmHasCode() { return !!(A.facts && A.facts.code && A.facts.code.types && A.facts.code.types.length); }
// The component the Code level opens on: the scope if it is one, else the selected component, else the first with types.
function cmCodeScope() {
  const has = id => id && A.facts.code.types.some(t => t.component === id);
  if (has(A.cmScope)) return A.cmScope;
  if (has(A.cmSel)) return A.cmSel;
  const t = A.facts.code.types[0]; return t ? t.component : null;
}
function cmModel() {
  if (A.cmLevel === 'code') return cmHasCode() ? CodeLevel.model(A.facts.code, A.cmScope) : A.asbuilt;
  return A.asbuiltFull ? Core.view(A.asbuiltFull, { level: A.cmLevel, scope: A.cmScope }) : A.asbuilt;
}
function cmGo(level, scope) {
  if (level === 'component' && !cmHasComponents()) return;
  if (level === 'ui') {
    if (!cmHasUi()) return; A.cmSel = null; A.cmLevel = 'ui';
    const repos = cmUiRepos();
    if (!repos.includes(A.cmRepo)) A.cmRepo = cmUiHasScreens(A.facts && A.facts.ui) ? 'codebase' : repos[1];
    const g = cmUiGraph(); if (cmUiHasScreens(g) && !UiGraph.screen(g, A.cmScreen)) A.cmScreen = g.screens[0].name;
    return renderCodemap();
  }
  if (level === 'code') { if (!cmHasCode()) return; if (scope === undefined || scope === null) scope = cmCodeScope(); }
  A.cmLevel = level; if (scope !== undefined) A.cmScope = scope;
  A.cmZoom = 'fit';
  const m = cmModel(); if (A.cmSel && !(m && m.elements.has(A.cmSel))) A.cmSel = null;
  renderCodemap();
}
function cmUp() {
  if (A.cmLevel === 'ui') return cmGo('container');
  if (A.cmLevel === 'code') { const c = A.asbuiltFull && A.asbuiltFull.elements.get(A.cmScope); A.cmSel = null; return cmGo('component', c ? c.parent : null); }
  if (A.cmLevel === 'component') cmGo('container'); else if (A.cmLevel === 'container') cmGo('context'); }
function cmSeg() {
  const has = cmHasComponents();
  const hasCode = cmHasCode(), hasUi = cmHasUi();
  const b = (lv, name) => `<button class="${A.cmLevel === lv ? 'on' : ''}" data-a="cmlevel" data-level="${lv}" ${lv === 'component' && !has ? 'disabled title="No components were found"' : ''} ${lv === 'code' && !hasCode ? 'disabled title="No types were found. Re-extract to read them."' : ''} ${lv === 'ui' && !hasUi ? 'disabled title="No screens were read. Name them in designc.json ui.screens, then re-extract."' : ''}>${name}</button>`;
  const sc = A.cmScope && A.asbuiltFull && A.asbuiltFull.elements.get(A.cmScope);
  const cc = A.cmLevel === 'code' && A.asbuiltFull && A.asbuiltFull.elements.get(A.cmScope), cp = cc && A.asbuiltFull.elements.get(cc.parent);
  const crumb = A.cmLevel === 'code' ? `<span class="cm-crumb"><button class="cm-all" data-a="cmscope">All</button>${cp ? ` ▸ <button class="cm-all" data-a="cmcontainer" data-id="${esc(cp.id)}">${esc(cp.name)}</button>` : ''}${cc ? ` ▸ <b>${esc(cc.name)}</b>` : ''}</span>` : A.cmLevel === 'component' ? `<span class="cm-crumb"><button class="cm-all" data-a="cmscope">All</button>${sc ? ` ▸ <b>${esc(sc.name)}</b>` : ''}</span>` : '';
  return `<span class="cm-seg">${b('context', 'Context')}${b('container', 'Containers')}${b('component', 'Components')}${b('code', 'Code')}${b('ui', 'UI')}</span>${crumb}`;
}
function renderCodemap() {
  const el = $('#special');
  if (A.active !== 'special:codemap') return;
  if (!A.asbuilt) {
    el.innerHTML = `<div class="dash"><h1>Code map</h1><p class="lede">A C4 map of the codebase as it exists, extracted from project files, configuration and code. Every box and arrow links to the lines that prove it. Once there is a design, the map shows where code and design disagree.</p>
      ${A.cfg.codebase ? `<p>Codebase: <span class="code">${esc(A.cfg.codebase)}</span></p><button class="btn primary" data-a="extract" ${A.extracting ? 'disabled' : ''}>${A.extracting ? 'Extracting…' : 'Extract the as-built map'}</button>` : '<button class="btn primary" data-a="choosecode">Choose codebase folder</button>'}
      <div class="block" style="margin-top:22px"><h3>What the extractor reads</h3><div class="tw2"><table class="t">
      <tr><td>Web, Worker and Exe projects, and SPA/Node package.json</td><td>Containers. Libraries fold into the deployables that reference them; test projects are skipped.</td></tr>
      <tr><td>EF Core <span class="code">DbContext</span> classes</td><td>Stores, with the provider from <span class="code">UseSqlServer</span> and friends, linked to the deployables that use them.</td></tr>
      <tr><td>Redis, Blob and Cosmos clients</td><td>Stores, named by their connection string.</td></tr>
      <tr><td><span class="code">AddHttpClient</span> + base address in appsettings</td><td>Sync edges, matched to projects by launch port or name; other hosts become external systems.</td></tr>
      <tr><td>Service Bus senders and processors</td><td>Async edges, matched on queue or topic name.</td></tr>
      <tr><td>JS/TS <span class="code">package.json</span> dependencies</td><td>SPA and Node API containers; routers and dev-proxy config give their ports and provided routes.</td></tr>
      <tr><td>Function classes, controllers and endpoint classes, libraries, first folders (override: <span class="code">designc.json</span> <span class="code">extract.components</span>)</td><td>Components inside each container, with edges where one type references another.</td></tr>
      <tr><td>The Context · Containers · Components switcher</td><td>Zoom the map. Double-click a container to drill into its components; Backspace goes up. "Adopt these components" copies them into the design.</td></tr>
      <tr><td>HTTP and hub calls (fetch/axios/withUrl) across languages</td><td>Sync/realtime edges, matched to providers by route; a dev-proxy port breaks ties between multiple candidates.</td></tr>
      <tr><td><span class="code">designc.json</span> bindings</td><td>Env-only calls (no literal target in code) linked to a named element you declare, instead of staying unresolved.</td></tr>
      </table></div></div></div>`;
    return;
  }
  const f = A.facts || { repo: '', extractedAt: null };
  el.innerHTML = `<div class="cm"><div class="cm-bar"><b>${esc(f.repo)}</b><span class="desc">${f.extractedAt ? 'extracted ' + esc(new Date(f.extractedAt).toLocaleString()) : ''}</span>
      ${cmSeg()}
      ${A.cmLevel === 'code' ? '<span class="legend"><i class="lg ghost"></i>type in another component</span>' : ''}
      ${A.cmLevel !== 'context' && A.cmLevel !== 'code' && A.cmLevel !== 'ui' ? `<span class="legend"><i class="lg ok"></i>in the design <i class="lg warn"></i>not in the design ${A.drift ? '<i class="lg ghost"></i>designed, not in code' : ''}</span>` : ''}
      ${A.cmLevel === 'ui' ? cmUiBar() : ''}
      ${A.cmLevel === 'ui' && cmUiHasScreens(cmUiGraph()) ? `<label class="chk">Screen <select data-cmscreen aria-label="Screen">${cmUiGraph().screens.map(s => `<option value="${esc(s.name)}" ${s.name === A.cmScreen ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></label>` : ''}
      <span class="spacer"></span>${A.drift && A.cmLevel !== 'context' && A.cmLevel !== 'code' && A.cmLevel !== 'ui' ? `<label class="chk"><input type="checkbox" data-a="ghost" ${A.showGhost ? 'checked' : ''}> Show designed-only edges</label>` : ''}
      ${A.cmLevel === 'ui' ? '' : '<button class="btn" data-a="cmfit">Fit</button>'}<button class="btn" data-a="extract" ${A.extracting ? 'disabled' : ''}>${A.extracting ? 'Extracting…' : 'Re-extract'}</button></div>
    <div class="cm-main">${A.cmLevel === 'ui' ? '<div class="cm-ui" id="cmui"></div>' : '<div class="cm-canvas sheetscroll" id="cmcanvas"></div>'}<aside class="cm-side" id="cmside"></aside></div></div>`;
  requestAnimationFrame(drawCodemap);
}
function drawCodemap() {
  if (A.cmLevel === 'ui') return drawUi();
  const host_ = $('#cmcanvas'); if (!host_ || !A.asbuilt) return;
  if (A.cmLevel === 'code') return drawCode(host_);
  const lvl = A.cmLevel, m = cmModel(), L = layout(m, { groupEdges: lvl === 'component' });
  const d = lvl === 'context' ? null : A.drift, cd = lvl === 'component' ? A.cdrift : null;
  const full = A.asbuiltFull;
  const compOf = id => { const e = m.elements.get(id); return e && e.kind === 'component' ? e : null; };
  const ghosts = lvl === 'container' && d ? d.unrealised.map(u => ({ src: u.src, dst: u.dst, label: 'designed, not in code' }))
    : cd ? cd.unrealised.filter(u => m.elements.has(u.src) && m.elements.has(u.dst)).map(u => ({ src: u.src, dst: u.dst, label: 'designed, not in code' })) : [];
  host_.innerHTML = drawModel(m, L, {
    attr: 'cm', zoom: fitZoom(host_, L, A.cmZoom),
    extra: A.showGhost ? ghosts : [],
    edgeStyle: r => {
      const as = Core.interaction(r) === 'async', hot = A.cmSel && (r.src === A.cmSel || r.dst === A.cmSel);
      const compRel = compOf(r.src) || compOf(r.dst);
      const st = compRel ? (cd ? cd.relStatus.get(r.id) : null) : d ? d.relStatus.get(r.id) : 'matched';
      if (st === 'undeclared' || (!compRel && d && st !== 'matched')) return { color: 'var(--warn)', width: hot ? 2.8 : 2.1, dash: as ? '6 4' : '', marker: 'warning', labelColor: 'var(--warn)', label: `${r.description}${st === 'undeclared' ? ' (not in design)' : ''}` };
      return { color: hot ? 'var(--accent)' : 'var(--ink3)', width: hot ? 2.2 : 1.3, dash: as ? '6 4' : '', label: r.description };
    },
    nodeStyle: e => {
      const on = A.cmSel === e.id;
      const q = cmQualityBadge(e);
      if (e.kind === 'component') {
        const warn = cd && full && cd.scored.has(e.parent) && !cd.toDesign.has(e.id), ink = cd && cd.toDesign.has(e.id);
        return { ...q, stroke: on ? 'var(--accent)' : warn ? 'var(--warn)' : ink ? 'var(--ink)' : 'var(--ink3)', sw: on ? 2.8 : warn ? 2.2 : 1.5, dash: warn ? '6 3' : '', note: warn ? 'not in design' : '' };
      }
      const mapped = !d || d.toDesign.has(e.id);
      return { ...q, stroke: on ? 'var(--accent)' : mapped ? 'var(--ink)' : 'var(--warn)', sw: on ? 2.8 : mapped ? 1.5 : 2.2, dash: mapped ? '' : '6 3', note: mapped ? '' : 'not in design' };
    },
  });
  renderCmSide();
}
// The Code level: the types of one component and what they refer to, drawn with the shared layout and drawing.
function drawCode(host_) {
  const m = cmModel(), L = layout(m);
  host_.innerHTML = drawModel(m, L, {
    attr: 'cm', zoom: fitZoom(host_, L, A.cmZoom),
    edgeStyle: r => { const hot = A.cmSel && (r.src === A.cmSel || r.dst === A.cmSel); return { color: hot ? 'var(--accent)' : 'var(--ink3)', width: hot ? 2.2 : 1.3, dash: r.description === 'uses' ? '6 4' : '', label: r.description }; },
    nodeStyle: e => { const on = A.cmSel === e.id; return { ...cmQualityBadge(e), stroke: on ? 'var(--accent)' : e.outside ? 'var(--ink3)' : 'var(--ink)', sw: on ? 2.8 : 1.5, dash: e.outside ? '6 3' : '', note: e.outside ? cmCompName(e.component) : '' }; },
  });
  renderCmSide();
}
// The UI level: one screen's controls by component, read from source (facts.ui, extract/ui.js). A row opens file:line.
// The Repo picker and, for a references repo, its own read-only extraction (human only; main writes asbuilt/ui-<key>.json).
function cmUiBar() {
  const repos = cmUiRepos(); if (repos.length < 2) return '';
  const ref = A.cmRepo !== 'codebase', busy = A.extractingRef === A.cmRepo;
  return `<label class="chk">Repo <select data-cmrepo aria-label="Repo">${repos.map(k => `<option value="${esc(k)}" ${k === A.cmRepo ? 'selected' : ''}>${esc(k)}</option>`).join('')}</select></label>`
    + (ref ? `<button class="btn" data-a="extractrefui" data-key="${esc(A.cmRepo)}" ${busy ? 'disabled' : ''}>${busy ? 'Extracting…' : `${cmUiGraph() ? 'Re-extract' : 'Extract'} ${esc(A.cmRepo)}`}</button>` : '');
}
async function extractReferenceUi(key) {
  if (A.extractingRef) return;
  A.extractingRef = key; renderCodemap();
  const r = await host.extractReferenceUi(key);
  A.extractingRef = null;
  if (r.error) { toast(r.error, 'error'); return renderCodemap(); }
  A.uiRefs = { ...(A.uiRefs || {}), [key]: r.ui };
  const n = r.ui.controls.length;
  toast(`Read ${plural(r.ui.screens.length, 'screen')} and ${plural(n, 'control')} from ${key} into ${r.path}${r.ui.unresolved.length ? `; ${r.ui.unresolved.length} could not be resolved` : ''}.`);
  cmGo('ui');
}
// Rows of a references repo open its files, not the codebase's.
function cmUiTagRef() {
  if (A.cmRepo === 'codebase' || !A.cmRepo) return;
  document.querySelectorAll('#cmui [data-code], #cmside [data-code]').forEach(n => { n.dataset.ref = A.cmRepo; });
}
function drawUi() {
  const box = $('#cmui'); if (!box || !cmHasUi()) return;
  const g = cmUiGraph();
  if (!cmUiHasScreens(g)) {
    box.innerHTML = `<div class="hint" style="padding:16px">${g ? `No screen names ${esc(A.cmRepo)} in designc.json ui.screens.` : `${esc(A.cmRepo)} has not been read yet. Extract ${esc(A.cmRepo)} reads its screens from source, read-only, into asbuilt/ui-${esc(A.cmRepo)}.json.`}</div>`;
    return renderCmSide();
  }
  const s = UiGraph.screen(g, A.cmScreen);
  if (!s) { box.innerHTML = ''; return renderCmSide(); }
  const nameCell = c => c.name != null ? esc(c.name)
    : `<span class="muted">${c.names.length ? esc(c.names.map(n => n.from === 't()' ? `t('${n.value}')` : n.value != null ? n.value : n.expr ? `{${n.expr}}` : `#${n.ref}`).join(' · ')) : 'no name in source'}</span>`;
  const roleCell = c => c.role ? `${esc(c.role)} <span class="tag" title="${esc(UiGraph.BASIS[c.basis] || c.basis)}">${esc(c.basis)}</span>` : '<span class="tag warning" title="The source does not show a role; see Unresolved">unknown</span>';
  // The Element cell: the intrinsic tag; inside a followed component also "via" it, linking to the element itself.
  const elCell = c => `<code>&lt;${esc(c.tag)}&gt;</code>${c.library ? ` <span class="tag" title="From a library whose source is not read">${esc(c.library)}</span>` : ''}${c.as ? ` <span class="desc">via ${esc(c.as)}</span>` : ''}${c.at ? ` <span class="evfile cm-at" data-code="${esc(c.at.file)}" data-line="${c.at.line}" title="Open the element in ${esc((c.via || []).map(v => v.component.split('#')[1]).join(' > '))}">${esc(c.at.file)}:${c.at.line}</span>` : ''}`;
  // The When cell: conditions (source text, never evaluated) and state props, each opening where it is written.
  const whenCell = c => (c.when || []).map(w => `<div class="cm-when" data-code="${esc(w.file)}" data-line="${w.line}" title="${esc(w.kind)} at ${esc(w.file)}:${w.line}"><code>${esc(trunc(w.expr, 48))}</code></div>`).join('')
    + Object.entries(c.props || {}).map(([k, v]) => `<span class="tag" title="${v === true ? `Always ${esc(k)}` : `${esc(k)} when ${esc(v)}`}">${esc(k)}${v === true ? '' : ` if ${esc(trunc(v, 24))}`}</span> `).join('');
  // The Value cell: how its value is formatted and the form field it registers, each opening where it is written.
  const valueCell = c => (c.format ? `<div class="cm-when cm-value" data-code="${esc(c.format.file)}" data-line="${c.format.line}" title="${esc(c.format.lib)} ${esc(c.format.call)}(${esc(c.format.args)})"><span class="tag">format</span> <code>${esc(trunc(UiGraph.formatText(c.format), 40))}</code></div>` : '')
    + (c.field ? `<div class="cm-when cm-value" title="${c.field.form ? `Rules from ${esc(c.field.form)} and register` : 'No single form schema names this field; rules from register only'}"><span class="tag">field</span> <code>${esc(c.field.name != null ? c.field.name : `{${c.field.expr || ''}}`)}</code>${c.field.rules.length ? ` <span class="desc">${esc(trunc(UiGraph.rulesText(c.field.rules), 48))}</span>` : ''}</div>` : '');
  const rows = s.tree.map(comp => `<tr class="grp"><td colspan="6" style="padding-left:${8 + 16 * (comp.depth || 0)}px"><b>${esc(comp.name)}</b> ${comp.file ? `<span class="desc">${esc(comp.file)}</span>` : ''}${comp.renders && comp.renders.length ? ` <span class="desc">renders ${esc(comp.renders.join(', '))}</span>` : ''}</td></tr>`
    + comp.controls.map(c => `<tr class="uirow" data-code="${esc(c.file)}" data-line="${c.line}" title="Open ${esc(c.file)}:${c.line}"><td>${roleCell(c)}</td><td>${nameCell(c)}</td><td>${elCell(c)}</td><td>${whenCell(c)}</td><td>${valueCell(c)}</td><td class="evfile">${esc(c.file)}:${c.line}</td></tr>`).join('')).join('');
  box.innerHTML = s.controls.length
    ? `<table class="t" aria-label="Controls on ${esc(s.name)}"><thead><tr><th>Role</th><th>Name</th><th>Element</th><th>When</th><th>Value</th><th>Where</th></tr></thead><tbody>${rows}</tbody></table>`
    : `<div class="hint" style="padding:16px">${s.roots.length ? `No controls found in ${plural(s.roots.length, 'file')} of this screen.` : 'The screen\'s patterns match no source file. See Unresolved.'}</div>`;
  renderCmSide();
  cmUiTagRef();
}
function cmUiSide() {
  const g = cmUiGraph();
  if (!cmUiHasScreens(g)) return `<h3>${esc(A.cmRepo || '')}</h3><p class="muted">A references repo is read only when you extract it. Its screens are the ui.screens entries that name ${esc(A.cmRepo || '')}.</p>${cmUiHelp()}`;
  const s = UiGraph.screen(g, A.cmScreen), sum = UiGraph.summary(g).screens.find(x => x.name === A.cmScreen);
  const general = (g.unresolved || []).filter(u => !u.screen);
  const un = s ? s.unresolved.concat(general) : general;
  return `<h3>${esc(A.cmScreen || '')}</h3><div class="muted">${A.cmRepo && A.cmRepo !== 'codebase' ? `From ${esc(A.cmRepo)}${g.extractedAt ? ', read ' + esc(new Date(g.extractedAt).toLocaleString()) : ''}. ` : ''}Read from source; display only, never a gate input.</div>
    ${sum ? `<p>${plural(sum.controls, 'control')} in ${plural(sum.roots, 'file')}${sum.roleless ? `; ${sum.roleless} without a role` : ''}${sum.unnamed ? `; ${sum.unnamed} without a literal name` : ''}.</p>` : ''}
    ${s && s.roots.length ? `<h4>Files</h4>${s.roots.map(f => `<div class="evrow" data-code="${esc(f)}" data-line="1"><div class="evfile">${esc(f)}</div></div>`).join('')}` : ''}
    ${s && s.followed.length ? `<h4>Followed components (${s.followed.length})</h4>${s.followed.map(c => `<div class="evrow" data-code="${esc(c.file)}" data-line="${c.line}"><b>${esc(c.name)}</b><div class="evfile">${esc(c.file)}:${c.line}</div></div>`).join('')}` : ''}
    ${s && s.formats.length ? `<h4>Formats (${s.formats.length})</h4>${s.formats.map(f => `<div class="evrow" data-code="${esc(f.file)}" data-line="${f.line}"><b>${esc(trunc(UiGraph.formatText(f), 40))}</b> <span class="tag">${esc(f.lib)}</span><div class="evfile">${esc(f.file)}:${f.line}</div></div>`).join('')}` : ''}
    ${s && s.forms.length ? `<h4>Forms (${s.forms.length})</h4>${s.forms.map(f => `<div class="evrow" data-code="${esc(f.file)}" data-line="${f.line}"><b>${esc(f.form)}</b> <span class="tag">${esc(f.lib)}</span>${f.fields.map(x => `<div class="desc">${esc(x.name)}: ${esc(trunc(UiGraph.rulesText(x.rules) || 'no rules', 60))}</div>`).join('')}<div class="evfile">${esc(f.file)}:${f.line}</div></div>`).join('')}` : ''}
    ${un.length ? `<h4>Unresolved (${un.length})</h4>${un.map(u => `<div class="evrow" ${u.file === 'designc.json' ? 'data-open="designc.json" data-line="1"' : `data-code="${esc(u.file)}" data-line="${u.line}"`}>${esc(u.what)}<div class="evfile">${esc(u.file)}:${u.line}</div></div>`).join('')}` : ''}
    ${cmUiHelp()}`;
}
function cmUiHelp() {
  return `<p class="muted">A role comes from the HTML element or a literal role attribute; inside an in-repo component the screen renders, from the element it renders with the props passed (followed); for a tag listed in designc.json ui.roles, from that entry (mapped). Other library components are not read. A references repo (another key in a ui.screens entry) is read only when you extract it. When lists the conditions that render it and its state props as written; nothing is evaluated. Value shows a formatting call inside it (Intl, toLocale*, date-fns, dayjs, moment; the pattern only when literal) and the react-hook-form field it registers, with the rules of the one zod or yup schema naming that field. A name comes from a literal label, aria-label or text; t('key') and expressions are listed but never taken as the name.</p>`;
}
const cmCompName = id => { const c = A.asbuiltFull && A.asbuiltFull.elements.get(id); return c ? c.name : ''; };
function cmTypeSide(t) {
  const code = A.facts.code, rows = CodeLevel.methodsOf(code, t.id).sort((a, b) => b.cc - a.cc || a.name.localeCompare(b.name));
  const edges = dir => code.typeEdges.filter(x => (dir === 'out' ? x.from : x.to) === t.id).map(x => { const o = code.types.find(y => y.id === (dir === 'out' ? x.to : x.from)); return `<div class="evrow" data-code="${esc(x.evidence.file)}" data-line="${x.evidence.line}"><b>${dir === 'out' ? '→ ' : '← '}${esc(o ? o.name : '?')}</b> <span class="tag">${esc(x.via)}</span><div class="evfile">${esc(x.evidence.file)}:${x.evidence.line}</div></div>`; }).join('');
  const qf = qualityNow().findings.filter(f => f.typeId === t.id), hot = new Set(qf.filter(f => f.method).map(f => f.method));
  rows.forEach(x => { x.warn = hot.has(x.name); });
  return `<h3>${esc(t.name)}</h3><div class="muted">${esc(CodeLevel.LABEL[t.kind] || t.kind)} in ${esc(cmCompName(t.component))}</div>
    ${qf.length ? `<h4>Quality (${qf.length})</h4>${qf.map(f => `<div class="evrow" data-code="${esc(f.file)}" data-line="${f.line}"><span class="tag warning">${esc(f.code)}</span> ${esc(f.msg)}</div>`).join('')}` : ''}
    <h4>Methods (${rows.length})</h4>${rows.map(x => `<div class="evrow" data-code="${esc(x.file)}" data-line="${x.line}"><b>${esc(x.name)}</b> <span class="tag${x.warn ? ' warning' : ''}">cc ${x.cc}</span> <span class="tag">${x.lines} lines</span> ${x.coverage == null ? '<span class="tag" title="No coverage report covers this method">cov ?</span>' : `<span class="tag">cov ${Math.round(x.coverage * 100)}%</span> <span class="tag">CRAP ${Math.round(Quality.crap(x.cc, x.coverage) * 10) / 10}</span>`}<div class="evfile">${esc(x.file)}:${x.line}</div></div>`).join('') || '<p class="muted">No methods with a body.</p>'}
    <h4>Files</h4>${t.files.map(x => `<div class="evrow" data-code="${esc(x.file)}" data-line="${x.line}"><div class="evfile">${esc(x.file)}:${x.line}</div></div>`).join('')}
    ${edges('out') ? `<h4>Depends on</h4>${edges('out')}` : ''}${edges('in') ? `<h4>Used by</h4>${edges('in')}` : ''}`;
}
function renderCmSide() {
  const side = $('#cmside'); if (!side) return;
  const f = A.facts; const d = A.cmLevel === 'container' ? A.drift : null;
  if (A.cmLevel === 'ui') { side.innerHTML = cmUiSide(); return; }
  if (A.cmLevel === 'code') {
    const t = A.cmSel && f.code.types.find(x => x.id === A.cmSel);
    side.innerHTML = t ? cmTypeSide(t) : `<h3>${esc(cmCompName(A.cmScope))}</h3><p class="muted">Select a type to see its methods. Dashed boxes belong to other components.</p>`;
    return;
  }
  if (!A.cmSel) {
    side.innerHTML = `<h3>Projects</h3>${f ? f.projects.map(p => `<div class="evrow" data-code="${esc(p.file)}" data-line="1"><b>${esc(p.name)}</b> <span class="tag">${esc(p.kind)}</span> <span class="tag">${esc(p.lang)}</span><div class="evfile">${esc(p.file)}</div></div>`).join('') : ''}<p class="muted">Select a box to see the evidence behind it.</p>`;
    return;
  }
  const e = (A.asbuiltFull || A.asbuilt).elements.get(A.cmSel); if (!e) { side.innerHTML = ''; return; }
  if (e.kind === 'component') { side.innerHTML = cmComponentSide(e); return; }
  const fe = f && f.elements.find(x => x.name === e.name) || { evidence: [] };
  const match = d && d.toDesign.get(e.id);
  const evRows = list => list.map(v => `<div class="evrow" data-code="${esc(v.file)}" data-line="${v.line}"><div class="evfile">${esc(v.file)}:${v.line}</div><code>${esc(v.text)}</code></div>`).join('');
  const relStatus = (from, to) => { if (!d) return ''; const r = A.asbuilt.rels.find(x => A.asbuilt.elements.get(x.src).name === from && A.asbuilt.elements.get(x.dst).name === to); const s_ = r && d.relStatus.get(r.id); return s_ && s_ !== 'matched' ? '<span class="tag warning">not in design</span>' : s_ === 'matched' ? '<span class="tag pass">in design</span>' : ''; };
  const edgesOf = (dir) => (f ? f.edges.filter(x => (dir === 'out' ? x.from : x.to) === e.name) : []).map(x => `<div class="evgroup"><div><b>${dir === 'out' ? '→ ' + esc(x.to) : '← ' + esc(x.from)}</b> ${esc(x.label)} <span class="desc">${esc(x.tech)}</span> ${relStatus(x.from, x.to)}</div>${evRows(x.evidence)}</div>`).join('');
  side.innerHTML = `<h3>${esc(e.name)}</h3><div class="muted">${esc(e.technology || '')}${fe.project ? ` · <span class="lnk" data-code="${esc(fe.project)}" data-line="1">${esc(fe.project)}</span>` : ''}</div>
    ${d ? (match ? `<p>Design: <b>${esc(match.name)}</b></p>` : `<p style="color:var(--warn)"><b>Not in the design.</b> Add it to ${esc(A.cfg.model)}, or put <span class="code">"d.aka" "${esc(e.name)}"</span> on the designed element if it's the same thing under another name.</p>`) : ''}
    ${cmAdoptBtn(e.id)}
    <h4>Why it's on the map</h4>${evRows(fe.evidence) || '<p class="muted">No evidence recorded.</p>'}
    ${edgesOf('out') ? `<h4>Depends on</h4>${edgesOf('out')}` : ''}${edgesOf('in') ? `<h4>Used by</h4>${edgesOf('in')}` : ''}`;
}
