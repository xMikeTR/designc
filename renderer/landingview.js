/* designc desktop: the change layer on the code map. Classic script, shares the renderer's global scope with app.js and
   codemapview.js (loaded after both; nothing here runs at load except two document listeners).
   A landing (landings/<requirement>.yaml, see landing.js) is drawn over the code map as a layer. This file owns the loader
   for that folder, the Layer select, the drawing hooks codemapview calls, the side panel and Save. It never mutates
   A.asbuilt, A.asbuiltFull or A.facts: the layer is drawn on a copy of the view model. Buttons only, all HTML through esc(). */
A.landings = []; A.landingErrors = [];
A.layer = { req: null, draft: null, loadedText: null, dirty: false, typed: '', what: '', stage: '', pick: null, pickFor: null, bad: null, root: null };
let lyCache = null, lyIdxKey = null, lyIdx = null;

// ---------------------------------------------------------------- load
// landings/ is read in its own loader (not REG_DIRS, not a gate clause). A bad file is named in the layer panel.
async function loadLandings() {
  const good = [], bad = [];
  let files = [];
  try { files = await host.list('landings', ['.yaml', '.yml']); } catch { files = []; }
  for (const f of files) {
    const text = textOf(f.path) ?? f.text;
    const r = Landing.parseFile(f.path, text, jsyaml.load);
    if (r.record) good.push(r); else bad.push({ path: f.path, errors: r.errors, requirement: r.requirement });
  }
  good.sort((a, b) => String(a.record.requirement).localeCompare(String(b.record.requirement)));
  A.landings = good; A.landingErrors = bad;
  const L = A.layer, rootKey = A.root ? JSON.stringify(A.root) : null;
  if (L.root !== rootKey) { Object.assign(L, { req: null, draft: null, loadedText: null, dirty: false, typed: '', what: '', stage: '', pick: null, pickFor: null, bad: null, root: rootKey }); }
  if (L.req && !L.dirty) lyOpen(L.req);
  if (A.active === 'special:codemap' && typeof renderCodemap === 'function' && $('#cmcanvas')) renderCodemap();
}
const lyFind = req => A.landings.find(x => x.record.requirement === req) || null;
const lyBadFor = req => A.landingErrors.find(x => x.requirement === req || String(x.path).replace(/^.*\//, '').replace(/\.ya?ml$/i, '') === req) || null;
function lyReqs() {
  const ids = new Set([...(A.requirements || []).map(r => String(r.id)), ...A.landings.map(x => x.record.requirement)]);
  if (A.layer.req) ids.add(A.layer.req);
  return [...ids].filter(Landing.safeId).sort();
}
// Open a requirement's landing as the working draft (a copy: the loaded record is never edited in place).
function lyOpen(req) {
  const L = A.layer; L.req = req || null; L.dirty = false; L.pick = null; L.pickFor = null; L.typed = ''; L.what = ''; L.stage = ''; L.bad = null;
  if (!req) { L.draft = null; L.loadedText = null; return; }
  const hit = lyFind(req);
  if (hit) { L.draft = JSON.parse(JSON.stringify(hit.record)); L.loadedText = hit.text; return; }
  const bad = lyBadFor(req);
  if (bad) { L.draft = null; L.loadedText = null; L.bad = bad; return; }
  L.draft = Landing.newRecord(req); L.loadedText = null;
}
function lyIndex() {
  const key = A.asbuiltFull || A.asbuilt;
  if (!key) return null;
  if (lyIdxKey !== key || (lyIdx && lyIdx.facts !== A.facts)) { lyIdx = Landing.buildIndex(key, A.facts); lyIdx.facts = A.facts; lyIdxKey = key; }
  return lyIdx;
}
const lyOn = () => !!(A.layer.req && A.layer.draft && lyIndex());

// ---------------------------------------------------------------- the bar
function lyBar() {
  if (A.cmLevel === 'ui' || !A.asbuilt) return '';
  const L = A.layer, reqs = lyReqs();
  return `<label class="chk">Layer <select data-ly-layer aria-label="Layer"><option value="">None</option>${reqs.map(r => `<option value="${esc(r)}" ${r === L.req ? 'selected' : ''}>${esc(r)}</option>`).join('')}</select></label>`
    + (L.dirty ? ` <span class="tag warning" data-ly-unsaved title="Unsaved changes to ${esc(L.req)}">unsaved</span>` : '');
}
function lySetLayer(req) {
  const L = A.layer;
  if (L.dirty && !confirm(`Discard the unsaved changes to ${L.req}?`)) { return renderCodemap(); }
  lyOpen(req || null); A.cmSel = null; renderCodemap();
}

// ---------------------------------------------------------------- drawing hooks (called from codemapview)
// The view model with the layer's own boxes added, on a copy. Returns the input unchanged with no layer.
function lyPrepare(view) {
  lyCache = null;
  if (!lyOn() || A.cmLevel === 'ui') return view;
  const layer = Landing.layerFor(lyIndex(), A.layer.draft, A.cmLevel, view);
  const m = Landing.augment(view, layer);
  lyCache = { layer, view: m };
  return m;
}
function lyStyle(base) {
  return e => {
    const st = base(e);
    if (!lyCache) return st;
    const own = e.layerBox ? lyCache.layer.own.find(o => o.id === e.id) : null;
    const notes = own ? own.notes : lyCache.layer.boxes.get(e.id);
    if (!own && !notes) return st;
    const on = A.cmSel === e.id, txt = Landing.noteText(notes || []);
    if (own) return { ...st, stroke: 'var(--accent)', sw: on ? 3 : 2, dash: '5 3', note: `${own.notOnMap ? 'not on the map' : own.kind}${txt ? ' · ' + txt : ''}`, badge: null };
    return { ...st, stroke: 'var(--accent)', sw: on ? 3.2 : 2.6, note: [st.note, txt].filter(Boolean).join(' · ') };
  };
}
// Add what drawModel does not know: the layer edges between path steps, and the highlight and note on a highlighted group.
function lyDecorate(svg, L) {
  if (!lyCache) return svg;
  const lay = lyCache.layer;
  const rect = id => { const n = L.nodes.get(id); if (n) return n; const g = L.groups.find(x => x.el.id === id); return g || null; };
  for (const [id, notes] of lay.boxes) {
    const g = L.groups.find(x => x.el.id === id); if (!g) continue;
    const open = `<g data-cmg="${esc(id)}">`, i = svg.indexOf(open); if (i < 0) continue;
    const j = svg.indexOf('</g>', i);
    const note = `<text x="${g.x + g.w - 10}" y="${g.y + 20}" text-anchor="end" font-size="11" font-weight="700" fill="var(--accent)" data-ly-note="${esc(id)}">${esc(Landing.noteText(notes))}</text>`;
    svg = svg.slice(0, i) + svg.slice(i, j).replace('stroke="var(--ink3)" stroke-width="1.2"', 'stroke="var(--accent)" stroke-width="2.6"') + note + svg.slice(j);
  }
  const clipTo = (r, tx, ty) => {
    const cx = r.x + r.w / 2, cy = r.y + r.h / 2, dx = tx - cx, dy = ty - cy;
    if (!dx && !dy) return [cx, cy];
    const k = Math.min(dx ? (r.w / 2 + 4) / Math.abs(dx) : Infinity, dy ? (r.h / 2 + 4) / Math.abs(dy) : Infinity);
    return [cx + dx * k, cy + dy * k];
  };
  let h = `<defs><marker id="ly-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="${Landing.EDGE_STYLE.color}"/></marker></defs>`;
  for (const ed of lay.edges) {
    const a = rect(ed.from), b = rect(ed.to); if (!a || !b) continue;
    const ac = [a.x + a.w / 2, a.y + a.h / 2], bc = [b.x + b.w / 2, b.y + b.h / 2];
    const p1 = clipTo(a, bc[0], bc[1]), p2 = clipTo(b, ac[0], ac[1]), mx = (p1[0] + p2[0]) / 2, my = (p1[1] + p2[1]) / 2;
    h += `<g data-ly-edge="${ed.n}"><title>${esc(ed.label)}</title><line x1="${p1[0]}" y1="${p1[1]}" x2="${p2[0]}" y2="${p2[1]}" stroke="${Landing.EDGE_STYLE.color}" stroke-width="${Landing.EDGE_STYLE.width}" stroke-dasharray="${Landing.EDGE_STYLE.dash}" marker-end="url(#ly-arrow)"/>`
      + `<circle cx="${mx}" cy="${my}" r="9" fill="var(--accent)"/><text x="${mx}" y="${my + 4}" text-anchor="middle" font-size="11" font-weight="700" fill="var(--onaccent)">${ed.n}</text></g>`;
  }
  const at = svg.indexOf('<g class="node"');
  return at < 0 ? svg.replace(/<\/svg>$/, h + '</svg>') : svg.slice(0, at) + h + svg.slice(at);
}

// ---------------------------------------------------------------- the side panel
function lyTarget() {
  const L = A.layer, idx = lyIndex();
  if (L.typed.trim()) return { node: L.typed.trim(), how: 'typed' };
  if (L.pick && L.pickFor === A.cmSel) return { node: L.pick, how: 'row' };
  if (!A.cmSel) return null;
  const own = lyCache && lyCache.layer.own.find(o => o.id === A.cmSel);
  if (own) return { node: own.node, how: 'box' };
  const node = Landing.nodeOfBox(idx, A.cmSel);
  return node ? { node, how: 'box' } : null;
}
function lyResText(r) {
  if (r.status === 'new') return 'not on the map';
  if (r.status === 'ambiguous') return `ambiguous: ${r.candidates.length} matches, so it is not drawn. Pick a more specific node.`;
  return `on the map (${r.kind})`;
}
function lyRows(idx) {
  const sel = A.cmSel && (A.asbuiltFull || A.asbuilt).elements.get(A.cmSel);
  if (!sel || (sel.kind !== 'container' && sel.kind !== 'component')) return '';
  const eps = Landing.endpointsOf(idx, sel.kind === 'component' ? { component: sel.id } : { container: sel.id });
  if (!eps.length) return '';
  const row = (node, label, ev) => `<div class="evrow"><button class="lnk" data-a="ly-pick" data-node="${esc(node)}" ${A.layer.pick === node && A.layer.pickFor === A.cmSel ? 'aria-pressed="true"' : ''}>${esc(label)}</button>${ev ? ` <span class="lnk" data-code="${esc(ev.file)}" data-line="${ev.line}">${esc(ev.file)}:${ev.line}</span>` : ''}</div>`;
  return `<h4>Endpoints and handlers (${eps.length})</h4>` + eps.map(ep => row(ep.node, `${ep.method} ${ep.route}`, ep.evidence) + (ep.handler ? row(Landing.handlerNode(ep), `↳ handler${ep.handler.kind === 'inline' ? ' (inline)' : ''}`, ep.handler.file ? { file: ep.handler.file, line: ep.handler.line } : null) : '')).join('');
}
function lyLines(rec, ro) {
  const x = (kind, i) => ro ? '' : ` <button class="lnk" data-a="ly-del" data-kind="${kind}" data-i="${i}" aria-label="Remove this line">Remove</button>`;
  const e = rec.entry ? `<div class="evrow" data-ly-line="entry"><span class="tag">Entry</span> <b>${esc(rec.entry.node)}</b> <span class="desc">${esc(rec.entry.kind)}</span>${x('entry', 0)}</div>` : '';
  const p = (rec.path || []).map((s, i) => `<div class="evrow" data-ly-line="path"><span class="tag">${i + 1}</span> <span class="desc">${esc(s.stage)}</span> <b>${esc(s.node)}</b>${x('path', i)}</div>`).join('');
  const c = (rec.changes || []).map((s, i) => `<div class="evrow" data-ly-line="change"><span class="tag warning">Change</span> <b>${esc(s.node)}</b>: ${esc(s.what)}${x('change', i)}</div>`).join('');
  return e + (p ? `<h4>Path, in order</h4>${p}` : '') + (c ? `<h4>Changes</h4>${c}` : '') || '<p class="muted">Nothing drawn yet.</p>';
}
function lyPanel() {
  const L = A.layer, idx = lyIndex();
  const badList = A.landingErrors.length ? `<h4>Landings that cannot be read (${A.landingErrors.length})</h4>${A.landingErrors.map(b => `<div class="evrow" data-ly-bad="${esc(b.path)}"><b>${esc(b.path)}</b><div class="desc">${esc(b.errors.join(' '))}</div></div>`).join('')}<div class="muted">A file that cannot be read is skipped. It is not a gate finding.</div>` : '';
  if (!L.req) return badList ? `<div class="cm-layer" data-ly-panel><h3>Layer</h3>${badList}</div>` : '';
  if (L.bad) return `<div class="cm-layer" data-ly-panel><h3>Layer ${esc(L.req)}</h3><p style="color:var(--warn)">${esc(L.bad.path)} cannot be read, so it is not drawn and cannot be edited here: ${esc(L.bad.errors.join(' '))}</p>${badList}</div>`;
  const rec = L.draft; if (!rec || !idx) return '';
  const ro = !Landing.editable(rec);
  const head = `<h3>Layer ${esc(L.req)}${L.dirty ? ' <span class="tag warning" data-ly-unsaved>unsaved</span>' : ''}</h3><div class="muted" data-ly-status>${esc(Landing.statusText(rec))}${lyFind(L.req) ? '' : ' · not saved yet'}</div>`;
  if (ro) return `<div class="cm-layer" data-ly-panel>${head}<p>This landing was written by an agent. It is shown read-only; designc cannot edit it here.</p>${lyLines(rec, true)}${badList}</div>`;
  const tg = lyTarget(), r = tg ? Landing.resolve(idx, tg.node) : null;
  const stage = L.stage || (tg ? Landing.defaultStage(idx, tg.node, rec) : 'ui');
  const target = tg ? `<div data-ly-target><span class="muted">Target</span> <b>${esc(tg.node)}</b> <span class="desc">${esc(lyResText(r))}</span></div>` : '<div class="muted" data-ly-target>Select a box or a row below, or type a node.</div>';
  const can = tg && r.status !== 'ambiguous' ? '' : 'disabled';
  const draw = `<div style="display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin:6px 0">
      <button class="btn" data-a="ly-entry" ${can}>Entry</button>
      <button class="btn" data-a="ly-step" ${can}>Add to path</button>
      <label class="chk">as <select data-ly-stage aria-label="Stage">${Landing.STAGES.map(s => `<option ${s === stage ? 'selected' : ''}>${s}</option>`).join('')}</select></label></div>
    <div style="display:flex;gap:6px;align-items:center;margin:6px 0"><input data-ly-what type="text" placeholder="What changes here" aria-label="What changes here" value="${esc(L.what)}" style="flex:1"><button class="btn" data-a="ly-change" ${can}>Change here</button></div>
    <div style="margin:6px 0"><input data-ly-node type="text" placeholder="Or type a node, for example Shop.Api/CedantFilter" aria-label="Node" value="${esc(L.typed)}" style="width:100%"></div>`;
  const save = `<div style="display:flex;gap:6px;margin:10px 0"><button class="btn primary" data-a="ly-save" ${L.dirty ? '' : 'disabled'}>Save</button><button class="btn" data-a="ly-discard" ${L.dirty ? '' : 'disabled'}>Discard</button></div>`;
  return `<div class="cm-layer" data-ly-panel>${head}${target}${draw}${save}${lyLines(rec, false)}${lyRows(idx)}${badList}<hr></div>`;
}
// Called after the side panel is drawn: puts the layer panel above it.
function lyDecorateSide() {
  const side = $('#cmside'); if (!side || A.cmLevel === 'ui') return;
  const h = lyPanel(); if (h) side.insertAdjacentHTML('afterbegin', h);
}

// ---------------------------------------------------------------- editing
function lyEdit(fn) {
  const L = A.layer; if (!L.draft || !Landing.editable(L.draft)) return;
  const next = fn(L.draft, lyIndex()); if (next === L.draft) return;
  L.draft = next; L.dirty = true; L.typed = ''; L.what = ''; L.stage = ''; L.pick = null;
  renderCodemap();
}
async function lySave() {
  const L = A.layer; if (!L.draft || !L.dirty) return;
  const file = Landing.fileFor(L.draft.requirement);
  if (!file) return toast('The requirement id is not safe to use as a file name.', 'error');
  let cur = null; try { cur = (await host.exists(file)) ? await host.read(file) : null; } catch { cur = null; }
  const r = Landing.prepareSave({ draft: L.draft, loadedText: L.loadedText, currentText: cur, yaml: jsyaml });
  if (!r.ok) return toast(r.error, 'error');
  await host.write(r.path, r.text);
  L.dirty = false; L.loadedText = r.text; L.draft = JSON.parse(JSON.stringify(r.record));
  await loadLandings(); renderCodemap();
  toast(`Saved ${r.path}.`);
}
function lyDiscard() { const L = A.layer; if (L.req) lyOpen(L.req); renderCodemap(); }

document.addEventListener('click', e => {
  const t = e.target.closest && e.target.closest('[data-a^="ly-"]'); if (!t || t.disabled) return;
  const a = t.dataset.a, L = A.layer, idx = lyIndex();
  if (a === 'ly-pick') { L.pick = t.dataset.node; L.pickFor = A.cmSel; L.typed = ''; L.stage = ''; return renderCmSide(); }
  if (a === 'ly-save') return lySave();
  if (a === 'ly-discard') return lyDiscard();
  const tg = lyTarget(); if (!tg && !/ly-del/.test(a)) return;
  const stage = () => { const s = document.querySelector('[data-ly-stage]'); return s ? s.value : undefined; };
  if (a === 'ly-entry') return lyEdit(rec => Landing.setEntry(idx, rec, tg.node));
  if (a === 'ly-step') { const st = stage(); return lyEdit(rec => Landing.addStep(idx, rec, tg.node, st)); }
  if (a === 'ly-change') { const w = document.querySelector('[data-ly-what]'), what = w ? w.value : L.what; if (!String(what).trim()) { toast('Write what changes here first.', 'warning'); return; } return lyEdit(rec => Landing.addChange(rec, tg.node, what)); }
  if (a === 'ly-del') { const i = +t.dataset.i, k = t.dataset.kind; return lyEdit(rec => k === 'entry' ? Landing.clearEntry(rec) : k === 'path' ? Landing.removeStep(rec, i) : Landing.removeChange(rec, i)); }
});
document.addEventListener('change', e => {
  const t = e.target; if (!t || !t.matches) return;
  if (t.matches('[data-ly-layer]')) lySetLayer(t.value);
  else if (t.matches('[data-ly-stage]')) A.layer.stage = t.value;
});
document.addEventListener('input', e => {
  const t = e.target; if (!t || !t.matches) return;
  if (t.matches('[data-ly-node]')) { A.layer.typed = t.value; lyTypedRefresh(); }
  else if (t.matches('[data-ly-what]')) A.layer.what = t.value;
});
// Typing a node updates the target line and enables the buttons without redrawing the inputs (which would drop focus).
function lyTypedRefresh() {
  const idx = lyIndex(), tg = lyTarget(), rec = A.layer.draft; if (!idx || !rec) return;
  const r = tg ? Landing.resolve(idx, tg.node) : null;
  const el = document.querySelector('[data-ly-target]');
  if (el) el.innerHTML = tg ? `<span class="muted">Target</span> <b>${esc(tg.node)}</b> <span class="desc">${esc(lyResText(r))}</span>` : 'Select a box or a row below, or type a node.';
  const off = !(tg && r.status !== 'ambiguous');
  document.querySelectorAll('[data-a="ly-entry"], [data-a="ly-step"], [data-a="ly-change"]').forEach(b => { b.disabled = off; });
  const st = document.querySelector('[data-ly-stage]'); if (st && tg && !A.layer.stage) st.value = Landing.defaultStage(idx, tg.node, rec);
}
