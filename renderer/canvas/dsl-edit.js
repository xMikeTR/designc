/* designc-canvas: DSL editing.
   The DSL stays the source of truth: every canvas action is a surgical text edit that keeps the
   user's formatting, comments and ordering. locate() finds statements with character offsets;
   the edit functions are pure (text in, { text, ... } out). */
(function (root, factory) {
  const m = factory();
  if (typeof module === 'object' && module.exports) module.exports = m;
  else (root.DesigncCanvas = root.DesigncCanvas || {}).dsl = m;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const KINDS = { person: 'person', softwareSystem: 'softwareSystem', softwaresystem: 'softwareSystem', container: 'container', component: 'component' };

  // ---------------------------------------------------------------- tokenizer with offsets
  function tokenize(src) {
    const toks = []; let i = 0, line = 1; const n = src.length;
    while (i < n) {
      const c = src[i];
      if (c === '\n') { line++; i++; continue; }
      if (c === ' ' || c === '\t' || c === '\r') { i++; continue; }
      if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i++; continue; }
      if (c === '#') { while (i < n && src[i] !== '\n') i++; continue; }
      if (c === '/' && src[i + 1] === '*') { i += 2; while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] === '\n') line++; i++; } i += 2; continue; }
      if (c === '"') {
        const s = i, l = line; let j = i + 1, v = '';
        while (j < n && src[j] !== '"') { if (src[j] === '\\' && j + 1 < n) { v += src[j + 1]; j += 2; continue; } if (src[j] === '\n') line++; v += src[j]; j++; }
        toks.push({ t: 'str', v, s, e: Math.min(j + 1, n), line: l }); i = j + 1; continue;
      }
      if (c === '{' || c === '}' || c === '=') { toks.push({ t: c, s: i, e: i + 1, line }); i++; continue; }
      if (c === '-' && src[i + 1] === '>') { toks.push({ t: '->', s: i, e: i + 2, line }); i += 2; continue; }
      const m = /^[A-Za-z_!][\w.]*/.exec(src.slice(i, i + 200));
      if (m) { toks.push({ t: 'id', v: m[0], s: i, e: i + m[0].length, line }); i += m[0].length; continue; }
      toks.push({ t: '?', v: c, s: i, e: i + 1, line }); i++;
    }
    return toks;
  }

  // ---------------------------------------------------------------- locator
  // Mirrors designc core.js's grammar so element order and auto ids line up with Core.parse.
  function locate(src) {
    const toks = tokenize(src); let p = 0;
    const out = { elements: [], relationships: [], model: null, workspace: null };
    const peek = (k = 0) => toks[p + k], next = () => toks[p++];
    function strings() { const a = []; while (peek() && peek().t === 'str') a.push(next()); return a; }
    function skipBlock() { let d = 0; while (p < toks.length) { const t = next(); if (t.t === '{') d++; else if (t.t === '}') { d--; if (d === 0) return t; } } return null; }
    function props(target) {
      const kw = next(); if (!peek() || peek().t !== '{') return;
      const open = next(); const entries = [];
      while (peek() && peek().t !== '}') { const k = next(), v = peek(); if (!v || v.t === '}') break; next(); entries.push({ key: k.v, keyTok: k, valTok: v }); }
      const close = peek() ? next() : null;
      target.props = { kwTok: kw, open, close, entries };
    }
    let auto = 0;
    function element(kindTok, identTok, parent, startTok) {
      const strs = strings();
      const el = { kind: KINDS[kindTok.v], kindTok, identTok, ident: identTok ? identTok.v : null, id: identTok ? identTok.v : '_e' + (++auto),
        strs, name: strs[0] ? strs[0].v : '(unnamed)', parent, start: startTok.s, headerEnd: (strs.length ? strs[strs.length - 1] : kindTok).e,
        open: null, close: null, props: null, line: kindTok.line, children: [] };
      out.elements.push(el);
      if (parent) parent.children.push(el);
      if (peek() && peek().t === '{') { el.open = next(); body(el); el.close = toks[p - 1] && toks[p - 1].t === '}' ? toks[p - 1] : null; }
      el.end = el.close ? el.close.e : el.headerEnd;
    }
    function relationship(srcRef, startTok, arrow, owner) {
      const dst = next(); if (!dst || dst.t !== 'id') return;
      const strs = strings();
      const r = { srcRef, dstRef: dst.v, dstTok: dst, strs, arrow, start: startTok.s, headerEnd: (strs.length ? strs[strs.length - 1] : dst).e, open: null, close: null, props: null, line: arrow.line, owner };
      if (peek() && peek().t === '{') {
        r.open = next();
        while (peek() && peek().t !== '}') { const t = peek(); if (t.t === 'id' && t.v === 'properties') props(r); else if (t.t === '{') skipBlock(); else next(); }
        r.close = peek() ? next() : null;
      }
      r.end = r.close ? r.close.e : r.headerEnd;
      out.relationships.push(r);
    }
    function body(owner) {
      while (p < toks.length) {
        const t = peek();
        if (t.t === '}') { next(); return true; }
        if (t.t === 'id') {
          const v = t.v;
          if (owner && v === 'properties') { props(owner); continue; }
          if (owner && (v === 'tags' || v === 'description' || v === 'technology')) { next(); strings(); continue; }
          if (peek(1) && peek(1).t === '=' && peek(2) && peek(2).t === 'id' && KINDS[peek(2).v]) { const id = next(); next(); const k = next(); element(k, id, owner, id); continue; }
          if (KINDS[v]) { next(); element(t, null, owner, t); continue; }
          if (peek(1) && peek(1).t === '->') { const s = next(); const a = next(); relationship(v, s, a, null); continue; }
          if (v === 'workspace' || v === 'model') {
            next(); strings();
            if (peek() && peek().t === '{') { const open = next(); const blk = { open }; out[v] = blk; body(null); blk.close = toks[p - 1]; }
            continue;
          }
          next(); strings(); if (peek() && peek().t === '{') skipBlock();
          continue;
        }
        if (t.t === '->' && owner) { const a = next(); relationship('#' + owner.id, a, a, owner); continue; }
        if (t.t === '{') { skipBlock(); continue; }
        next();
      }
      return false;
    }
    while (p < toks.length) body(null);
    // resolve relationship endpoints to element ids
    const byIdent = new Map(out.elements.filter(e => e.ident).map(e => [e.ident, e]));
    for (const r of out.relationships) {
      r.src = r.srcRef.startsWith('#') ? out.elements.find(e => e.id === r.srcRef.slice(1)) : byIdent.get(r.srcRef);
      r.dst = byIdent.get(r.dstRef);
    }
    return out;
  }

  // ---------------------------------------------------------------- helpers
  const q = s => '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  const lineStart = (src, off) => src.lastIndexOf('\n', off - 1) + 1;
  const indentAt = (src, off) => { const ls = lineStart(src, off); return /^[ \t]*/.exec(src.slice(ls))[0]; };
  function unit(src) { const m = /\n([ \t]+)\S/.exec(src); return m ? (m[1].startsWith('\t') ? '\t' : ' '.repeat(Math.min(m[1].length, 4))) : '  '; }
  const splice = (src, s, e, ins) => src.slice(0, s) + ins + src.slice(e);
  // remove whole lines [s, e) plus a trailing newline when the statement owns its lines
  function cutLines(src, s, e) {
    const ls = lineStart(src, s); const before = src.slice(ls, s).trim() === '';
    let le = src.indexOf('\n', e); if (le < 0) le = src.length; const after = src.slice(e, le).trim() === '';
    if (before && after) return [ls, Math.min(le + 1, src.length)];
    return [s, e];
  }
  function findElement(loc, ref) {
    if (ref == null) return null;
    if (typeof ref === 'string') return loc.elements.find(e => e.id === ref || e.ident === ref) || loc.elements.find(e => e.name === ref) || null;
    return loc.elements.find(e => (ref.id && e.id === ref.id) || (ref.ident && e.ident === ref.ident)) ||
      loc.elements.find(e => ref.line && e.line === ref.line && (!ref.name || e.name === ref.name)) || null;
  }
  function findRelationship(loc, ref) {
    if (ref == null) return null;
    if (typeof ref === 'number') return loc.relationships[ref] || null;
    const cands = loc.relationships.filter(r => r.line === ref.line);
    if (cands.length <= 1) return cands[0] || null;
    return cands.find(r => r.src && r.dst && (!ref.src || r.src.id === ref.src || r.src.ident === ref.src) && (!ref.dst || r.dst.id === ref.dst || r.dst.ident === ref.dst)) || cands[0];
  }
  function identFor(name, taken) {
    const words = String(name).replace(/[^A-Za-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);
    let base = words.length ? words.map((w, i) => (i ? w[0].toUpperCase() + w.slice(1) : w[0].toLowerCase() + w.slice(1))).join('') : 'element';
    if (!/^[A-Za-z_]/.test(base)) base = 'e' + base;
    let id = base, n = 2; while (taken.has(id) || KINDS[id] || ['workspace', 'model', 'views', 'properties', 'tags', 'this'].includes(id)) id = base + n++;
    return id;
  }
  const idents = loc => new Set(loc.elements.filter(e => e.ident).map(e => e.ident));

  // ---------------------------------------------------------------- edits
  function ensureIdent(src, ref) {
    const loc = locate(src), el = findElement(loc, ref);
    if (!el) throw new Error('element not found');
    if (el.ident) return { text: src, ident: el.ident };
    const id = identFor(el.name, idents(loc));
    return { text: splice(src, el.kindTok.s, el.kindTok.s, `${id} = `), ident: id };
  }
  function propsBlockText(props, ind, u) {
    const entries = Object.entries(props || {}).filter(([, v]) => v !== '' && v != null);
    if (!entries.length) return '';
    return `${ind}${u}properties {\n${entries.map(([k, v]) => `${ind}${u}${u}${q(k)} ${q(v)}`).join('\n')}\n${ind}${u}}\n`;
  }
  function headerArgs(kind, f) {
    const a = kind === 'container' || kind === 'component' ? [f.name, f.description || '', f.technology || '', (f.tags || []).join(',')] : [f.name, f.description || '', (f.tags || []).join(',')];
    while (a.length > 1 && !a[a.length - 1]) a.pop();
    return a.map(q).join(' ');
  }
  // Insert a new element. Containers and components go inside `parent` (ident or id); people and systems at model level.
  function addElement(src, spec) {
    let loc = locate(src);
    if (!loc.model) throw new Error('the DSL has no model block');
    const u = unit(src), taken = idents(loc);
    const ident = spec.ident && !taken.has(spec.ident) ? spec.ident : identFor(spec.name, taken);
    let at, ind;
    const parent = spec.parent ? findElement(loc, spec.parent) : null;
    if (parent) {
      if (!parent.open) {   // give the parent a body first
        const pind = indentAt(src, parent.start);
        src = splice(src, parent.headerEnd, parent.headerEnd, ` {\n${pind}}`);
        loc = locate(src);
      }
      const p2 = findElement(loc, parent.ident || parent.id);
      ind = indentAt(src, p2.start) + u;
      at = lineStart(src, p2.close.s);
    } else {
      ind = indentAt(src, loc.model.open.s) + u;
      const firstRel = loc.relationships.filter(r => !r.owner).sort((a, b) => a.start - b.start)[0];
      at = firstRel ? lineStart(src, firstRel.start) : lineStart(src, loc.model.close.s);
    }
    const bodyProps = propsBlockText(spec.props, ind, u);
    const text = `${ind}${ident} = ${spec.kind} ${headerArgs(spec.kind, spec)}${bodyProps ? ` {\n${bodyProps}${ind}}` : ''}\n`;
    return { text: splice(src, at, at, text), ident };
  }
  function addRelationship(src, spec) {
    let r1 = ensureIdent(src, spec.src); src = r1.text;
    let r2 = ensureIdent(src, spec.dst); src = r2.text;
    const loc = locate(src); const u = unit(src);
    const ind = indentAt(src, loc.model.open.s) + u;
    const at = lineStart(src, loc.model.close.s);
    const args = [spec.description || '', spec.technology || ''];
    while (args.length && !args[args.length - 1]) args.pop();
    const bodyProps = propsBlockText(spec.props, ind, u);
    const text = `${ind}${r1.ident} -> ${r2.ident}${args.length ? ' ' + args.map(q).join(' ') : ''}${bodyProps ? ` {\n${bodyProps}${ind}}` : ''}\n`;
    const out = splice(src, at, at, text);
    const line = out.slice(0, at).split('\n').length;
    return { text: out, src: r1.ident, dst: r2.ident, line };
  }
  // Set (or, with an empty value, remove) a d.* property on an element or relationship. The result is read back,
  // so a write that would not land inside the properties block is refused rather than saved where nothing reads it.
  function setProperty(src, target, key, value) {
    const r = writeProperty(src, target, key, value);
    if (!readBack(r.text, target, key, value)) throw new Error(`${key} could not be ${value === '' || value == null ? 'removed' : 'set'} here. Edit it in the model file.`);
    return r;
  }
  // True when the node's properties block holds key = value, or (with an empty value) does not hold key.
  function readBack(src, target, key, value) {
    const loc = locate(src);
    const node = target.kind === 'relationship' ? findRelationship(loc, target.ref) : findElement(loc, target.ref);
    if (!node) return false;
    const entry = node.props && node.props.entries.find(e => e.key === key);
    return value === '' || value == null ? !entry : !!entry && entry.valTok.v === String(value);
  }
  function writeProperty(src, target, key, value) {
    const loc = locate(src);
    const node = target.kind === 'relationship' ? findRelationship(loc, target.ref) : findElement(loc, target.ref);
    if (!node) throw new Error(`${target.kind} not found`);
    const u = unit(src), ind = indentAt(src, node.start);
    const entry = node.props && node.props.entries.find(e => e.key === key);
    const empty = value === '' || value == null;
    if (entry) {
      if (!empty) return { text: splice(src, entry.valTok.s, entry.valTok.e, q(value)) };
      const [s, e] = cutLines(src, entry.keyTok.s, entry.valTok.e);
      let out = splice(src, s, e, '');
      if (node.props.entries.length === 1) {   // drop the now-empty properties block
        const l2 = locate(out); const n2 = target.kind === 'relationship' ? findRelationship(l2, target.ref) : findElement(l2, target.ref);
        if (n2 && n2.props && !n2.props.entries.length) { const [a, b] = cutLines(out, n2.props.kwTok.s, n2.props.close.e); out = splice(out, a, b, ''); }
      }
      return { text: out };
    }
    if (empty) return { text: src };
    const line = `${ind}${u}${u}${q(key)} ${q(value)}\n`;
    if (node.props) {
      const { open, close } = node.props;   // a one-line block `properties { ... }` takes the entry inline
      if (!src.slice(open.e, close.s).includes('\n')) return { text: splice(src, close.s, close.s, `${src[close.s - 1] === ' ' ? '' : ' '}${q(key)} ${q(value)} `) };
      return { text: splice(src, lineStart(src, close.s), lineStart(src, close.s), line) };
    }
    const block = `${ind}${u}properties {\n${line}${ind}${u}}\n`;
    if (node.open) { let at = src.indexOf('\n', node.open.e); at = at < 0 ? node.open.e : at + 1; return { text: splice(src, at, at, block) }; }
    return { text: splice(src, node.headerEnd, node.headerEnd, ` {\n${block}${ind}}`) };
  }
  // Header fields: element name/description/technology, relationship description/technology.
  function setField(src, target, field, value) {
    const loc = locate(src);
    const node = target.kind === 'relationship' ? findRelationship(loc, target.ref) : findElement(loc, target.ref);
    if (!node) throw new Error(`${target.kind} not found`);
    const order = target.kind === 'relationship' ? ['description', 'technology'] : (node.kind === 'container' || node.kind === 'component') ? ['name', 'description', 'technology'] : ['name', 'description'];
    const idx = order.indexOf(field); if (idx < 0) throw new Error(`${field} cannot be set on a ${node.kind || 'relationship'}`);
    if (node.strs[idx]) return { text: splice(src, node.strs[idx].s, node.strs[idx].e, q(value)) };
    const fill = [];
    for (let i = node.strs.length; i < idx; i++) fill.push('""');
    fill.push(q(value));
    return { text: splice(src, node.headerEnd, node.headerEnd, ' ' + fill.join(' ')) };
  }
  // Delete an element with its children and every relationship that touches them.
  function deleteElement(src, ref) {
    const loc = locate(src), el = findElement(loc, ref);
    if (!el) throw new Error('element not found');
    const doomed = new Set(); const walk = e => { doomed.add(e); e.children.forEach(walk); }; walk(el);
    const ranges = [cutLines(src, el.start, el.end)];
    for (const r of loc.relationships) {
      if (r.owner && doomed.has(r.owner)) continue;   // inside the removed block already
      if ((r.src && doomed.has(r.src)) || (r.dst && doomed.has(r.dst))) ranges.push(cutLines(src, r.start, r.end));
    }
    ranges.sort((a, b) => b[0] - a[0]);
    let out = src, last = Infinity;
    for (const [s, e] of ranges) { if (e > last) continue; out = splice(out, s, e, ''); last = s; }
    return { text: out, removed: [...doomed].map(e => e.id) };
  }
  function deleteRelationship(src, ref) {
    const loc = locate(src), r = findRelationship(loc, ref);
    if (!r) throw new Error('relationship not found');
    const [s, e] = cutLines(src, r.start, r.end);
    return { text: splice(src, s, e, '') };
  }
  function addTag(src, ref, tag) {
    const loc = locate(src), el = findElement(loc, ref); if (!el) throw new Error('element not found');
    const tagIdx = el.kind === 'container' || el.kind === 'component' ? 3 : 2;
    const cur = el.strs[tagIdx] ? el.strs[tagIdx].v.split(',').map(s => s.trim()).filter(Boolean) : [];
    if (cur.includes(tag)) return { text: src };
    const val = [...cur, tag].join(',');
    if (el.strs[tagIdx]) return { text: splice(src, el.strs[tagIdx].s, el.strs[tagIdx].e, q(val)) };
    const fill = []; for (let i = el.strs.length; i < tagIdx; i++) fill.push('""'); fill.push(q(val));
    return { text: splice(src, el.headerEnd, el.headerEnd, ' ' + fill.join(' ')) };
  }
  // Insert a template: DSL statements for the model body, with {p} replaced by a unique prefix.
  function insertSnippet(src, snippet, prefix) {
    let loc = locate(src); if (!loc.model) throw new Error('the DSL has no model block');
    const taken = idents(loc); let p = prefix || 't', n = 2; while ([...taken].some(i => i.startsWith(p + '_'))) p = (prefix || 't') + n++;
    const u = unit(src), ind = indentAt(src, loc.model.open.s) + u;
    const reindent = s => s.replace(/\{p\}/g, p).split('\n').map(l => (l.trim() ? ind + l.replace(/^ {2}/gm, u) : l)).join('\n').replace(/\s*$/, '\n');
    const firstRel = loc.relationships.filter(r => !r.owner).sort((a, b) => a.start - b.start)[0];
    const atEls = firstRel ? lineStart(src, firstRel.start) : lineStart(src, loc.model.close.s);
    src = splice(src, atEls, atEls, reindent(snippet.elements));
    loc = locate(src);
    const atRels = lineStart(src, loc.model.close.s);
    if (snippet.relationships) src = splice(src, atRels, atRels, reindent(snippet.relationships));
    return { text: src, prefix: p };
  }
  const EMPTY = 'workspace "New system" {\n  model {\n  }\n}\n';

  return { tokenize, locate, findElement, findRelationship, ensureIdent, addElement, addRelationship, setProperty, readBack, setField, deleteElement, deleteRelationship, addTag, insertSnippet, identFor, EMPTY };
});
