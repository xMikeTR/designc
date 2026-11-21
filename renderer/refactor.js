/* designc desktop: references, definition, fingerprint-safe rename and code actions. Pure, no I/O, editor-neutral.
   Dual-load like renderer/problems.js: <script src="refactor.js"> in the renderer (before app.js), require('./renderer/refactor.js')
   from the language server and tests. lsp/ only maps these shapes to the protocol.
   `state` is {files, cfgModel, model}: the registry text (overlay applied), the model's registry path, and the model parsed with
   resolve: p => files[p] ?? null (what Headless.checkState returns). Positions are {file, line (1-based), c (0-based UTF-16), n}. */
const Refactor = (() => {
  const node = typeof require === 'function' && typeof module === 'object';
  const CR = node ? require('./core.js') : Core;
  const DSL = node ? require('./canvas/dsl-edit.js') : DesigncCanvas.dsl;
  const Y = node ? require('js-yaml') : jsyaml;

  // ---------- YAML references ----------
  // Which keys are references, by folder. handovers/ is frozen and never scanned.
  const YAML_PATH = /^(decisions|requirements|work|proposals|scenarios)\/[^/]+\.ya?ml$/;
  function keysFor(path) {
    const m = YAML_PATH.exec(path);
    if (!m) return [];
    if (m[1] === 'scenarios') return ['artifact'];
    return m[1] === 'decisions' ? ['binds', 'elements', 'promoted_against'] : ['binds', 'elements'];
  }
  const unsafe = (path, key) => ({ error: `${path}: ${key} is written in a form designc cannot edit safely; edit it by hand` });

  // One scalar starting at s[i]: quoted (double or single) or plain. {value, start, end} or null.
  function scalarAt(s, i, flow) {
    const q = s[i];
    if (q === '"') {
      let j = i + 1;
      while (j < s.length && s[j] !== '"') j += s[j] === '\\' ? 2 : 1;
      if (j >= s.length) return null;
      let value; try { value = JSON.parse(s.slice(i, j + 1)); } catch { return null; }
      return { value, start: i, end: j + 1 };
    }
    if (q === "'") {
      let j = i + 1;
      for (; j < s.length; j++) { if (s[j] === "'") { if (s[j + 1] === "'") { j++; continue; } break; } }
      if (j >= s.length) return null;
      return { value: s.slice(i + 1, j).replace(/''/g, "'"), start: i, end: j + 1 };
    }
    let j = i;
    while (j < s.length) {
      if (flow && (s[j] === ',' || s[j] === ']')) break;
      if (s[j] === '#' && j > i && /\s/.test(s[j - 1])) break;
      j++;
    }
    let end = j; while (end > i && /\s/.test(s[end - 1])) end--;
    return end > i ? { value: s.slice(i, end), start: i, end } : null;
  }
  const restIsEmpty = (s, i) => /^\s*(#.*)?$/.test(s.slice(i));

  // `[a, "b c"]` on one line, from s[i] === '['. -> {items: [{value, start, end}]} or null (multi-line, trailing text, bad scalar).
  function flowItems(s, i) {
    const items = []; let j = i + 1;
    for (;;) {
      while (s[j] === ' ' || s[j] === '\t') j++;
      if (s[j] === ']') { j++; break; }
      if (j >= s.length) return null;
      const sc = scalarAt(s, j, true); if (!sc) return null;
      items.push(sc); j = sc.end;
      while (s[j] === ' ' || s[j] === '\t') j++;
      if (s[j] === ',') { j++; continue; }
      if (s[j] === ']') { j++; break; }
      return null;
    }
    return restIsEmpty(s, j) ? { items } : null;
  }

  // `[{"element":"x","name":"y","hash":"h"}, ...]` on one line: the string values of "element" and "name" in each top-level object.
  function jsonEntries(s, i) {
    const out = []; const stack = []; let expectKey = false, curKey = null, entry = -1;
    for (let j = i; j < s.length; j++) {
      const ch = s[j];
      if (ch === '[') stack.push('a');
      else if (ch === '{') { stack.push('o'); if (stack.length === 2) entry++; expectKey = true; }
      else if (ch === '}' || ch === ']') { stack.pop(); if (!stack.length) return restIsEmpty(s, j + 1) ? out : null; }
      else if (ch === ',' && stack.length === 2 && stack[1] === 'o') expectKey = true;
      else if (ch === '"') {
        let k = j + 1; while (k < s.length && s[k] !== '"') k += s[k] === '\\' ? 2 : 1;
        if (k >= s.length) return null;
        if (stack.length === 2 && stack[1] === 'o') {
          let v; try { v = JSON.parse(s.slice(j, k + 1)); } catch { return null; }
          if (expectKey) { curKey = v; expectKey = false; }
          else { if (curKey === 'element' || curKey === 'name') out.push({ key: `promoted_against.${curKey}`, index: entry, value: v, start: j, end: k + 1 }); curKey = null; }
        }
        j = k;
      }
    }
    return null;
  }

  // [{key, index, value, line, c, n}] for a registry YAML file, or {error}. `parsed` is the js-yaml value of the file.
  // Self-check: what the scan reads must equal what js-yaml reads for the same keys, else the file is refused.
  function yamlRefs(path, text, parsed) {
    const keys = keysFor(path);
    if (!keys.length) return [];
    if (parsed === undefined) { try { parsed = Y.load(text); } catch { return { error: `${path} does not parse as YAML` }; } }
    const doc = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    const lines = text.split('\n'), refs = [], failed = new Set();
    const add = (key, index, value, li, start, end) => refs.push({ key, index, value, line: li + 1, c: start, n: end - start });
    for (let li = 0; li < lines.length; li++) {
      const raw = lines[li].replace(/\r$/, '');
      const m = /^([A-Za-z_]\w*)\s*:(?:\s+|$)(.*)$/.exec(raw);
      if (!m || !keys.includes(m[1])) continue;
      const key = m[1], restAt = raw.length - m[2].length, rest = m[2];
      if (rest === '' || rest[0] === '#') {
        let j = li + 1, idx = 0;
        for (; j < lines.length; j++) {
          const l = lines[j].replace(/\r$/, '');
          if (/^\s*(#.*)?$/.test(l)) continue;
          const b = /^(\s*)-(\s+)(\S.*)$/.exec(l);
          if (!b) break;
          const col = b[1].length + 1 + b[2].length, sc = scalarAt(l, col, false);
          if (!sc || !restIsEmpty(l, sc.end)) { failed.add(key); break; }
          if (key === 'promoted_against') { failed.add(key); break; }
          add(key, idx++, sc.value, j, sc.start, sc.end); li = j;
        }
      } else if (key === 'promoted_against') {
        const es = rest[0] === '[' ? jsonEntries(raw, restAt) : null;
        if (!es) failed.add(key); else for (const e of es) add(e.key, e.index, e.value, li, e.start, e.end);
      } else if (rest[0] === '[') {
        const f = flowItems(raw, restAt);
        if (!f) failed.add(key); else f.items.forEach((it, k) => add(key, k, it.value, li, it.start, it.end));
      } else {
        const sc = scalarAt(raw, restAt, false);
        if (!sc || !restIsEmpty(raw, sc.end)) failed.add(key); else add(key, 0, sc.value, li, sc.start, sc.end);
      }
    }
    for (const key of keys) {
      if (failed.has(key)) return unsafe(path, key);
      const v = doc[key];
      if (key === 'promoted_against') {
        const want = [];
        if (Array.isArray(v)) v.forEach((e, i) => { if (e && typeof e === 'object') for (const f of ['element', 'name']) if (typeof e[f] === 'string') want.push(`${i}|${f}|${e[f]}`); });
        const got = refs.filter(r => r.key.startsWith('promoted_against.')).map(r => `${r.index}|${r.key.slice(17)}|${r.value}`);
        if (JSON.stringify(want.sort()) !== JSON.stringify(got.sort())) return unsafe(path, key);
      } else {
        const want = v == null ? [] : Array.isArray(v) ? v : [v];
        const got = refs.filter(r => r.key === key).sort((a, b) => a.index - b.index).map(r => r.value);
        if (JSON.stringify(want) !== JSON.stringify(got)) return unsafe(path, key);
      }
    }
    return refs;
  }

  // ---------- state ----------
  const scans = new WeakMap();
  // The YAML files that can hold references, in path order.
  const yamlPaths = state => Object.keys(state.files).filter(p => YAML_PATH.test(p)).sort();
  // {refs, parsed} or {error}, memoised on the state object.
  function scan(state, path) {
    let c = scans.get(state); if (!c) scans.set(state, c = new Map());
    if (!c.has(path)) {
      let parsed, r;
      try { parsed = Y.load(state.files[path]); r = yamlRefs(path, state.files[path], parsed); } catch { r = { error: `${path} does not parse as YAML` }; }
      c.set(path, Array.isArray(r) ? { refs: r, parsed: parsed && typeof parsed === 'object' ? parsed : {} } : r);
    }
    return c.get(path);
  }
  const fileOf = (state, at) => (at && at.file) || state.cfgModel;
  const norm = (state, at) => ({ ...at, file: fileOf(state, at) });
  const within = (at, line0, ch) => at.line - 1 === line0 && ch >= at.c && ch <= at.c + at.n;

  // What a YAML ref points at now: {element, kind} or null.
  function resolveYaml(state, ref, parsed) {
    const els = [...state.model.elements.values()];
    if (ref.key.startsWith('promoted_against.')) {
      const entry = parsed.promoted_against && parsed.promoted_against[ref.index];
      if (!entry || typeof entry !== 'object') return null;
      const el = CR.resolveBinding(state.model, entry);
      if (!el) return null;
      if (ref.key.endsWith('.element')) return el.ident && el.ident === ref.value ? { element: el, kind: 'ident' } : null;
      return el.name === ref.value ? { element: el, kind: 'name' } : null;
    }
    const hit = els.filter(e => e.name === ref.value);
    return hit.length === 1 ? { element: hit[0], kind: 'name' } : null;
  }

  // The symbol at a 0-based position of a registry file: {element, kind: 'ident'|'name', at} | {include, at} | null.
  function symbolAt(state, rel, line0, character) {
    const sy = state.model.symbols;
    if (/\.dsl$/.test(rel) && sy) {
      for (const inc of sy.includes) if (inc.path && fileOf(state, inc.at) === rel && within(inc.at, line0, character)) return { include: inc.path, at: norm(state, inc.at) };
      for (const d of sy.defs) {
        const el = state.model.elements.get(d.id);
        if (d.identAt && fileOf(state, d.identAt) === rel && within(d.identAt, line0, character)) return { element: el, kind: 'ident', at: norm(state, d.identAt), role: 'def' };
        if (d.nameAt && fileOf(state, d.nameAt) === rel && within(d.nameAt, line0, character)) return { element: el, kind: 'name', at: norm(state, d.nameAt), role: 'def' };
      }
      for (const r of sy.refs) {
        if (r.id && fileOf(state, r.at) === rel && within(r.at, line0, character)) return { element: state.model.elements.get(r.id), kind: 'ident', at: norm(state, r.at), role: r.role };
      }
      return null;
    }
    if (YAML_PATH.test(rel) && rel in state.files) {
      const s = scan(state, rel);
      if (s.error) return null;
      for (const r of s.refs) {
        if (!within(r, line0, character)) continue;
        const hit = r.value ? resolveYaml(state, r, s.parsed) : null;
        return hit ? { element: hit.element, kind: hit.kind, at: { file: rel, line: r.line, c: r.c, n: r.n }, role: r.key, ref: r } : null;
      }
    }
    return null;
  }

  // Where a symbol is defined: {path, at}, or null. An include goes to line 1 of the included file.
  function definition(state, sym) {
    if (!sym) return null;
    if (sym.include) return { path: sym.include, at: { file: sym.include, line: 1, c: 0, n: 0 } };
    const d = (state.model.symbols ? state.model.symbols.defs : []).find(x => x.id === sym.element.id);
    const at = d && (d.identAt || d.nameAt);
    return at ? { path: fileOf(state, at), at: norm(state, at) } : null;
  }

  // Every place an element is named, as [{path, at}]: the declaration (when asked), the DSL refs in source order, then the YAML refs by path.
  function references(state, elementId, { includeDeclaration = false } = {}) {
    const sy = state.model.symbols, out = [];
    if (!sy) return out;
    const order = state.model.sources.map(s => s.path ?? state.cfgModel);
    const rank = p => { const i = order.indexOf(p); return i < 0 ? order.length : i; };
    if (includeDeclaration) {
      const d = sy.defs.find(x => x.id === elementId);
      if (d) for (const at of [d.identAt, d.nameAt]) if (at) out.push({ path: fileOf(state, at), at: norm(state, at) });
    }
    out.push(...sy.refs.filter(r => r.id === elementId).map(r => ({ path: fileOf(state, r.at), at: norm(state, r.at) }))
      .sort((a, b) => rank(a.path) - rank(b.path) || a.at.line - b.at.line || a.at.c - b.at.c));
    for (const p of yamlPaths(state)) {
      const s = scan(state, p);
      if (s.error) continue;
      for (const r of s.refs) {
        const hit = r.value ? resolveYaml(state, r, s.parsed) : null;
        if (hit && hit.element.id === elementId) out.push({ path: p, at: { file: p, line: r.line, c: r.c, n: r.n } });
      }
    }
    return out;
  }

  // ---------- rename ----------
  const RESERVED = new Set([...Object.keys(CR._shared.KINDS), ...CR._shared.SKIP, 'workspace', 'model', 'views', 'styles', 'properties', 'tags', 'description', 'technology', 'this',
    'deploymentEnvironment', 'deploymentNode', 'infrastructureNode', 'containerInstance', 'softwareSystemInstance', 'relationship', 'element', 'group', 'include', 'exclude', 'autoLayout']);
  const normName = x => String(x).toLowerCase().replace(/[^a-z0-9]/g, '');
  const dslQuote = s => '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  // A YAML flow/block list item or scalar: plain unless it needs quotes (then a JSON string, which is valid YAML).
  function yamlScalar(s) {
    const plain = s !== '' && !/[:,\[\]{}#&*!|>'"%@`\x00-\x1f]/.test(s) && !/^\s|\s$/.test(s) && !/^[-?]/.test(s)
      && !/^(null|~|true|false|[-+]?(\d[\d_]*)(\.\d*)?([eE][-+]?\d+)?|[-+]?\.\d+([eE][-+]?\d+)?|0x[0-9a-f]+|0o[0-7]+|[-+]?\.inf|\.nan)$/i.test(s);
    return plain ? s : JSON.stringify(s);
  }
  const deployIdents = model => {
    const out = new Set(), walk = nodes => nodes.forEach(n => { if (n.ident) out.add(n.ident); walk(n.children || []); });
    for (const e of (model.deployment ? model.deployment.environments : [])) { if (e.ident) out.add(e.ident); walk(e.nodes); }
    return out;
  };
  const sortEdits = edits => edits.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) || a.range.line0 - b.range.line0 || a.range.c - b.range.c);
  function applyTo(files, edits) {
    const out = { ...files }, by = new Map();
    for (const e of edits) { if (!by.has(e.path)) by.set(e.path, []); by.get(e.path).push(e); }
    for (const [p, list] of by) {
      const lines = out[p].split('\n');
      for (const e of list.slice().sort((a, b) => b.range.line0 - a.range.line0 || b.range.c - a.range.c)) {
        const l = lines[e.range.line0]; lines[e.range.line0] = l.slice(0, e.range.c) + e.newText + l.slice(e.range.c + e.range.n);
      }
      out[p] = lines.join('\n');
    }
    return out;
  }
  const parseWith = (files, cfgModel) => CR.parse(files[cfgModel], { path: cfgModel, resolve: p => files[p] ?? null });
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

  // renamePlan({files, cfgModel, at: {path, line0, character}, newName}) -> {kind, from, to, edits: [{path, range: {line0, c, n}, newText}], rebind: [{decision, element}]} or {error}.
  // An identifier rename (cursor on an identifier) or a name rename (cursor on a name string or a YAML name). The plan is proved before it is
  // returned: re-parsed after the edits, diffModels must show nothing but the rename. It never touches a promoted_against hash (a human re-binds);
  // `rebind` lists the bound decisions whose fingerprint the rename changes, which the gate then reports as "changed since promotion".
  function renamePlan({ files, cfgModel, at, newName }) {
    if (files[cfgModel] == null) return { error: `cannot read the model ${cfgModel}` };
    const model = parseWith(files, cfgModel), state = { files, cfgModel, model };
    if (model.errors.length) return { error: `fix the ${plural(model.errors.length, 'model error')} first` };
    if (/^handovers\//.test(at.path)) return { error: 'handovers/ is frozen and is never renamed; rename from the model or a live file' };
    if (YAML_PATH.test(at.path) && at.path in files) { const sc = scan(state, at.path); if (sc.error) return { error: sc.error }; }
    const sym = symbolAt(state, at.path, at.line0, at.character);
    if (!sym || sym.include) return { error: 'nothing to rename here: put the cursor on an element identifier or name' };
    const el = sym.element, kind = sym.kind;
    if (kind === 'ident' && !el.ident) return { error: `"${el.name}" has no identifier to rename` };
    const from = kind === 'ident' ? el.ident : el.name, to = newName;
    if (to === from) return { kind, from, to, edits: [], rebind: [] };
    const els = [...model.elements.values()];
    if (kind === 'ident') {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(to)) return { error: `"${to}" is not a valid identifier: letters, digits and _, not starting with a digit` };
      if (RESERVED.has(to)) return { error: `"${to}" is a reserved word` };
      const used = els.find(e => e.ident === to);
      if (used) return { error: `identifier "${to}" is already used by "${used.name}"` };
      if (deployIdents(model).has(to)) return { error: `identifier "${to}" is already used in a deployment environment` };
      for (const src of model.sources) {
        const text = src.path == null ? files[cfgModel] : (src.text != null ? src.text : files[src.path]);
        for (const t of DSL.tokenize(text || '')) if (t.t === 'id' && t.v.includes('.') && t.v.split('.').includes(from)) return { error: `"${from}" appears in the dotted name ${t.v}; designc does not rename hierarchical identifiers` };
      }
    } else {
      if (!to.trim()) return { error: 'the name is empty' };
      if (/[\r\n]/.test(to)) return { error: 'a name cannot contain a newline' };
      if (els.filter(e => e.name === from).length > 1) return { error: `"${from}" is the name of ${els.filter(e => e.name === from).length} elements; binds by name cannot tell them apart` };
      const same = els.find(e => e.id !== el.id && e.name === to);
      if (same) return { error: `another element is already named "${to}"` };
      const sib = els.find(e => e.id !== el.id && e.parent === el.parent && normName(e.name) === normName(to));
      if (sib) return { error: `"${to}" reads the same as its sibling "${sib.name}" under the same parent` };
    }
    // Unscannable YAML that mentions the old value cannot be edited safely: refuse before building anything.
    for (const p of yamlPaths(state)) { const sc = scan(state, p); if (sc.error && files[p].includes(from)) return { error: sc.error }; }

    const edits = [], defs = model.symbols.defs, def = defs.find(d => d.id === el.id);
    const dsl = (pos, newText) => edits.push({ path: fileOf(state, pos), range: { line0: pos.line - 1, c: pos.c, n: pos.n }, newText });
    const touched = new Set();
    if (kind === 'ident') {
      dsl(def.identAt, to);
      for (const r of model.symbols.refs) if (r.id === el.id) dsl(r.at, to);
    } else {
      const lineText = (files[fileOf(state, def.nameAt)] || '').split('\n')[def.nameAt.line - 1] || '';
      if (lineText.substr(def.nameAt.c, def.nameAt.n).length !== def.nameAt.n) return { error: `the name of "${from}" spans several lines; edit it by hand` };
      dsl(def.nameAt, dslQuote(to));
    }
    const rebind = [];
    for (const p of yamlPaths(state)) {
      const sc = scan(state, p); if (sc.error) continue;
      const bound = sc.parsed.status === 'bound';
      for (const r of sc.refs) {
        if (r.value !== from) continue;
        const hit = resolveYaml(state, r, sc.parsed);
        if (!hit || hit.element.id !== el.id) continue;
        const isPA = r.key.startsWith('promoted_against.');
        if (isPA && !bound) continue;
        if (kind === 'ident' ? r.key !== 'promoted_against.element' : r.key === 'promoted_against.element') continue;
        edits.push({ path: p, range: { line0: r.line - 1, c: r.c, n: r.n }, newText: isPA ? JSON.stringify(to) : yamlScalar(to) });
        touched.add(`${p}:${r.line}:${r.c}`);
      }
    }
    sortEdits(edits);

    // Proof: the edits change the name (or the identifier) and nothing else.
    const afterFiles = applyTo(files, edits), after = parseWith(afterFiles, cfgModel);
    if (after.errors.length) return { error: `rename would change more than the name: ${after.errors[0].msg}` };
    const d = CR.diffModels(model, after);
    const ok = d.rels.length === 0 && (kind === 'ident' ? d.elements.length === 0
      : d.elements.length === 1 && d.elements[0].change === 'changed' && d.elements[0].fields.length === 1 && d.elements[0].fields[0].field === 'name' && d.elements[0].renamedFrom === from);
    if (!ok) { const first = d.elements[0] || d.rels[0]; return { error: `rename would change more than the name: ${first ? `${first.change} ${first.name || first.label}${first.fields && first.fields.length ? ` (${first.fields.map(f => f.field).join(', ')})` : ''}` : 'the model differs'}` }; }
    for (const p of new Set(edits.filter(e => YAML_PATH.test(e.path)).map(e => e.path))) {
      const was = scan(state, p), text = afterFiles[p];
      let parsed; try { parsed = Y.load(text); } catch { return { error: `rename would break ${p}: it no longer parses as YAML` }; }
      const now = yamlRefs(p, text, parsed);
      if (!Array.isArray(now)) return { error: `rename would break ${p}: ${now.error}` };
      const want = was.refs.map(r => [r.key, r.index, touched.has(`${p}:${r.line}:${r.c}`) ? to : r.value]);
      if (JSON.stringify(now.map(r => [r.key, r.index, r.value])) !== JSON.stringify(want)) return { error: `rename would break ${p}: the edited references do not read back` };
    }
    // Which bound decisions the gate will then report as "changed since promotion" (fresh before, different fingerprint after).
    for (const p of yamlPaths(state)) {
      const sc = scan(state, p); if (sc.error || sc.parsed.status !== 'bound' || !Array.isArray(sc.parsed.promoted_against)) continue;
      for (const entry of sc.parsed.promoted_against) {
        if (!entry || typeof entry !== 'object' || typeof entry.hash !== 'string') continue;
        const e0 = CR.resolveBinding(model, entry);
        if (!e0 || CR.fingerprint(model, e0.id).hash !== entry.hash) continue;
        const e1 = e0.id === el.id && kind === 'ident' ? after.elements.get(to) : after.elements.get(e0.id);
        if (e1 && CR.fingerprint(after, e1.id).hash !== entry.hash) rebind.push({ decision: String(sc.parsed.id != null ? sc.parsed.id : p), element: e1.name });
      }
    }
    return { kind, from, to, edits, rebind };
  }

  return { yamlRefs, symbolAt, definition, references, renamePlan, yamlScalar, applyEdits: applyTo, keysFor, _scan: scan, _yamlPaths: yamlPaths, _resolveYaml: resolveYaml, _CR: CR, _DSL: DSL };
})();
if (typeof module !== 'undefined') module.exports = Refactor;
