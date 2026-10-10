/* designc-canvas: layout.
   Positions live outside the DSL (model/layout.json in designc), keyed by identifier, so moving a box
   never touches the model. Unplaced elements get a layered left-to-right position. */
(function (root, factory) {
  const m = factory();
  if (typeof module === 'object' && module.exports) module.exports = m;
  else (root.DesigncCanvas = root.DesigncCanvas || {}).layout = m;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const W = 180, H = 70, GX = 120, GY = 56;
  const keyOf = el => el.ident || 'name:' + el.name;
  const empty = () => ({ version: 1, positions: {}, viewport: null });
  function leavesOf(m) { const kids = new Set([...m.elements.values()].filter(e => e.parent).map(e => e.parent)); return [...m.elements.values()].filter(e => !kids.has(e.id)); }
  function layered(m, leaves) {
    const set = new Set(leaves.map(e => e.id));
    const edges = m.rels.filter(r => set.has(r.src) && set.has(r.dst) && r.src !== r.dst);
    const layer = new Map(leaves.map(e => [e.id, 0])); const outs = new Map(leaves.map(e => [e.id, []]));
    edges.forEach(r => outs.get(r.src).push(r));
    const st = new Map(), back = new Set();
    const dfs = u => { st.set(u, 1); for (const r of outs.get(u)) { const s = st.get(r.dst); if (s === 1) back.add(r); else if (!s) dfs(r.dst); } st.set(u, 2); };
    const inc = new Set(edges.map(r => r.dst)); [...leaves.filter(e => !inc.has(e.id)), ...leaves].forEach(e => { if (!st.get(e.id)) dfs(e.id); });
    const dag = edges.filter(r => !back.has(r));
    for (let k = 0; k <= leaves.length; k++) { let ch = false; for (const r of dag) { const v = layer.get(r.src) + 1; if (layer.get(r.dst) < v) { layer.set(r.dst, v); ch = true; } } if (!ch) break; }
    const cols = new Map(); leaves.forEach(e => { const l = layer.get(e.id); if (!cols.has(l)) cols.set(l, []); cols.get(l).push(e); });
    const pos = new Map();
    for (const [l, list] of cols) list.sort((a, b) => (a.parent || '').localeCompare(b.parent || '')).forEach((e, j) => pos.set(e.id, { x: 60 + l * (W + GX), y: 80 + j * (H + GY) }));
    return pos;
  }
  // Positions for every leaf: saved ones first, then layered positions for the rest (shifted clear of saved ones).
  function resolve(m, layout, { tidy = false } = {}) {
    const leaves = leavesOf(m), saved = (layout && layout.positions) || {}, out = new Map();
    const auto = layered(m, leaves);
    const placed = leaves.filter(e => !tidy && saved[keyOf(e)]);
    placed.forEach(e => out.set(e.id, { ...saved[keyOf(e)] }));
    const maxY = placed.length ? Math.max(...placed.map(e => saved[keyOf(e)].y)) + H + GY * 2 : 0;
    for (const e of leaves) if (!out.has(e.id)) { const p = auto.get(e.id); out.set(e.id, { x: p.x, y: p.y + (placed.length ? maxY : 0) }); }
    return out;
  }
  // Saved positions plus the drawn position of every unsaved box, so moving one box cannot reflow the rest.
  function pin(m, layout, pos) {
    const out = { ...((layout && layout.positions) || {}) };
    for (const e of leavesOf(m)) { const k = keyOf(e), p = pos.get(e.id); if (!out[k] && p) out[k] = { x: Math.round(p.x), y: Math.round(p.y) }; }
    return out;
  }
  function boundaries(m, pos) {
    const res = [];
    const kids = [...m.elements.values()].filter(e => [...m.elements.values()].some(c => c.parent === e.id));
    const isUnder = (a, id) => { let c = m.elements.get(id); while (c && c.parent) { if (c.parent === a) return true; c = m.elements.get(c.parent); } return false; };
    for (const g of kids) {
      const mem = [...pos.keys()].filter(id => isUnder(g.id, id)).map(id => pos.get(id)); if (!mem.length) continue;
      const x0 = Math.min(...mem.map(p => p.x)) - 24, y0 = Math.min(...mem.map(p => p.y)) - 40, x1 = Math.max(...mem.map(p => p.x + W)) + 24, y1 = Math.max(...mem.map(p => p.y + H)) + 24;
      res.push({ el: g, x: x0, y: y0, w: x1 - x0, h: y1 - y0, depth: (function d(e) { return e.parent ? 1 + d(m.elements.get(e.parent)) : 0; })(g) });
    }
    return res.sort((a, b) => a.depth - b.depth);
  }
  // The view of one opened element: its direct children (their descendants folded in), the outside elements they
  // relate to or `show` lists (in `outside`, drawn faded) and rels lifted onto those ends. Each view rel keeps the real one as `orig`.
  function scoped(m, scopeId, { show = [] } = {}) {
    const sc = scopeId && m.elements.get(scopeId);
    if (!sc) return { ...m, rels: m.rels.map(r => ({ ...r, orig: r })), scope: null, outside: new Set() };
    const all = [...m.elements.values()], kids = all.filter(e => e.parent === sc.id);
    const childOf = id => { let c = m.elements.get(id); while (c && c.parent && c.parent !== sc.id) c = m.elements.get(c.parent); return c && c.parent === sc.id ? c.id : null; };
    const end = id => id === sc.id ? { drop: true } : childOf(id) ? { id: childOf(id), inside: true } : { id };
    const elements = new Map(), outside = new Set(), byPair = new Map();
    if (kids.length) elements.set(sc.id, { ...sc, parent: null });
    kids.forEach(e => elements.set(e.id, { ...e }));
    for (const r of m.rels) {
      const a = end(r.src), b = end(r.dst);
      if (a.drop || b.drop || (!a.inside && !b.inside) || a.id === b.id) continue;
      [a, b].filter(x => !x.inside).forEach(x => { outside.add(x.id); elements.set(x.id, { ...m.elements.get(x.id), parent: null }); });
      const k = a.id + '>' + b.id, lifted = a.id !== r.src || b.id !== r.dst;
      if (!byPair.has(k) || (byPair.get(k).lifted && !lifted)) byPair.set(k, { ...r, src: a.id, dst: b.id, orig: r, lifted });
    }
    for (const id of show) { const e = m.elements.get(id); if (e && id !== sc.id && !childOf(id) && !elements.has(id)) { outside.add(id); elements.set(id, { ...e, parent: null }); } }
    return { ...m, elements, rels: [...byPair.values()], scope: sc.id, outside };
  }
  return { W, H, keyOf, empty, leavesOf, resolve, pin, boundaries, scoped };
});
