/* designc-canvas: the drawing canvas.
   mount(el, host) renders the model from the DSL and turns drawing into DSL edits:
   drag a stencil to add, drag from a box's handle to connect, drag to move (layout only),
   edit in the inspector, Delete to remove, Ctrl+Z / Ctrl+Shift+Z to undo and redo.
   The host owns the text and the layout file; the canvas never keeps a second copy of the truth. */
(function (root, factory) {
  const m = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = m;
  else (root.DesigncCanvas = root.DesigncCanvas || {}).canvas = m;
})(typeof self !== 'undefined' ? self : this, function (root) {
  'use strict';
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const trunc = (s, n) => (String(s).length > n ? String(s).slice(0, n - 1) + '…' : String(s));
  const SEV = { error: 'var(--err,#b3392b)', warning: 'var(--warn,#9e6310)', note: 'var(--ink3,#7b8899)' };
  const KIND_LABEL = { person: 'Person', softwareSystem: 'Software System', container: 'Container', component: 'Component' };

  function mount(el, host) {
    const NS = root.DesigncCanvas;
    const V = NS.vocabulary, D = NS.dsl, L = NS.layout, T = NS.templates, R = NS.review, AR = NS.agenticRules;
    const Core = host.core;
    if (!Core || typeof Core.registerRules !== 'function') throw new Error('designc-canvas: pass host.core, the designc compiler (Core) with the registerProperties/registerRules hooks');
    if (!Core.__dcvRegistered) { Core.registerProperties(V.coreSpecs()); Core.registerRules(AR.makeRules(Core)); Core.__dcvRegistered = true; }
    const W = L.W, H = L.H;
    // scope: the opened system or container ({ident, name}, null for the whole model); view: what is drawn (L.scoped);
    // shown: elements added at model level while something is open, kept in view until it closes.
    const S = { text: '', model: null, view: null, scope: null, shown: [], diags: [], layout: L.empty(), pos: new Map(), bounds: [], sel: null, zoom: 1, pan: { x: 40, y: 30 },
      history: [], future: [], drag: null, review: false, cap: { ...R.CAP_DEFAULTS }, raf: 0, hover: null };
    const HINT = 'Drag a stencil in. Drag from a box\'s handle to connect. Double-click a system or container to open it. F2 renames.';

    el.classList.add('dcv');
    el.innerHTML = `
      <div class="dcv-palette" aria-label="Stencils">${paletteHTML()}</div>
      <div class="dcv-stage" tabindex="0" aria-label="Design canvas">
        <div class="dcv-toolbar"><span class="dcv-crumbs"></span>
          <button data-act="undo" title="Undo (Ctrl+Z)">Undo</button><button data-act="redo" title="Redo (Ctrl+Shift+Z)">Redo</button><span class="dcv-sep"></span>
          <button data-act="zoomout" title="Zoom out">−</button><span class="dcv-zoom"></span><button data-act="zoomin" title="Zoom in">+</button>
          <button data-act="fit" title="Fit to screen">Fit</button><button data-act="tidy" title="Lay everything out again">Tidy</button><span class="dcv-sep"></span>
          <button data-act="review" class="dcv-primary" title="Generate a design review">Design review</button>
        </div>
        <svg class="dcv-svg" xmlns="http://www.w3.org/2000/svg"><defs>${['n', 'error', 'warning', 'sel'].map(k => `<marker id="dcv-mk-${k}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="${k === 'sel' ? 'var(--accent,#2c5aa0)' : SEV[k] || 'var(--ink3,#7b8899)'}"/></marker>`).join('')}</defs><g class="dcv-world"></g></svg>
        <div class="dcv-hint">${HINT}</div>
        <input class="dcv-inline" hidden aria-label="Name">
      </div>
      <aside class="dcv-inspector" aria-label="Inspector"></aside>
      <div class="dcv-review" hidden></div>`;
    const $ = s => el.querySelector(s);
    const svg = $('.dcv-svg'), world = $('.dcv-world'), stage = $('.dcv-stage'), insp = $('.dcv-inspector'), inline = $('.dcv-inline');

    // ---------------------------------------------------------------- model sync
    function recompute() {
      S.model = Core.parse(S.text);
      S.diags = host.check ? host.check(S.model) : Core.check(S.model);
      const sc = scopeEl();
      if (!sc) { S.scope = null; S.shown = []; }
      S.view = L.scoped(S.model, sc && sc.id, { show: S.shown });
      S.pos = L.resolve(S.view, S.layout);
      S.bounds = L.boundaries(S.view, S.pos);
      if (S.sel && !selected()) S.sel = null;
    }
    const opens = e => !!e && ((e.kind === 'softwareSystem' && !e.tags.has('External')) || e.kind === 'container');
    function scopeEl() {
      if (!S.scope || !S.model) return null;
      const e = [...S.model.elements.values()].find(x => S.scope.ident ? x.ident === S.scope.ident : x.name === S.scope.name);
      return opens(e) ? e : null;
    }
    // Open a system or container (null for the whole model): only its children and what they connect to are drawn.
    function openScope(e) {
      commitInline(true);
      S.scope = e ? { ident: e.ident, name: e.name } : null; S.shown = []; S.sel = null;
      recompute(); fit();
      host.onScope && host.onScope(S.scope && { ...S.scope });
    }
    function up() { const sc = scopeEl(); if (sc) openScope(sc.parent ? S.model.elements.get(sc.parent) : null); }
    function commit(text, label) {
      if (text === S.text) return;
      S.history.push(S.text); if (S.history.length > 200) S.history.shift(); S.future = [];
      S.text = text; host.setText(text, { label });
      recompute(); render();
    }
    function edit(label, fn) { try { const r = fn(S.text); commit(r.text, label); return r; } catch (e) { flash(e.message); return null; } }
    let layoutTimer = 0;
    // layoutTimer is set while a save is pending; refresh() must not replace S.layout from the host until it has gone out.
    const saveLayout = () => { clearTimeout(layoutTimer); layoutTimer = setTimeout(() => { layoutTimer = 0; host.setLayout && host.setLayout(JSON.parse(JSON.stringify(S.layout))); }, 300); };
    const keyOfId = id => { const e = S.model.elements.get(id); return e ? L.keyOf(e) : null; };
    function setPos(id, x, y) { const k = keyOfId(id); if (!k) return; S.pos.set(id, { x, y }); S.layout.positions[k] = { x: Math.round(x), y: Math.round(y) }; }
    const pinAll = () => { S.layout.positions = L.pin(S.view, S.layout, S.pos); };

    // ---------------------------------------------------------------- selection helpers
    function selected() {
      if (!S.sel || !S.model) return null;
      if (S.sel.kind === 'element') return S.model.elements.get(S.sel.id) || [...S.model.elements.values()].find(e => e.ident === S.sel.ident) || null;
      return S.model.rels.find(r => r.src === S.sel.src && r.dst === S.sel.dst && (r.line === S.sel.line || S.sel.loose)) || null;
    }
    const relRef = r => ({ line: r.line, src: r.src, dst: r.dst });
    const selectEl = id => { const e = S.model.elements.get(id); S.sel = e ? { kind: 'element', id, ident: e.ident } : null; render(); host.onSelect && host.onSelect(S.sel && { ...S.sel, line: e.line }); };
    const selectRel = r => { S.sel = { kind: 'rel', ...relRef(r) }; render(); host.onSelect && host.onSelect({ ...S.sel }); };
    const involves = (d, id) => d.loc.kind === 'element' ? d.loc.id === id : (r => r && (r.src === id || r.dst === id))(S.model.relById.get(d.loc.id));

    // ---------------------------------------------------------------- rendering
    function toWorld(cx, cy) { const b = svg.getBoundingClientRect(); return { x: (cx - b.left - S.pan.x) / S.zoom, y: (cy - b.top - S.pan.y) / S.zoom }; }
    function toScreen(x, y) { const b = svg.getBoundingClientRect(), s = stage.getBoundingClientRect(); return { x: x * S.zoom + S.pan.x + b.left - s.left, y: y * S.zoom + S.pan.y + b.top - s.top }; }
    function clip(cx, cy, tx, ty, w, h) { const dx = tx - cx, dy = ty - cy; if (!dx && !dy) return [cx, cy]; const s = Math.min((w / 2) / Math.abs(dx || 1e-9), (h / 2) / Math.abs(dy || 1e-9)); return [cx + dx * s, cy + dy * s]; }
    function shapeSVG(shape, x, y, st) {
      const a = `fill="${st.fill}" stroke="${st.stroke}" stroke-width="${st.sw}"${st.dash ? ` stroke-dasharray="${st.dash}"` : ''}`;
      switch (shape) {
        case 'person': return `<rect x="${x}" y="${y}" width="${W}" height="${H}" rx="${H / 2}" ${a}/>`;
        case 'cylinder': case 'cylinder-dashed': {
          const d = shape === 'cylinder-dashed' ? ' stroke-dasharray="5 3"' : '';
          return `<path d="M${x} ${y + 9} V${y + H - 9} A${W / 2} 9 0 0 0 ${x + W} ${y + H - 9} V${y + 9}" ${a}${d}/><ellipse cx="${x + W / 2}" cy="${y + 9}" rx="${W / 2}" ry="9" ${a}${d}/>`;
        }
        case 'queue': return `<path d="M${x + 12} ${y} H${x + W - 12} A12 ${H / 2} 0 0 1 ${x + W - 12} ${y + H} H${x + 12} A12 ${H / 2} 0 0 1 ${x + 12} ${y} Z" ${a}/><ellipse cx="${x + W - 12}" cy="${y + H / 2}" rx="12" ry="${H / 2}" ${a}/>`;
        case 'hexagon': return `<polygon points="${x + 16},${y} ${x + W - 16},${y} ${x + W},${y + H / 2} ${x + W - 16},${y + H} ${x + 16},${y + H} ${x},${y + H / 2}" ${a}/>`;
        case 'llm': return `<rect x="${x}" y="${y}" width="${W}" height="${H}" rx="12" ${a}/><rect x="${x + 4}" y="${y + 4}" width="${W - 8}" height="${H - 8}" rx="9" fill="none" stroke="${st.stroke}" stroke-width="1"/>`;
        case 'gateway': return `<polygon points="${x},${y} ${x + W - 16},${y} ${x + W},${y + H / 2} ${x + W - 16},${y + H} ${x},${y + H} ${x + 16},${y + H / 2}" ${a}/>`;
        case 'tool': return `<path d="M${x} ${y + 12} H${x + 14} V${y} H${x + W} V${y + H} H${x} Z" ${a}/>`;
        case 'shield': return `<path d="M${x} ${y} H${x + W} V${y + H * 0.55} Q${x + W} ${y + H} ${x + W / 2} ${y + H} Q${x} ${y + H} ${x} ${y + H * 0.55} Z" ${a}/>`;
        case 'diamond': return `<polygon points="${x + W / 2},${y - 6} ${x + W + 10},${y + H / 2} ${x + W / 2},${y + H + 6} ${x - 10},${y + H / 2}" ${a}/>`;
        case 'browser': return `<rect x="${x}" y="${y}" width="${W}" height="${H}" rx="4" ${a}/><line x1="${x}" y1="${y + 13}" x2="${x + W}" y2="${y + 13}" stroke="${st.stroke}" stroke-width="1"/>${[0, 1, 2].map(i => `<circle cx="${x + 8 + i * 7}" cy="${y + 6.5}" r="2" fill="${st.stroke}"/>`).join('')}`;
        default: return `<rect x="${x}" y="${y}" width="${W}" height="${H}" rx="4" ${a}/>`;
      }
    }
    function render() {
      cancelAnimationFrame(S.raf);
      S.raf = requestAnimationFrame(() => { renderSVG(); renderInspector(); renderToolbar(); if (S.review) renderReview(); });
    }
    // Connection handles: one on each side of a box, as [side, x, y].
    function handlePoints(p, shape) {
      const o = 4, ox = shape === 'diamond' ? 14 : o;
      return [['top', p.x + W / 2, p.y - o], ['right', p.x + W + ox, p.y + H / 2], ['bottom', p.x + W / 2, p.y + H + o], ['left', p.x - ox, p.y + H / 2]];
    }
    // The box under a world point, by geometry, so nothing drawn on top (the ghost line, a label) can hide it.
    function nodeAt(w, exceptId) {
      const m = S.view, pad = 10; if (!m) return null;
      for (const e of L.leavesOf(m)) {
        const p = S.pos.get(e.id);
        if (p && e.id !== exceptId && w.x >= p.x - pad && w.x <= p.x + W + pad && w.y >= p.y - pad && w.y <= p.y + H + pad) return e.id;
      }
      return null;
    }
    function renderSVG() {
      const m = S.view; if (!m) return;
      const sel = selected(), elSev = new Map(), elN = new Map(), relSev = new Map();
      const bump = (map, id, sev) => { if (map.get(id) !== 'error') map.set(id, sev); };
      for (const f of S.diags) {
        if (f.suppressed || f.sev === 'note') continue;
        if (f.loc.kind === 'element') { bump(elSev, f.loc.id, f.sev); elN.set(f.loc.id, (elN.get(f.loc.id) || 0) + 1); }
        else { bump(relSev, f.loc.id, f.sev); }
      }
      let h = '';
      for (const b of S.bounds) {
        const on = S.sel && S.sel.kind === 'element' && S.sel.id === b.el.id;
        h += `<g class="dcv-boundary${on ? ' is-sel' : ''}" data-id="${esc(b.el.id)}"><rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="6"/><text x="${b.x + 12}" y="${b.y + 21}" class="dcv-blabel">${esc(b.el.name)} <tspan class="dcv-bkind">[${KIND_LABEL[b.el.kind]}]</tspan></text></g>`;
      }
      m.rels.forEach((r, i) => {
        const a = S.pos.get(r.src), b = S.pos.get(r.dst); if (!a || !b || r.src === r.dst) return;
        const ac = [a.x + W / 2, a.y + H / 2], bc = [b.x + W / 2, b.y + H / 2];
        const p1 = clip(ac[0], ac[1], bc[0], bc[1], W + 8, H + 8), p2 = clip(bc[0], bc[1], ac[0], ac[1], W + 14, H + 14);
        const isSel = sel && S.sel.kind === 'rel' && sel === r.orig, sev = relSev.get(r.id), async_ = Core.interaction(r) === 'async';
        const color = isSel ? 'var(--accent,#2c5aa0)' : sev ? SEV[sev] : 'var(--ink3,#7b8899)';
        const mx = (p1[0] + p2[0]) / 2, my = (p1[1] + p2[1]) / 2;
        h += `<g class="dcv-edge${m.outside.has(r.src) || m.outside.has(r.dst) ? ' is-outside' : ''}" data-rel="${i}"><line class="dcv-hit" x1="${p1[0]}" y1="${p1[1]}" x2="${p2[0]}" y2="${p2[1]}"/><line x1="${p1[0]}" y1="${p1[1]}" x2="${p2[0]}" y2="${p2[1]}" stroke="${color}" stroke-width="${isSel ? 2.6 : sev ? 1.9 : 1.4}"${async_ ? ' stroke-dasharray="6 4"' : ''} marker-end="url(#dcv-mk-${isSel ? 'sel' : sev || 'n'})"/>${r.description ? `<text x="${mx}" y="${my - 6}" class="dcv-elabel" style="fill:${sev ? color : ''}">${esc(trunc(r.description, 30))}</text>` : ''}</g>`;
      });
      for (const e of L.leavesOf(m)) {
        const p = S.pos.get(e.id); if (!p) continue;
        const shape = V.shapeFor(e), on = sel && S.sel.kind === 'element' && sel.id === e.id, sev = elSev.get(e.id), ext = e.tags.has('External');
        const st = { fill: ext ? 'var(--paper,#f3f6f8)' : 'var(--node,#fff)', stroke: on ? 'var(--accent,#2c5aa0)' : 'var(--ink,#15233a)', sw: on ? 2.6 : 1.5, dash: ext ? '5 3' : '' };
        const stencil = V.STENCILS.find(s => s.shape === shape && s.tags.every(t => e.tags.has(t)) && s.kind === e.kind) || V.STENCILS.find(s => s.shape === shape);
        const sub = `[${KIND_LABEL[e.kind]}${e.technology ? ': ' + e.technology : ''}]`;
        const ty = shape.startsWith('cylinder') ? p.y + 38 : p.y + 33;
        h += `<g class="dcv-node${on ? ' is-sel' : ''}${m.outside.has(e.id) ? ' is-outside' : ''}" data-id="${esc(e.id)}"><title>${esc(e.name)}</title>${shapeSVG(shape, p.x, p.y, st)}
          ${stencil ? `<text x="${p.x + 10}" y="${p.y + (shape.startsWith('cylinder') ? 30 : 18)}" class="dcv-glyph">${stencil.glyph}</text>` : ''}
          <text x="${p.x + W / 2}" y="${ty}" class="dcv-name">${esc(trunc(e.name, 22))}</text><text x="${p.x + W / 2}" y="${ty + 16}" class="dcv-sub">${esc(trunc(sub, 30))}</text>
          ${elN.get(e.id) ? `<circle cx="${p.x + W - 2}" cy="${p.y + 2}" r="11" fill="${SEV[sev]}"/><text x="${p.x + W - 2}" y="${p.y + 6}" class="dcv-badge">${elN.get(e.id)}</text>` : ''}
          ${handlePoints(p, shape).map(([side, hx, hy]) => `<circle class="dcv-handle" data-side="${side}" cx="${hx}" cy="${hy}" r="7"><title>Drag to connect</title></circle>`).join('')}</g>`;
      }
      if (S.drag && S.drag.type === 'connect') {
        const a = S.pos.get(S.drag.from); if (a) h += `<line class="dcv-ghost-edge" x1="${S.drag.x0}" y1="${S.drag.y0}" x2="${S.drag.cur.x}" y2="${S.drag.cur.y}" marker-end="url(#dcv-mk-sel)"/>`;
      }
      const sc = m.scope && S.model.elements.get(m.scope);
      if (sc && !L.leavesOf(m).length) h += `<text x="60" y="80" class="dcv-empty">${esc(sc.name)} is empty. Drop blocks here to add ${sc.kind === 'container' ? 'components' : 'containers'} to it.</text>`;
      else if (!m.elements.size) h += `<text x="60" y="80" class="dcv-empty">Drag a stencil from the left, or insert a reference architecture.</text>`;
      world.innerHTML = h;
      world.setAttribute('transform', `translate(${S.pan.x} ${S.pan.y}) scale(${S.zoom})`);
    }
    function renderToolbar() {
      const chain = []; for (let e = scopeEl(); e; e = e.parent ? S.model.elements.get(e.parent) : null) chain.unshift(e);
      $('.dcv-crumbs').innerHTML = chain.length ? [`<button data-crumb="" title="Show the whole model">All</button>`, ...chain.map((e, i) => i === chain.length - 1 ? `<b>${esc(e.name)}</b>` : `<button data-crumb="${esc(e.id)}">${esc(e.name)}</button>`)].join('<span class="dcv-csep">›</span>') + '<span class="dcv-sep"></span>' : '';
      $('.dcv-zoom').textContent = Math.round(S.zoom * 100) + '%';
      $('[data-act=undo]').disabled = !S.history.length; $('[data-act=redo]').disabled = !S.future.length;
    }
    function paletteHTML() {
      const groups = [...new Set(V.STENCILS.map(s => s.group))];
      return groups.map(g => `<div class="dcv-group"><div class="dcv-gtitle">${g}</div>${V.STENCILS.filter(s => s.group === g).map(s => `<button class="dcv-stencil" data-stencil="${s.id}" title="Drag onto the canvas, or click to place"><span class="dcv-sglyph">${s.glyph}</span>${esc(s.label)}</button>`).join('')}</div>`).join('') +
        `<div class="dcv-group"><div class="dcv-gtitle">Reference architectures</div>${T.TEMPLATES.map(t => `<button class="dcv-template" data-template="${t.id}" title="${esc(t.about)}"><b>${esc(t.title)}</b><span>${esc(t.pattern)}</span></button>`).join('')}</div>`;
    }

    // ---------------------------------------------------------------- inspector
    function field(label, name, value, placeholder = '') { return `<label class="dcv-field"><span>${label}</span><input data-field="${name}" value="${esc(value || '')}" placeholder="${esc(placeholder)}"></label>`; }
    function propControl(p, value) {
      const title = esc(`${p.doc}${p.source && p.source !== 'designc' ? ` Source: ${p.source}.` : ''}`);
      const ctl = p.kind === 'enum'
        ? `<select data-prop="${p.key}"><option value="">(undeclared)</option>${p.values.map(v => `<option${value === v ? ' selected' : ''}>${v}</option>`).join('')}</select>`
        : `<input data-prop="${p.key}" value="${esc(value ?? '')}" placeholder="${p.kind === 'float' ? 'e.g. 0.999' : p.kind === 'int' ? 'e.g. 3' : ''}">`;
      return `<label class="dcv-prop${value != null && value !== '' ? ' is-set' : ''}" title="${title}"><span>${esc(p.key.replace(/^d\./, ''))}${host.onAsk ? `<button class="dcv-ask" data-askprop="${esc(p.key)}" title="Ask the tutor what ${esc(p.key)} means">?</button>` : ''}</span>${ctl}</label>`;
    }
    // Questions for the tutor (host.onAsk). Each names what it is about so the answer can tie it to this model.
    function askProp(key) {
      const s = selected(), where = s ? (S.sel.kind === 'element' ? `"${s.name}"` : `the relationship ${S.model.elements.get(s.src).name} → ${S.model.elements.get(s.dst).name}`) : 'my design';
      return `What does the design property ${key} mean, why would I declare it, and what value would suit ${where}?`;
    }
    function askFinding(f) { return `Explain finding ${f.code} on ${f.loc.label}: "${f.msg}". Why does it matter, and what does a good answer look like?`; }
    function askSelection() {
      const s = selected(); if (!s) return 'Explain my design so far: what is good, and what should I learn next?';
      if (S.sel.kind !== 'element') return `Teach me about the relationship ${S.model.elements.get(s.src).name} → ${S.model.elements.get(s.dst).name} in my design: what the choice of interaction and technology means, and the trade-offs.`;
      return `Teach me about the ${KIND_LABEL[s.kind].toLowerCase()} "${s.name}" in my design: what it is for, what usually goes inside it, and the trade-offs to think about.`;
    }
    function findingsHTML(list) {
      if (!list.length) return '';
      return `<div class="dcv-findings">${list.map(f => `<div class="dcv-finding ${f.sev}" data-line="${f.loc.line || ''}"><b>${f.code}</b> ${esc(f.msg)}${f.hint ? `<div class="dcv-fhint">${esc(f.hint)}</div>` : ''}${host.onAsk ? `<button class="dcv-asklnk" data-askfinding="${S.diags.indexOf(f)}">Ask the tutor why</button>` : ''}</div>`).join('')}</div>`;
    }
    function propsHTML(target, node, isEl) {
      const props = V.inspectorProps(target, isEl ? node : null);
      const groups = ['Design', 'Quality', 'Agentic'];
      const known = new Set(props.map(p => p.key));
      const extra = Object.entries(node.props).filter(([k]) => !known.has(k));
      return groups.map(g => { const ps = props.filter(p => p.group === g); return ps.length ? `<details class="dcv-pgroup"${g === 'Agentic' && isEl && node.tags.has('Agent') ? ' open' : g === 'Design' ? ' open' : ''}><summary>${g} <span class="dcv-count">${ps.filter(p => node.props[p.key] != null).length}/${ps.length}</span></summary>${ps.map(p => propControl(p, node.props[p.key])).join('')}</details>` : ''; }).join('') +
        (extra.length ? `<details class="dcv-pgroup" open><summary>Other properties</summary>${extra.map(([k, v]) => `<div class="dcv-prop is-set"><span>${esc(k)}</span><code>${esc(v)}</code></div>`).join('')}</details>` : '');
    }
    function renderInspector() {
      const m = S.model; if (!m) return;
      const s = selected();
      if (!s) {
        const live = S.diags.filter(d => !d.suppressed && d.sev !== 'note');
        const agents = [...m.elements.values()].filter(e => e.tags.has('Agent'));
        const ag = live.filter(d => d.code.startsWith('AG'));
        insp.innerHTML = `<div class="dcv-ihead"><b>${esc(m.name)}</b></div>
          <p class="dcv-muted">${m.elements.size} elements, ${m.rels.length} relationships, ${agents.length} agents. ${live.filter(d => d.sev === 'error').length} errors, ${live.filter(d => d.sev === 'warning').length} warnings.</p>
          ${ag.length ? `<div class="dcv-sect">Agentic findings</div>${findingsHTML(ag.slice(0, 8))}` : agents.length ? '<p class="dcv-ok">No agentic findings.</p>' : ''}
          <div class="dcv-sect">How to draw</div>
          <p class="dcv-muted">Drag a stencil onto the canvas; containers dropped inside a system join it. Drag from the round handle on a box to another box to connect them. Double-click a system or container to open it and draw what is inside; Backspace or the breadcrumb goes back up. F2 or double-click on anything else renames, Delete removes, Ctrl+Z undoes. Everything you do is written to the DSL.</p>
          ${host.onAsk ? '<div class="dcv-actions"><button data-act="ask">Ask the tutor about my design</button></div>' : ''}`;
        return;
      }
      if (S.sel.kind === 'element') {
        const stencil = V.STENCILS.find(x => x.kind === s.kind && x.shape === V.shapeFor(s) && x.tags.every(t => s.tags.has(t))) || V.STENCILS.find(x => x.shape === V.shapeFor(s));
        const parent = s.parent ? m.elements.get(s.parent) : null;
        insp.innerHTML = `<div class="dcv-ihead"><span class="dcv-sglyph">${stencil ? stencil.glyph : '▭'}</span><b>${esc(KIND_LABEL[s.kind])}</b>${parent ? `<span class="dcv-muted"> in ${esc(parent.name)}</span>` : ''}</div>
          ${findingsHTML(S.diags.filter(d => !d.suppressed && involves(d, s.id)))}
          ${field('Name', 'name', s.name)}${field('Description', 'description', s.description)}${s.kind === 'container' || s.kind === 'component' ? field('Technology', 'technology', s.technology, 'e.g. .NET 8') : ''}
          <div class="dcv-field"><span>Tags</span><div class="dcv-tags">${[...s.tags].filter(t => t !== 'Element').map(t => `<span class="dcv-tag">${esc(t)}</span>`).join('')}<input data-addtag placeholder="Add tag"></div></div>
          ${propsHTML('element', s, true)}
          <div class="dcv-actions"><button data-act="reveal">Show in DSL</button>${host.onAsk ? '<button data-act="ask">Ask the tutor</button>' : ''}<button data-act="delete" class="dcv-danger">Delete</button></div>`;
      } else {
        insp.innerHTML = `<div class="dcv-ihead"><b>${esc(m.elements.get(s.src).name)} → ${esc(m.elements.get(s.dst).name)}</b></div>
          ${findingsHTML(S.diags.filter(d => !d.suppressed && d.loc.kind === 'relationship' && d.loc.id === s.id))}
          ${field('Description', 'description', s.description)}${field('Technology', 'technology', s.technology, 'e.g. HTTPS')}
          ${propsHTML('relationship', s, false)}
          <div class="dcv-actions"><button data-act="reveal">Show in DSL</button>${host.onAsk ? '<button data-act="ask">Ask the tutor</button>' : ''}<button data-act="delete" class="dcv-danger">Delete</button></div>`;
      }
    }
    function targetOfSel() {
      const s = selected(); if (!s) return null;
      return S.sel.kind === 'element' ? { kind: 'element', ref: s.ident || { line: s.line, name: s.name } } : { kind: 'relationship', ref: relRef(s) };
    }
    function reselectAfterEdit(prev) {   // relationships move lines as text changes; follow them by endpoints
      if (prev && prev.kind === 'rel') { const r = S.model.rels.find(x => x.src === prev.src && x.dst === prev.dst); if (r) S.sel = { kind: 'rel', ...relRef(r) }; }
    }
    insp.addEventListener('change', ev => {
      const t = ev.target, tgt = targetOfSel(); if (!tgt) return; const prev = S.sel;
      if (t.dataset.field) edit(`Set ${t.dataset.field}`, x => D.setField(x, tgt, t.dataset.field, t.value));
      else if (t.dataset.prop) edit(`Set ${t.dataset.prop}`, x => D.setProperty(x, tgt, t.dataset.prop, t.value.trim()));
      else if (t.dataset.addtag != null && t.value.trim()) edit('Add tag', x => D.addTag(x, tgt.ref, t.value.trim()));
      if (t.dataset.field === 'name' && S.sel && S.sel.kind === 'element') { const e = [...S.model.elements.values()].find(x => x.name === t.value); if (e) S.sel = { kind: 'element', id: e.id, ident: e.ident }; }
      reselectAfterEdit(prev); render();
    });
    insp.addEventListener('click', ev => {
      const t = ev.target.closest('button, .dcv-finding'); if (!t) return;
      if (t.dataset.act === 'delete') return removeSelection();
      if (t.dataset.askprop) { ev.preventDefault(); return host.onAsk(askProp(t.dataset.askprop)); }
      if (t.dataset.askfinding) { const f = S.diags[+t.dataset.askfinding]; return f && host.onAsk(askFinding(f)); }
      if (t.dataset.act === 'ask') return host.onAsk(askSelection());
      if (t.dataset.act === 'reveal') { const s = selected(); if (s && host.onReveal) host.onReveal(s.line); return; }
      if (t.classList.contains('dcv-finding') && t.dataset.line && host.onReveal) host.onReveal(+t.dataset.line);
    });

    // ---------------------------------------------------------------- actions
    function uniqueName(base) { const names = new Set([...S.model.elements.values()].map(e => e.name)); if (!names.has(base)) return base; let i = 2; while (names.has(`${base} ${i}`)) i++; return `${base} ${i}`; }
    function flash(msg) { const h = $('.dcv-hint'); h.textContent = msg; h.classList.add('is-err'); setTimeout(() => { h.classList.remove('is-err'); h.textContent = HINT; }, 3500); }
    function systemAt(x, y) {
      const inBox = (b, px, py) => px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h;
      const b = [...S.bounds].reverse().find(bb => bb.el.kind === 'softwareSystem' && !bb.el.tags.has('External') && inBox(bb, x, y));
      if (b) return b.el;
      const leaf = L.leavesOf(S.view).find(e => e.kind === 'softwareSystem' && !e.tags.has('External') && (p => p && inBox({ x: p.x, y: p.y, w: W, h: H }, x, y))(S.pos.get(e.id)));
      return leaf || null;
    }
    function dropStencil(id, x, y, name) {
      const st = V.STENCILS.find(s => s.id === id); if (!st) return;
      let text = S.text; let parent = null, kind = st.kind;
      if (!text.trim()) text = D.EMPTY;
      const sc = scopeEl(), inner = st.kind === 'container' || st.kind === 'component';
      if (sc && inner) {
        // Inside an opened element a block becomes its child: a container in a system, a component in a container.
        kind = sc.kind === 'container' ? 'component' : 'container';
        const r0 = D.ensureIdent(text, sc.ident || { line: sc.line, name: sc.name }); text = r0.text; parent = r0.ident; S.scope = { ident: r0.ident, name: sc.name };
      } else if (inner) {
        let sys = systemAt(x, y) || [...S.model.elements.values()].find(e => e.kind === 'softwareSystem' && !e.tags.has('External'));
        if (!sys) { const r0 = D.addElement(text, { kind: 'softwareSystem', name: uniqueName('New system') }); text = r0.text; parent = r0.ident; }
        else { const r0 = D.ensureIdent(text, sys.ident || { line: sys.line, name: sys.name }); text = r0.text; parent = r0.ident; }
      }
      const nm = name || uniqueName(st.label);
      const r = D.addElement(text, { kind, name: nm, technology: st.tech, tags: st.tags, parent, props: st.props });
      S.layout.positions[r.ident] = { x: Math.round(x - W / 2), y: Math.round(y - H / 2) };
      if (sc && !inner) S.shown.push(r.ident);
      saveLayout(); commit(r.text, `Add ${st.label}`);
      const e = [...S.model.elements.values()].find(x2 => x2.ident === r.ident);
      if (e) { S.sel = { kind: 'element', id: e.id, ident: e.ident }; render(); if (!name) setTimeout(() => startRename(e), 30); }
      return r.ident;
    }
    function connect(fromId, toId, description = 'Uses') {
      const a = S.model.elements.get(fromId), b = S.model.elements.get(toId); if (!a || !b || a === b) return null;
      const r = edit('Connect', x => D.addRelationship(x, { src: a.ident || { line: a.line, name: a.name }, dst: b.ident || { line: b.line, name: b.name }, description }));
      if (!r) return null;
      const rel = S.model.rels.find(x => x.src === r.src && x.dst === r.dst && x.line === r.line) || S.model.rels.filter(x => x.src === r.src && x.dst === r.dst).pop();
      if (rel) { S.sel = { kind: 'rel', ...relRef(rel) }; render(); }
      return rel;
    }
    function removeSelection() {
      const s = selected(); if (!s) return;
      if (S.sel.kind === 'element') {
        const kids = [...S.model.elements.values()].filter(e => e.parent === s.id).length;
        if (kids && !confirm(`Delete ${s.name} and the ${kids} element${kids === 1 ? '' : 's'} inside it?`)) return;
        const r = edit(`Delete ${s.name}`, x => D.deleteElement(x, s.ident || { line: s.line, name: s.name }));
        if (r && s.ident) { delete S.layout.positions[s.ident]; saveLayout(); }
      } else edit('Delete relationship', x => D.deleteRelationship(x, relRef(s)));
      S.sel = null; render();
    }
    function insertTemplate(id) {
      const t = T.TEMPLATES.find(x => x.id === id); if (!t) return;
      const base = S.text.trim() ? S.text : D.EMPTY;
      const r = edit(`Insert ${t.title}`, () => D.insertSnippet(base, t, id.split('-')[0]));
      if (r) setTimeout(fit, 30);
    }
    function startRename(e) {
      const p = S.pos.get(e.id); if (!p) return;
      const sc = toScreen(p.x, p.y + H / 2 - 14);
      Object.assign(inline.style, { left: sc.x + 'px', top: sc.y + 'px', width: W * S.zoom + 'px' });
      inline.hidden = false; inline.value = e.name; inline.dataset.target = 'element'; inline.dataset.id = e.id; inline.focus(); inline.select();
    }
    function startRelLabel(r) {
      const a = S.pos.get(r.src), b = S.pos.get(r.dst); if (!a || !b) return;
      const sc = toScreen((a.x + b.x + W) / 2 - 80, (a.y + b.y + H) / 2 - 14);
      Object.assign(inline.style, { left: sc.x + 'px', top: sc.y + 'px', width: '160px' });
      inline.hidden = false; inline.value = r.description || ''; inline.dataset.target = 'rel'; inline.focus(); inline.select();
    }
    function commitInline(save) {
      if (inline.hidden) return; inline.hidden = true;
      if (!save) return;
      const v = inline.value.trim(); if (!v) return;
      if (inline.dataset.target === 'element') {
        const e = S.model.elements.get(inline.dataset.id); if (!e || e.name === v) return;
        edit('Rename', x => D.setField(x, { kind: 'element', ref: e.ident || { line: e.line, name: e.name } }, 'name', v));
        const e2 = [...S.model.elements.values()].find(x => x.name === v); if (e2) S.sel = { kind: 'element', id: e2.id, ident: e2.ident };
      } else { const s = selected(); if (s && s.description !== v) { const prev = S.sel; edit('Describe', x => D.setField(x, { kind: 'relationship', ref: relRef(s) }, 'description', v)); reselectAfterEdit(prev); } }
      render(); stage.focus();
    }
    inline.addEventListener('keydown', ev => { if (ev.key === 'Enter') commitInline(true); if (ev.key === 'Escape') commitInline(false); ev.stopPropagation(); });
    inline.addEventListener('blur', () => commitInline(true));

    function fit() {
      const pts = [...S.pos.values()]; if (!pts.length) { S.zoom = 1; S.pan = { x: 40, y: 30 }; return render(); }
      const x0 = Math.min(...pts.map(p => p.x), ...S.bounds.map(b => b.x)) - 30, y0 = Math.min(...pts.map(p => p.y), ...S.bounds.map(b => b.y)) - 30;
      const x1 = Math.max(...pts.map(p => p.x + W), ...S.bounds.map(b => b.x + b.w)) + 40, y1 = Math.max(...pts.map(p => p.y + H), ...S.bounds.map(b => b.y + b.h)) + 30;
      const r = svg.getBoundingClientRect();
      S.zoom = Math.max(0.25, Math.min(1.4, Math.min(r.width / (x1 - x0), (r.height - 40) / (y1 - y0))));
      S.pan = { x: -x0 * S.zoom + (r.width - (x1 - x0) * S.zoom) / 2, y: -y0 * S.zoom + 40 };
      render();
    }
    function zoomAt(f, cx, cy) {
      const b = svg.getBoundingClientRect(); const px = cx ?? b.left + b.width / 2, py = cy ?? b.top + b.height / 2;
      const w = toWorld(px, py); S.zoom = Math.max(0.25, Math.min(2.5, S.zoom * f));
      S.pan = { x: px - b.left - w.x * S.zoom, y: py - b.top - w.y * S.zoom }; render();
    }
    function undo() { if (!S.history.length) return; S.future.push(S.text); S.text = S.history.pop(); host.setText(S.text, { label: 'Undo' }); recompute(); render(); }
    function redo() { if (!S.future.length) return; S.history.push(S.text); S.text = S.future.pop(); host.setText(S.text, { label: 'Redo' }); recompute(); render(); }

    // ---------------------------------------------------------------- review panel
    const REV_FIELDS = [['dailyActiveUsers', 'Daily active users'], ['requestsPerUserPerDay', 'Requests per user per day'], ['peakFactor', 'Peak factor'], ['payloadKB', 'Payload (KB)'],
      ['writeRatio', 'Write ratio (0-1)'], ['retentionDays', 'Retention (days)'], ['replicas', 'Replicas'], ['agentRunsPerDay', 'Agent runs per day'], ['tokensPerRun', 'Tokens per run'],
      ['expectedAttempts', 'Expected attempts'], ['outputShare', 'Output token share (0-1)'], ['pricePerMTokIn', '$ per M input tokens'], ['pricePerMTokOut', '$ per M output tokens']];
    function mdToHTML(md) {
      const lines = md.split('\n'); let h = '', i = 0;
      const inline_ = s => esc(s).replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
      while (i < lines.length) {
        const l = lines[i];
        if (/^#{1,3} /.test(l)) { const n = l.match(/^#+/)[0].length; h += `<h${n + 1}>${inline_(l.replace(/^#+ /, ''))}</h${n + 1}>`; i++; continue; }
        if (l.startsWith('|')) {
          const rows = []; while (i < lines.length && lines[i].startsWith('|')) { rows.push(lines[i].split(/(?<!\\)\|/).slice(1, -1).map(c => c.trim().replace(/\\\|/g, '|'))); i++; }
          h += `<table><thead><tr>${rows[0].map(c => `<th>${inline_(c)}</th>`).join('')}</tr></thead><tbody>${rows.slice(2).map(r => `<tr>${r.map(c => `<td class="${/^(risk|gap)/.test(c) ? 'bad' : /^(open)/.test(c) ? 'open' : /^ok/.test(c) ? 'ok' : ''}">${inline_(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`; continue;
        }
        if (/^(\d+\.|-) /.test(l)) { const items = []; while (i < lines.length && /^(\d+\.|-) /.test(lines[i])) { items.push(lines[i].replace(/^(\d+\.|-) /, '')); i++; } h += `<ul>${items.map(x => `<li>${inline_(x)}</li>`).join('')}</ul>`; continue; }
        if (l.trim()) h += `<p>${inline_(l)}</p>`;
        i++;
      }
      return h;
    }
    let lastReview = null;
    function renderReview() {
      const box = $('.dcv-review'); box.hidden = !S.review; if (!S.review) return;
      lastReview = R.generate(Core, S.model, S.diags, { capacity: S.cap, title: S.model.name });
      if (!box.dataset.built) {
        box.innerHTML = `<div class="dcv-rhead"><b>Design review</b><span class="dcv-muted">Generated from the model and its findings. Edit the model, not this.</span><span class="dcv-spacer"></span>
          <button data-ract="copy">Copy Markdown</button>${host.saveReview ? '<button data-ract="save" class="dcv-primary">Save to registry</button>' : ''}<button data-ract="close">Close</button></div>
          <div class="dcv-rbody"><form class="dcv-cap"><div class="dcv-sect">Capacity and agent cost inputs</div>${REV_FIELDS.map(([k, lbl]) => `<label class="dcv-field"><span>${lbl}</span><input type="number" step="any" data-cap="${k}" value="${S.cap[k]}"></label>`).join('')}</form><div class="dcv-rdoc"></div></div>`;
        box.dataset.built = '1';
      }
      box.querySelector('.dcv-rdoc').innerHTML = mdToHTML(lastReview.markdown);
    }
    $('.dcv-review').addEventListener('input', ev => { const k = ev.target.dataset.cap; if (!k) return; const v = parseFloat(ev.target.value); if (!isNaN(v)) { S.cap[k] = v; renderReview(); } });
    $('.dcv-review').addEventListener('click', async ev => {
      const a = ev.target.closest('[data-ract]'); if (!a) return;
      if (a.dataset.ract === 'close') { S.review = false; renderReview(); stage.focus(); }
      if (a.dataset.ract === 'copy') { try { await navigator.clipboard.writeText(lastReview.markdown); a.textContent = 'Copied'; } catch { a.textContent = 'Copy failed'; } setTimeout(() => (a.textContent = 'Copy Markdown'), 1500); }
      if (a.dataset.ract === 'save' && host.saveReview) { await host.saveReview(lastReview.markdown, lastReview); a.textContent = 'Saved'; setTimeout(() => (a.textContent = 'Save to registry'), 1500); }
    });

    // ---------------------------------------------------------------- pointer and keyboard
    $('.dcv-toolbar').addEventListener('click', ev => {
      const c = ev.target.closest('[data-crumb]'); if (c) return openScope(c.dataset.crumb ? S.model.elements.get(c.dataset.crumb) : null);
      const a = ev.target.closest('[data-act]'); if (!a) return;
      ({ undo, redo, fit, zoomin: () => zoomAt(1.2), zoomout: () => zoomAt(1 / 1.2),
        tidy: () => { S.pos = L.resolve(S.view, S.layout, { tidy: true }); for (const [id, p] of S.pos) setPos(id, p.x, p.y); S.bounds = L.boundaries(S.view, S.pos); saveLayout(); fit(); },
        review: () => { S.review = true; renderReview(); } })[a.dataset.act]();
    });
    // palette: drag a stencil (or click to place in the middle of the view)
    $('.dcv-palette').addEventListener('pointerdown', ev => {
      const b = ev.target.closest('.dcv-stencil'); if (!b) return; ev.preventDefault();
      const ghost = document.createElement('div'); ghost.className = 'dcv-dragghost'; ghost.textContent = b.textContent; document.body.appendChild(ghost);
      const move = e => { ghost.style.left = e.clientX + 8 + 'px'; ghost.style.top = e.clientY + 8 + 'px'; }; move(ev);
      const up = e => {
        window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); ghost.remove();
        const r = svg.getBoundingClientRect(); const moved = Math.hypot(e.clientX - ev.clientX, e.clientY - ev.clientY) > 6;
        if (!moved) { const w = toWorld(r.left + r.width / 2, r.top + r.height / 2); return dropStencil(b.dataset.stencil, w.x + (Math.random() * 40 - 20), w.y + (Math.random() * 40 - 20)); }
        if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) { const w = toWorld(e.clientX, e.clientY); dropStencil(b.dataset.stencil, w.x, w.y); }
      };
      window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
    });
    $('.dcv-palette').addEventListener('click', ev => { const t = ev.target.closest('.dcv-template'); if (t) insertTemplate(t.dataset.template); });
    svg.addEventListener('pointerdown', ev => {
      if (ev.button !== 0) return; stage.focus(); commitInline(true);
      const w = toWorld(ev.clientX, ev.clientY);
      const handle = ev.target.closest('.dcv-handle'), node = ev.target.closest('.dcv-node'), edge = ev.target.closest('.dcv-edge'), bound = ev.target.closest('.dcv-boundary');
      if (handle && node) {
        const hx = +handle.getAttribute('cx'), hy = +handle.getAttribute('cy');
        S.drag = { type: 'connect', from: node.dataset.id, cur: w, x0: hx, y0: hy };
      }
      else if (node) { const id = node.dataset.id, p = S.pos.get(id); S.drag = { type: 'node', id, dx: w.x - p.x, dy: w.y - p.y, moved: false, sx: ev.clientX, sy: ev.clientY }; }
      else if (edge) { const r = viewRel(edge); if (r) selectRel(r); return; }
      else if (bound) {
        const id = bound.dataset.id; const under = [...S.pos.keys()].filter(k => { let c = S.view.elements.get(k); while (c && c.parent) { if (c.parent === id) return true; c = S.view.elements.get(c.parent); } return false; });
        S.drag = { type: 'group', id, start: w, orig: new Map(under.map(k => [k, { ...S.pos.get(k) }])), moved: false, sx: ev.clientX, sy: ev.clientY };
      } else { S.drag = { type: 'pan', sx: ev.clientX, sy: ev.clientY, pan: { ...S.pan }, moved: false }; }
      try { svg.setPointerCapture(ev.pointerId); } catch { /* synthetic pointers */ }
    });
    svg.addEventListener('pointermove', ev => {
      const d = S.drag; if (!d) return;
      const w = toWorld(ev.clientX, ev.clientY);
      if (d.type === 'connect') { d.cur = w; renderSVG(); return; }
      if (d.type === 'pan') { if (Math.hypot(ev.clientX - d.sx, ev.clientY - d.sy) > 3) d.moved = true; S.pan = { x: d.pan.x + ev.clientX - d.sx, y: d.pan.y + ev.clientY - d.sy }; renderSVG(); return; }
      if (d.type === 'node') { if (!d.moved && Math.hypot(ev.clientX - d.sx, ev.clientY - d.sy) < 4) return; if (!d.moved) pinAll(); d.moved = true; setPos(d.id, w.x - d.dx, w.y - d.dy); S.bounds = L.boundaries(S.view, S.pos); renderSVG(); return; }
      if (d.type === 'group') { if (!d.moved && Math.hypot(ev.clientX - d.sx, ev.clientY - d.sy) < 4) return; if (!d.moved) pinAll(); d.moved = true; for (const [k, p] of d.orig) setPos(k, p.x + w.x - d.start.x, p.y + w.y - d.start.y); S.bounds = L.boundaries(S.view, S.pos); renderSVG(); }
    });
    svg.addEventListener('pointerup', ev => {
      const d = S.drag; S.drag = null; if (!d) return;
      if (d.type === 'connect') {
        const to = nodeAt(toWorld(ev.clientX, ev.clientY), d.from);
        if (to) { const rel = connect(d.from, to); if (rel) setTimeout(() => startRelLabel(rel), 30); } else renderSVG();
        return;
      }
      if (d.moved) { if (d.type !== 'pan') saveLayout(); return; }
      if (secondTap(d.type === 'pan' ? '' : d.id)) return d.type === 'node' ? activateNode(d.id) : d.type === 'group' ? activateBoundary(d.id) : up();
      if (d.type === 'node' || d.type === 'group') selectEl(d.id);
      else { S.sel = null; render(); }
    });
    const viewRel = g => { const r = S.view.rels[+g.dataset.rel]; return r && r.orig; };
    // Double-clicks on boxes, boundaries and empty canvas are told from two quick clicks on the same target, not from the
    // browser's dblclick: the first click selects and redraws, which replaces the element the dblclick would land on.
    let lastTap = null;
    function secondTap(target) {
      const now = Date.now(), hit = lastTap && lastTap.target === target && now - lastTap.t < 450;
      lastTap = hit ? null : { target, t: now }; return hit;
    }
    function activateNode(id) { const e = S.model.elements.get(id); if (opens(e)) openScope(e); else if (e) startRename(e); }
    function activateBoundary(id) { const e = S.model.elements.get(id); if (opens(e) && e.id !== S.view.scope) openScope(e); }
    svg.addEventListener('dblclick', ev => {
      const edge = ev.target.closest('.dcv-edge');
      if (edge) { const r = viewRel(edge); if (r) { selectRel(r); setTimeout(() => startRelLabel(r), 30); } }
    });
    svg.addEventListener('wheel', ev => {
      ev.preventDefault();
      if (ev.ctrlKey || ev.metaKey) zoomAt(ev.deltaY < 0 ? 1.1 : 1 / 1.1, ev.clientX, ev.clientY);
      else { S.pan = { x: S.pan.x - ev.deltaX, y: S.pan.y - ev.deltaY }; renderSVG(); }
    }, { passive: false });
    stage.addEventListener('keydown', ev => {
      if (ev.target !== stage) return;
      const mod = ev.ctrlKey || ev.metaKey;
      if (mod && ev.key.toLowerCase() === 'z') { ev.preventDefault(); return ev.shiftKey ? redo() : undo(); }
      if (mod && ev.key.toLowerCase() === 'y') { ev.preventDefault(); return redo(); }
      if (ev.key === 'Backspace' && !S.sel && S.scope) { ev.preventDefault(); return up(); }
      if (ev.key === 'Delete' || ev.key === 'Backspace') { ev.preventDefault(); return removeSelection(); }
      if (ev.key === 'Escape') { S.sel = null; S.drag = null; return render(); }
      if (ev.key === 'F2') { const s = selected(); if (s && S.sel.kind === 'element') startRename(s); else if (s) startRelLabel(s); return; }
      const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[ev.key];
      if (arrows && S.sel && S.sel.kind === 'element') { ev.preventDefault(); const s = selected(), step = ev.shiftKey ? 40 : 10; const p = S.pos.get(s.id); if (p) { pinAll(); setPos(s.id, p.x + arrows[0] * step, p.y + arrows[1] * step); S.bounds = L.boundaries(S.view, S.pos); saveLayout(); renderSVG(); } }
    });
    new ResizeObserver(() => renderSVG()).observe(svg);

    // ---------------------------------------------------------------- public API
    function refresh() {
      const t = host.getText(); const lay = host.getLayout ? host.getLayout() : null;
      if (lay && !layoutTimer && JSON.stringify(lay.positions) !== JSON.stringify(S.layout.positions) && !S.drag) S.layout = { ...L.empty(), ...lay, positions: { ...(lay.positions || {}) } };
      if (t === S.text && S.model) { recompute(); return render(); }
      S.text = t; recompute(); render();
    }
    S.text = host.getText() || ''; const lay0 = host.getLayout && host.getLayout(); if (lay0) S.layout = { ...L.empty(), ...lay0, positions: { ...(lay0.positions || {}) } };
    recompute(); render(); setTimeout(fit, 50);
    return {
      refresh, fit, undo, redo,
      select: (ref) => { const e = typeof ref === 'string' ? [...S.model.elements.values()].find(x => x.ident === ref || x.name === ref) : null; if (e) selectEl(e.id); },
      addStencil: (id, x, y, name) => dropStencil(id, x, y, name),
      connect: (a, b, desc) => { const f = n => [...S.model.elements.values()].find(e => e.ident === n || e.name === n); const A = f(a), B = f(b); return A && B ? connect(A.id, B.id, desc) : null; },
      open: (ref) => { const e = ref == null ? null : [...S.model.elements.values()].find(x => x.ident === ref || x.name === ref); if (ref == null || opens(e)) openScope(e); },
      scope: () => S.scope && { ...S.scope },
      insertTemplate, openReview: () => { S.review = true; renderReview(); },
      review: () => R.generate(Core, S.model, S.diags, { capacity: S.cap }),
      state: () => ({ text: S.text, layout: JSON.parse(JSON.stringify(S.layout)), selection: S.sel, diagnostics: S.diags }),
      destroy: () => { el.innerHTML = ''; el.classList.remove('dcv'); },
    };
  }
  return { mount };
});
