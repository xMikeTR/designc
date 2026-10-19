// ===== designc core: levels and code-area editing =====
// Part of Core, split out of core.js with no behaviour change. Dual-loaded like core.js: a classic script in the
// renderer (after core.js) and required by core.js under Node. It reads what it needs from Core and adds its functions to it.
(Core => {
  const { parse } = Core;
  const { makeModel } = Core._shared;
  // ---------- levels ----------
  const KIND_RANK = { person: 0, softwareSystem: 1, container: 2, component: 3 };
  const LEVEL_RANK = { context: 1, container: 2, component: 3 };

  // Projects a model to a C4 level: elements deeper than `level` fold into their nearest surviving
  // ancestor, relationships are lifted to the survivors, self-loops dropped, duplicates merged
  // (an explicit relationship beats a lifted one for the same src/dst/description).
  function atLevel(model, level) {
    const max = LEVEL_RANK[level];
    if (max == null) throw new Error(`unknown level "${level}"`);
    const els = model.elements;
    const survives = e => e.kind === 'person' || KIND_RANK[e.kind] <= max;
    const memo = new Map();
    const resolve = id => {
      if (memo.has(id)) return memo.get(id);
      const e = els.get(id); let out = id;
      if (e && !survives(e)) out = e.parent ? resolve(e.parent) : id;
      memo.set(id, out); return out;
    };
    const kept = new Map([...els].filter(([, e]) => survives(e)));
    const lifted = [], rels = [];
    for (const r of model.rels) {
      const src = resolve(r.src), dst = resolve(r.dst);
      if (src === dst) continue;
      if (src === r.src && dst === r.dst) rels.push(r); else lifted.push({ ...r, src, dst });
    }
    const pair = r => `${r.src}\u0000${r.dst}`;
    const explicit = new Set(rels.map(pair));
    const seen = new Set();
    for (const r of lifted) {
      const k = `${pair(r)}\u0000${r.description}`;
      if (explicit.has(pair(r)) || seen.has(k)) continue;
      seen.add(k); rels.push(r);
    }
    return makeModel(model.name, kept, rels, model.errors);
  }

  // Projects a model for the Code map: context and container are atLevel; component keeps the
  // component detail. Scoped to a container id, everything outside that container's subtree folds
  // to its container-level ancestor and only the subtree, its direct neighbours and their
  // ancestors stay, with just the rels that touch the subtree. A scope that isn't a container id
  // behaves as no scope. Container rollups whose component rels are visible are then dropped.
  function view(model, { level, scope } = {}) {
    if (level === 'context' || level === 'container') return atLevel(model, level);
    if (level !== 'component') throw new Error(`unknown level "${level}"`);
    const els = model.elements;
    const focus = scope && els.has(scope) && els.get(scope).kind === 'container' ? scope : null;
    let m = model;
    if (focus) {
      const inSub = id => id === focus || model.isAncestor(focus, id);
      const resolve = id => {
        if (inSub(id)) return id;
        let e = els.get(id);
        while (e && KIND_RANK[e.kind] > KIND_RANK.container && e.parent) e = els.get(e.parent);
        return e ? e.id : id;
      };
      const explicit = [], lifted = [];
      for (const r of model.rels) {
        const src = resolve(r.src), dst = resolve(r.dst);
        if (src === dst || !(inSub(src) || inSub(dst))) continue;
        if (src === r.src && dst === r.dst) explicit.push(r); else lifted.push({ ...r, src, dst });
      }
      const pair = r => `${r.src}\u0000${r.dst}`;
      const have = new Set(explicit.map(pair)), seen = new Set(), rels = [...explicit];
      for (const r of lifted) {
        const k = `${pair(r)}\u0000${r.description}`;
        if (have.has(pair(r)) || seen.has(k)) continue;
        seen.add(k); rels.push(r);
      }
      const keep = new Set([...els.keys()].filter(inSub));
      for (const r of rels) { keep.add(r.src); keep.add(r.dst); }
      for (const id of [...keep]) for (let e = els.get(id); e && e.parent; e = els.get(e.parent)) keep.add(e.parent);
      m = makeModel(model.name, new Map([...els].filter(([id]) => keep.has(id))), rels, model.errors);
    }
    // a rel is covered when an endpoint has children and another rel links a descendant-or-self of
    // its src to a descendant-or-self of its dst with at least one end strictly deeper
    const kids = new Set([...m.elements.values()].filter(e => e.parent).map(e => e.parent));
    const within = (top, id) => id === top || m.isAncestor(top, id);
    const covered = r => (kids.has(r.src) || kids.has(r.dst)) &&
      m.rels.some(o => o !== r && within(r.src, o.src) && within(r.dst, o.dst) && (o.src !== r.src || o.dst !== r.dst));
    return makeModel(m.name, m.elements, m.rels.filter(r => !covered(r)), m.errors);
  }

  // Removes component declarations and any relationship touching a component from raw DSL text,
  // leaving every other line byte-identical.
  function containerLevelText(dslText) {
    const m = parse(dslText);
    const comps = new Set([...m.elements.values()].filter(e => e.kind === 'component').map(e => e.id));
    const lines = dslText.split('\n');
    const drop = new Set();
    for (const e of m.elements.values()) if (comps.has(e.id)) drop.add(e.line);
    for (const r of m.rels) {
      if (!comps.has(r.src) && !comps.has(r.dst)) continue;
      let depth = 0, i = r.line - 1;
      do {
        let inStr = false; const t = lines[i] || '';
        for (let j = 0; j < t.length; j++) {
          const c = t[j];
          if (inStr) { if (c === '\\') j++; else if (c === '"') inStr = false; }
          else if (c === '"') inStr = true;
          else if (c === '{') depth++;
          else if (c === '}') depth--;
        }
        drop.add(i + 1); i++;
      } while (depth > 0 && i < lines.length);
    }
    return lines.filter((_, i) => !drop.has(i + 1)).join('\n');
  }

  // Splices one built container's components, and the relationships between them, into a design
  // container's block. Returns { text } or { error }, never partial text. Only the container line may
  // change (a ' {' is added when it has no block); every other original line is kept.
  function spliceComponents(designText, design, designId, built, builtId) {
    const el = design.elements.get(designId), bc = built.elements.get(builtId);
    if (!el || el.kind !== 'container') return { error: 'The design element is not a container.' };
    if (!bc || bc.kind !== 'container') return { error: 'The as-built element is not a container.' };
    if ([...design.elements.values()].some(e => e.parent === el.id)) return { error: `"${el.name}" already has components in the design.` };
    const comps = [...built.elements.values()].filter(e => e.kind === 'component' && e.parent === bc.id);
    if (!comps.length) return { error: `"${bc.name}" has no as-built components.` };
    const r = insertInBlock(designText, el, ind => {
      const q = x => '"' + String(x == null ? '' : x).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
      const used = new Set([...design.elements.values()].map(e => e.ident).filter(Boolean));
      const ident = new Map();
      for (const c of comps) {
        const b = c.ident || 'c_' + c.name.replace(/\W+/g, '_'); let id = b;
        for (let k = 2; used.has(id); k++) id = b + '_' + k;
        used.add(id); ident.set(c.id, id);
      }
      const body = comps.map(c => `${ind}${ident.get(c.id)} = component ${q(c.name)} "" ${q(c.technology)}`);
      for (const r of built.rels) {
        if (!ident.has(r.src) || !ident.has(r.dst)) continue;
        const k = r.props['d.interaction'];
        body.push(`${ind}${ident.get(r.src)} -> ${ident.get(r.dst)} ${q(r.description)} ${q(r.technology)}` + (k ? ` { properties { "d.interaction" ${q(k)} } }` : ''));
      }
      return body;
    });
    if (r.error) return r;
    if (parse(r.text).errors.length > design.errors.length) return { error: `The spliced design for "${el.name}" would not parse.` };
    return r;
  }

  // For a new project, where no element says where its code is yet: one folder per container under its system's
  // folder (`<system>/<container>/**`, risk medium), each added as its own properties block. A suggestion for a person
  // to approve, never applied by itself. { text, areas: [{name, pattern, risk}] } or { error }.
  function suggestCodeAreas(designText) {
    const m = parse(designText);
    if (m.errors.length) return { error: 'The model does not parse. Fix it first, then suggest code areas.' };
    const els = [...m.elements.values()];
    if (els.some(e => e.props['d.code'] !== undefined)) return { error: 'Some elements already say where their code is (d.code). Add the others by hand.' };
    const containers = els.filter(e => e.kind === 'container').sort((a, b) => a.line - b.line);
    if (!containers.length) return { error: 'The model has no container, so there is nothing to give a code area.' };
    const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'container';
    const taken = new Set();
    const areas = containers.map(c => {
      const sys = m.elements.get(c.parent), base = `${slug(sys ? sys.name : 'system')}/${slug(c.name)}`;
      let dir = base; for (let k = 2; taken.has(dir); k++) dir = `${base}-${k}`;
      taken.add(dir);
      return { el: c, name: c.name, pattern: `${dir}/**`, risk: 'medium' };
    });
    let text = designText;
    for (const a of [...areas].reverse()) {
      const r = insertInBlock(text, a.el, ind => [`${ind}properties {`, `${ind}  "d.code" "${a.pattern}"`, `${ind}  "d.risk" "${a.risk}"`, `${ind}}`]);
      if (r.error) return r;
      text = r.text;
    }
    const out = parse(text), got = [...out.elements.values()];
    if (out.errors.length || areas.some(a => (got.find(e => e.id === a.el.id) || { props: {} }).props['d.code'] !== a.pattern)) {
      return { error: 'The suggested code areas could not be added cleanly. Add d.code and d.risk by hand.' };
    }
    return { text, areas: areas.map(({ name, pattern, risk }) => ({ name, pattern, risk })) };
  }

  // Adds lines at the end of one element's block, adding ' {' ... '}' when it has none. `body(indent)` gives the
  // lines. Only the element's declaration line may change; every other original line is kept. { text } or { error }.
  function insertInBlock(designText, el, body) {
    const src = designText, n = src.length;
    const starts = [0]; for (let i = 0; i < n; i++) if (src[i] === '\n') starts.push(i + 1);
    const lineAt = i => { let k = 0; while (k + 1 < starts.length && starts[k + 1] <= i) k++; return k; };
    const str = i => { let j = i + 1; while (j < n && src[j] !== '"') j += src[j] === '\\' ? 2 : 1; return j + 1; };
    const trivia = i => {
      for (;;) {
        while (i < n && /\s/.test(src[i])) i++;
        if (src[i] === '#' || (src[i] === '/' && src[i + 1] === '/')) { while (i < n && src[i] !== '\n') i++; }
        else if (src[i] === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; }
        else return i;
      }
    };
    const ls = starts[el.line - 1];
    if (ls == null) return { error: `Cannot find line ${el.line} of "${el.name}".` };
    const le = src.indexOf('\n', ls) < 0 ? n : src.indexOf('\n', ls);
    let kw = -1;
    for (let i = ls; i < le;) {
      if (src[i] === '"') { i = str(i); continue; }
      const m = /^[A-Za-z_!][\w.]*/.exec(src.slice(i, le));
      if (m) { if (m[0] === el.kind) { kw = i; break; } i += m[0].length; } else i++;
    }
    if (kw < 0) return { error: `The declaration line of "${el.name}" has no ${el.kind} keyword.` };
    let p = trivia(kw + el.kind.length), lastEnd = kw + el.kind.length;
    while (src[p] === '"') { p = str(p); lastEnd = p; p = trivia(p); }
    let close = -1;
    if (src[p] === '{') {
      let depth = 0;
      for (let i = p; i < n;) {
        const c = src[i];
        if (c === '"') { i = str(i); continue; }
        if (c === '#' || (c === '/' && src[i + 1] === '/')) { while (i < n && src[i] !== '\n') i++; continue; }
        if (c === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; continue; }
        if (c === '{') depth++;
        else if (c === '}' && --depth === 0) { close = i; break; }
        i++;
      }
      if (close < 0) return { error: `The block of "${el.name}" is not closed.` };
    }
    const eol = src.includes('\r\n') ? '\r\n' : '\n';
    const base = /^[ \t]*/.exec(src.slice(ls, le))[0];
    const ind = base + (base.includes('\t') ? '\t' : '  ');
    const lines = body(ind);
    if (close >= 0) {
      const cl = lineAt(close);
      if (!src.slice(starts[cl], close).trim()) return { text: src.slice(0, starts[cl]) + lines.join(eol) + eol + src.slice(starts[cl]) };
      return { text: src.slice(0, close).replace(/[ \t]+$/, '') + eol + lines.join(eol) + eol + base + src.slice(close) };
    }
    let e = src.indexOf('\n', lastEnd); if (e < 0) e = n; else if (src[e - 1] === '\r') e--;
    return { text: src.slice(0, lastEnd) + ' {' + src.slice(lastEnd, e) + eol + lines.join(eol) + eol + base + '}' + src.slice(e) };
  }


  Object.assign(Core, { atLevel, view, containerLevelText, spliceComponents, suggestCodeAreas });
})(typeof module === 'object' && typeof require === 'function' ? require('./core.js') : Core);
