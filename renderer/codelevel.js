/* designc desktop: the Code level (C4 level 4) of the Code map. Pure, no I/O. Dual-loaded like renderer/policy.js.
   Turns facts.code (types and type edges from extract/code.js) into the model shape the shared layout and drawModel
   already draw, and lists a type's methods. Nothing here judges metrics; renderer/quality.js does. */
const CodeLevel = (() => {
  const LABEL = { class: 'Class', record: 'Record', struct: 'Struct', interface: 'Interface', enum: 'Enum', module: 'Module' };
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

  // The types of one component, plus the types of other components they refer to or that refer to them.
  function model(code, componentId) {
    const types = (code && code.types) || [], edges = (code && code.typeEdges) || [];
    const mine = new Set(types.filter(t => t.component === componentId).map(t => t.id));
    const keep = new Set(mine);
    for (const e of edges) { if (mine.has(e.from)) keep.add(e.to); if (mine.has(e.to)) keep.add(e.from); }
    const elements = new Map();
    for (const t of types) {
      if (!keep.has(t.id)) continue;
      elements.set(t.id, { id: t.id, kind: 'component', kindLabel: LABEL[t.kind] || 'Type', name: t.name, technology: plural(t.methods.length, 'method'),
        parent: null, tags: new Set(), props: {}, outside: !mine.has(t.id), component: t.component });
    }
    const rels = edges.filter(e => elements.has(e.from) && elements.has(e.to) && e.from !== e.to)
      .map((e, i) => ({ id: `tr${i}`, src: e.from, dst: e.to, description: e.via, technology: '', props: {}, evidence: e.evidence }));
    return { elements, rels, relById: new Map(rels.map(r => [r.id, r])), isAncestor: () => false, errors: [] };
  }

  const methodsOf = (code, typeId) => { const t = ((code && code.types) || []).find(x => x.id === typeId); return t ? t.methods.slice() : []; };

  return { model, methodsOf, LABEL };
})();
if (typeof module !== 'undefined') module.exports = CodeLevel;
