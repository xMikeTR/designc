// ===== designc core: drift: designed vs as-built =====
// Part of Core, split out of core.js with no behaviour change. Dual-loaded like core.js: a classic script in the
// renderer (after core.js) and required by core.js under Node. It reads what it needs from Core and adds its functions to it.
(Core => {
  const { get, PP } = Core._shared;
  // ---------- drift: designed vs as-built ----------
  const key = s => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
  // An element a pipeline names: its elements.json id (System/Container/Component, as `m.label` and handoverElements write it) first, then a
  // name or d.aka that exactly one element carries. Null when unknown or ambiguous.
  function resolveElement(m, ref) {
    if (ref == null || ref === '') return null;
    const text = String(ref);
    const all = [...m.elements.values()];
    const path = e => { const parts = []; for (let c = e; c; c = c.parent ? m.elements.get(c.parent) : null) parts.unshift(c.name); return parts.join('/'); };
    const byId = all.filter(e => path(e) === text);
    if (byId.length === 1) return byId[0];
    const k = key(text);
    if (!k) return null;
    const named = all.filter(e => [e.name, ...(get(e, 'd.aka') || [])].some(n => key(n) === k));
    return named.length === 1 ? named[0] : null;
  }

  function drift(m, ledger) {
    const find = ref => { const e = resolveElement(m, ref); return e && e.kind !== 'person' ? e : null; };
    const built = ledger.filter(e => e.kind === 'asbuilt_edge');
    if (!built.length) return null;
    const unknownEls = new Set(), undeclared = [], seen = new Set(), mapped = new Set();
    const designed = new Set(m.rels.filter(r => m.elements.get(r.src).kind !== 'person').map(r => r.src + '>' + r.dst));
    for (const b of built) {
      const s = find(b.from), d = find(b.to);
      if (!s) unknownEls.add(b.from); if (!d) unknownEls.add(b.to);
      if (!s || !d) continue;
      mapped.add(s.id); mapped.add(d.id); seen.add(s.id + '>' + d.id);
      if (!designed.has(s.id + '>' + d.id)) undeclared.push({ from: s.name, to: d.name });
    }
    const unrealised = m.rels.filter(r => designed.has(r.src + '>' + r.dst) && mapped.has(r.src) && !seen.has(r.src + '>' + r.dst))
      .map(r => ({ from: m.elements.get(r.src).name, to: m.elements.get(r.dst).name }));
    return { undeclared, unrealised, unknownEls: [...unknownEls] };
  }

  // ---------- drift: designed model vs extracted as-built model ----------
  function driftModels(design, built) {
    const idx = new Map();
    for (const e of design.elements.values()) {
      if (e.kind === 'person') continue;
      [e.name, ...(get(e, 'd.aka') || [])].forEach(n => { if (!idx.has(key(n))) idx.set(key(n), e); });
    }
    const hasKids = m => new Set([...m.elements.values()].filter(e => e.parent).map(e => e.parent));
    const bKids = hasKids(built), dKids = hasKids(design);
    const toDesign = new Map(), unknownEls = [];
    for (const b of built.elements.values()) {
      if (bKids.has(b.id)) continue;
      const d = idx.get(key(b.name));
      if (d) toDesign.set(b.id, d); else unknownEls.push(b.name);
    }
    const toBuilt = new Map([...toDesign].map(([b, d]) => [d.id, b]));
    const designed = new Map(design.rels.filter(r => design.elements.get(r.src).kind !== 'person').map(r => [r.src + '>' + r.dst, r]));
    const relStatus = new Map(), undeclared = [], seen = new Set();
    for (const r of built.rels) {
      const s = toDesign.get(r.src), d = toDesign.get(r.dst);
      if (!s || !d) { relStatus.set(r.id, 'unmapped'); continue; }
      const k = s.id + '>' + d.id; seen.add(k);
      if (designed.has(k)) relStatus.set(r.id, 'matched');
      else { relStatus.set(r.id, 'undeclared'); undeclared.push({ from: s.name, to: d.name, builtRel: r.id }); }
    }
    const unrealised = [...designed.entries()].filter(([k, r]) => toBuilt.has(r.src) && !seen.has(k))
      .map(([, r]) => ({ from: design.elements.get(r.src).name, to: design.elements.get(r.dst).name, src: toBuilt.get(r.src), dst: toBuilt.get(r.dst), rel: r }));
    const missingEls = [...design.elements.values()].filter(e => e.kind !== 'person' && !dKids.has(e.id) && !toBuilt.has(e.id)).map(e => e.name);
    // An extracted single-page app whose design match is not tagged UI: the UI-facing rules (acceptance criteria) would skip it.
    const uiUntagged = [...toDesign].filter(([b, d]) => /\bSPA\b/.test(String(built.elements.get(b).technology || '')) && !d.tags.has('UI')).map(([, d]) => d.name);
    return { toDesign, toBuilt, relStatus, undeclared, unrealised, unknownEls, missingEls, uiUntagged };
  }

  // ---------- drift: designed vs extracted, one level down ----------
  // Components are only judged inside a container whose design declares components ("scored"). Everywhere
  // else they are neutral, so a container-only design never shows component warnings.
  // d.code against every file the extraction walk listed (facts.files, repo-relative). Display only: never a finding or a
  // gate clause, because the codebase is not a gate input. null when there is no file list (extracted before it).
  function codeAreaDrift(model, files) {
    if (!Array.isArray(files)) return null;
    const areas = [];
    for (const e of model.elements.values()) {
      if (e.props['d.code'] == null) continue;
      for (const s of String(e.props['d.code']).split(',')) {
        const p = PP.create(s);
        if (!p.ok) continue;
        const a = { id: e.id, name: e.name, pattern: p.value, matched: files.filter(f => PP.matches(p.value, f)).length };
        // An exact path matches one file of that name only (the path pattern contract); say so when it names a folder.
        const under = a.matched || /[*?]/.test(p.value) ? 0 : files.filter(f => f.startsWith(p.value + '/')).length;
        if (under) a.hint = `${p.value} is a folder with ${under} file${under === 1 ? '' : 's'}; an exact path matches a single file. Did you mean ${p.value}/**?`;
        areas.push(a);
      }
    }
    const unclaimed = areas.length ? files.filter(f => !areas.some(a => PP.matches(a.pattern, f))).sort() : [];
    return { areas, unclaimed, files: files.length };
  }

  function driftComponents(design, built) {
    const cmap = driftModels(Core.atLevel(design, 'container'), Core.atLevel(built, 'container'));
    const kids = (m, id) => [...m.elements.values()].filter(e => e.kind === 'component' && e.parent === id);
    const scored = new Set(), adoptable = [], neutral = new Set(), unknownEls = [], missingEls = [];
    const toDesign = new Map(cmap.toDesign);
    for (const c of built.elements.values()) {
      if (c.kind !== 'container') continue;
      const d = cmap.toDesign.get(c.id), bk = kids(built, c.id);
      if (!d) continue;
      const dk = kids(design, d.id);
      if (!dk.length) { if (bk.length) adoptable.push({ built: c.id, design: d.id }); for (const b of bk) neutral.add(b.id); continue; }
      scored.add(c.id);
      const idx = new Map();
      for (const x of dk) [x.name, ...(get(x, 'd.aka') || [])].forEach(n => { if (!idx.has(key(n))) idx.set(key(n), x); });
      for (const b of bk) { const x = idx.get(key(b.name)); if (x) toDesign.set(b.id, x); else unknownEls.push(b.name); }
      for (const x of dk) if (![...toDesign.values()].includes(x)) missingEls.push(x.name);
    }
    for (const c of built.elements.values()) if (c.kind === 'component' && !toDesign.has(c.parent)) neutral.add(c.id);
    const toBuilt = new Map([...toDesign].map(([b, d]) => [d.id, b]));
    const mapEnd = id => {
      const e = built.elements.get(id);
      if (e.kind !== 'component') return toDesign.get(id) || null;
      return scored.has(e.parent) ? toDesign.get(id) || null : toDesign.get(e.parent) || null;
    };
    const anc = (m, e) => { while (e && e.kind === 'component') e = m.elements.get(e.parent); return e; };
    const designed = new Set(design.rels.map(r => r.src + '>' + r.dst));
    const relStatus = new Map(), undeclared = [], seen = new Set();
    for (const r of built.rels) {
      const se = built.elements.get(r.src), de = built.elements.get(r.dst);
      if (se.kind !== 'component' && de.kind !== 'component') continue;
      const s = mapEnd(r.src), d = mapEnd(r.dst);
      if (!s || !d) { relStatus.set(r.id, 'unmapped'); continue; }
      const intra = se.kind === 'component' && de.kind === 'component' && se.parent === de.parent;
      if (s === d || (intra && !scored.has(se.parent))) { relStatus.set(r.id, 'neutral'); continue; }
      const direct = designed.has(s.id + '>' + d.id);
      const ok = intra ? direct : direct || designed.has(anc(design, s).id + '>' + anc(design, d).id);
      if (ok) { relStatus.set(r.id, 'matched'); seen.add(s.id + '>' + d.id); }
      else { relStatus.set(r.id, 'undeclared'); undeclared.push({ from: s.name, to: d.name, builtRel: r.id }); }
    }
    const unrealised = design.rels.filter(r => design.elements.get(r.src).kind === 'component' && design.elements.get(r.dst).kind === 'component'
        && toBuilt.has(r.src) && toBuilt.has(r.dst) && !seen.has(r.src + '>' + r.dst))
      .map(r => ({ from: design.elements.get(r.src).name, to: design.elements.get(r.dst).name, src: toBuilt.get(r.src), dst: toBuilt.get(r.dst), rel: r }));
    return { toDesign, toBuilt, relStatus, undeclared, unrealised, unknownEls, missingEls, neutral, scored, adoptable };
  }

  Object.assign(Core, { drift, driftModels, driftComponents, codeAreaDrift, resolveElement });
})(typeof module === 'object' && typeof require === 'function' ? require('./core.js') : Core);
