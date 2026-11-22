// ===== designc core: operation lookup =====
// Part of Core. Dual-loaded like core.js: a classic script in the renderer (after core.js) and required by core.js under Node.
// Pure: reads `files: {path: text}` (registry-relative, forward slashes). "Pinned" = a .yaml/.yml directly in contracts/openapi/.
(Core => {
  const DIR = 'contracts/openapi/';
  const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];
  const isPinned = p => p.startsWith(DIR) && !p.slice(DIR.length).includes('/') && /\.ya?ml$/.test(p);

  function operations({ files = {}, yamlLoad } = {}) {
    const load = yamlLoad || (typeof jsyaml !== 'undefined' ? jsyaml.load : require('js-yaml').load);
    const operations = [], errors = [];
    for (const file of Object.keys(files).filter(isPinned).sort()) {
      let doc;
      try { doc = load(files[file]); } catch (e) {
        const line = e.mark && e.mark.line != null ? ` (line ${e.mark.line + 1})` : '';
        errors.push({ code: 'unreadable', file, message: `${file}${line}: ${e.reason || e.message}` }); continue;
      }
      if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
        errors.push({ code: 'unreadable', file, message: `${file}: expected a mapping at the top level` }); continue;
      }
      if (typeof doc.openapi !== 'string' || !/^3\./.test(doc.openapi)) {
        errors.push({ code: 'not_openapi3', file, message: `${file}: not an OpenAPI 3.x file (missing "openapi: 3.x")` }); continue;
      }
      const found = [];
      for (const [path, item] of Object.entries(doc.paths && typeof doc.paths === 'object' ? doc.paths : {})) {
        if (!item || typeof item !== 'object') continue;
        for (const m of METHODS) {
          const op = item[m];
          if (op && typeof op === 'object' && op.operationId != null && op.operationId !== '')
            found.push({ operationId: String(op.operationId), method: m.toUpperCase(), path, file });
        }
      }
      found.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : METHODS.indexOf(a.method.toLowerCase()) - METHODS.indexOf(b.method.toLowerCase())));
      operations.push(...found);
    }
    const byId = new Map();
    for (const o of operations) { if (!byId.has(o.operationId)) byId.set(o.operationId, []); byId.get(o.operationId).push(o); }
    for (const [operationId, list] of byId) {
      if (list.length < 2) continue;
      const fs = [...new Set(list.map(o => o.file))].sort();
      errors.push({ code: 'duplicate_operation', files: fs, operationId, message: `operationId "${operationId}" is defined more than once (in ${fs.join(', ')})` });
    }
    return { operations, errors };
  }

  function resolveOperation(reg, operationId) {
    const hits = operations(reg).operations.filter(o => o.operationId === operationId);
    return hits.length === 1 ? hits[0] : null;
  }

  // C4b: what a call to the operation takes. null when the operation does not resolve uniquely. One local `#/components/...` $ref
  // is followed per parameter, requestBody and body schema. Header and cookie parameters are ignored.
  function operationInputs(reg, operationId) {
    const op = resolveOperation(reg, operationId);
    if (!op) return null;
    const load = reg.yamlLoad || (typeof jsyaml !== 'undefined' ? jsyaml.load : require('js-yaml').load);
    let doc; try { doc = load(reg.files[op.file]); } catch { return null; }
    const isO = x => x && typeof x === 'object' && !Array.isArray(x);
    const deref = n => {
      if (!isO(n) || typeof n.$ref !== 'string' || !n.$ref.startsWith('#/')) return n;
      let t = doc;
      for (const seg of n.$ref.slice(2).split('/').map(x => x.replace(/~1/g, '/').replace(/~0/g, '~'))) t = isO(t) ? t[seg] : undefined;
      return t === undefined ? n : t;
    };
    const item = doc.paths[op.path], operation = item[op.method.toLowerCase()];
    const params = new Map();
    for (const raw of [...(Array.isArray(item.parameters) ? item.parameters : []), ...(Array.isArray(operation.parameters) ? operation.parameters : [])]) {
      const p = deref(raw);
      if (isO(p) && typeof p.name === 'string' && typeof p.in === 'string') params.set(`${p.in}\0${p.name}`, p);
    }
    const query = [...params.values()].filter(p => p.in === 'query').map(p => ({ name: p.name, required: p.required === true }));
    const path = [...op.path.matchAll(/\{([^}]+)\}/g)].map(m => m[1]);
    let body = null;
    const rb = deref(operation.requestBody);
    if (isO(rb)) {
      body = { required: rb.required === true, mapping: false, properties: null, requiredProps: [], closed: false };
      const content = isO(rb.content) ? rb.content : {};
      const key = 'application/json' in content ? 'application/json' : Object.keys(content).find(k => /^\*\/\*\+json$/.test(k) || /^[^/]+\/[^/]*\+json$/.test(k));
      const sc = key ? deref(isO(content[key]) ? content[key].schema : null) : null;
      if (isO(sc) && !sc.allOf && !sc.oneOf && !sc.anyOf && (sc.type === 'object' || isO(sc.properties))) {
        body.mapping = true;
        body.properties = isO(sc.properties) ? Object.keys(sc.properties) : null;
        body.requiredProps = Array.isArray(sc.required) ? sc.required.filter(x => typeof x === 'string') : [];
        body.closed = body.properties !== null && (sc.additionalProperties === undefined || sc.additionalProperties === false);
      }
    }
    return { path, pathTemplate: op.path, query, body };
  }

  // Events of every pinned pack. packs: [{key, text, load}]. A pack that does not read is skipped (the domain gate reports it).
  function packEvents(packs) {
    const DM = typeof Domain !== 'undefined' ? Domain : require('./domain.js');
    const out = [];
    for (const p of packs || []) {
      const r = DM.read(p.text, p.load, p.key);
      if (r.error || !r.pack) continue;
      const id = r.pack.id || p.key;
      for (const e of r.pack.events) out.push({ pack: id, name: e.name });
    }
    return out.sort((a, b) => (a.pack < b.pack ? -1 : a.pack > b.pack ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  // ref: `pack/Event` (exact) or a bare `Event` that exactly one pack defines.
  function resolveMessage(events, ref) {
    const t = String(ref == null ? '' : ref).trim(), list = events || [];
    if (t.includes('/')) {
      const hit = list.find(e => `${e.pack}/${e.name}` === t);
      return hit ? { event: { pack: hit.pack, name: hit.name } } : { error: `no pinned pack defines event ${t}` };
    }
    const hits = list.filter(e => e.name === t);
    if (hits.length === 1) return { event: { pack: hits[0].pack, name: hits[0].name } };
    if (!hits.length) return { error: `no pinned pack defines event ${t}` };
    const ps = [...new Set(hits.map(h => h.pack))].sort();
    return { error: `${t} is defined by ${ps.join(' and ')}: write ${ps[0]}/${t}` };
  }

  // Aggregates of every pinned pack (C4: the entities example rows name). Refs (another pack's aggregates) are not defined here.
  function packAggregates(packs) {
    const DM = typeof Domain !== 'undefined' ? Domain : require('./domain.js');
    const out = [];
    for (const p of packs || []) {
      const r = DM.read(p.text, p.load, p.key);
      if (r.error || !r.pack) continue;
      const id = r.pack.id || p.key;
      for (const a of r.pack.aggregates) out.push({ pack: id, name: a.name, fields: a.fields, version: r.pack.version });
    }
    return out.sort((a, b) => (a.pack < b.pack ? -1 : a.pack > b.pack ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  // ref: `pack/Aggregate` (exact) or a bare `Aggregate` that exactly one pack defines.
  function resolveEntity(aggs, ref) {
    const t = String(ref == null ? '' : ref).trim(), list = aggs || [];
    if (t.includes('/')) {
      const hit = list.find(e => `${e.pack}/${e.name}` === t);
      return hit ? { entity: hit } : { error: `no pinned pack defines aggregate ${t}` };
    }
    const hits = list.filter(e => e.name === t);
    if (hits.length === 1) return { entity: hits[0] };
    if (!hits.length) return { error: `no pinned pack defines aggregate ${t}` };
    const ps = [...new Set(hits.map(h => h.pack))].sort();
    return { error: `${t} is defined by ${ps.join(' and ')}: write ${ps[0]}/${t}` };
  }

  Object.assign(Core, { operations, resolveOperation, operationInputs, packEvents, resolveMessage, packAggregates, resolveEntity });
})(typeof module === 'object' && typeof require === 'function' ? require('./core.js') : Core);
