'use strict';
// The code-level seam (C4 level 4). Reads every source file of every component through the language scanners
// (interface: scan(file, text) -> {types: [{name, kind, line, endLine, methods[], refs[]}]}), merges partial types per
// component and resolves each reference to a type of the same container by name. A name that two types of one container
// share is reported as unresolved, never guessed. Metrics are not judged here (renderer/quality.js does that).
const cs = require('./code-cs');
const js = require('./code-js');
const fsharp = require('./code-fs');

const keyOf = s => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
const SCANNERS = [{ re: /\.cs$/i, mod: cs }, { re: /\.(?:[cm]?[jt]s|[jt]sx)$/i, mod: js }, { re: /\.fs$/i, mod: fsharp }];
const RANK = { uses: 1, new: 2, inherits: 3 };

async function build({ components, read }) {
  const types = new Map(); // id -> type
  const unresolved = [];
  for (const c of components || []) {
    for (const file of c.files || []) {
      const sc = SCANNERS.find(s => s.re.test(file));
      if (!sc) continue;
      const found = sc.mod.scan(file, await read(file)).types;
      for (const t of found) {
        const id = `t_${c.id}_${t.kind === 'module' ? 'm_' : ''}${keyOf(t.name)}`; // a module and a class of the same name are different types
        let m = types.get(id);
        if (!m) { m = { id, key: keyOf(t.name), name: t.name, kind: t.kind, component: c.id, container: c.container, files: [], methods: [], refs: [] }; types.set(id, m); }
        m.files.push({ file, line: t.line, endLine: t.endLine });
        m.methods.push(...t.methods);
        m.refs.push(...t.refs.map(r => ({ ...r, file })));
      }
    }
  }
  // resolve within a container
  const byName = new Map(); // "container|key" -> [type]
  for (const t of types.values()) { const k = `${t.container}|${t.key}`; (byName.get(k) || byName.set(k, []).get(k)).push(t); }
  const edges = new Map();
  const warned = new Set();
  for (const t of types.values()) {
    for (const r of t.refs) {
      // an import names a module; every other reference names a type
      const cands = (byName.get(`${t.container}|${keyOf(r.name)}`) || []).filter(x => (x.kind === 'module') === !!r.module);
      if (!cands.length) continue;
      if (cands.length > 1) {
        const w = `${t.container}|${r.name}`;
        if (!warned.has(w)) { warned.add(w); unresolved.push({ where: t.container, what: `type name "${r.name}" is declared ${cands.length} times in this container, so references to it were not linked`, file: r.file, line: r.line, text: r.name }); }
        continue;
      }
      const to = cands[0];
      if (to.id === t.id) continue;
      const k = `${t.id}>${to.id}`, e = edges.get(k);
      if (!e || RANK[r.via] > RANK[e.via]) edges.set(k, { from: t.id, to: to.id, via: r.via, evidence: { file: r.file, line: r.line } });
    }
  }
  const out = [...types.values()].map(({ refs, ...t }) => t);
  return { types: out, typeEdges: [...edges.values()], unresolved };
}

module.exports = { build };
