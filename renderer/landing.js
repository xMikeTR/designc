/* designc desktop: the change layer. Pure, no I/O.
   Dual-load like renderer/work.js: <script src="landing.js"> in the renderer, require('./renderer/landing.js') from tests.
   A landing is landings/<requirement>.yaml: one requirement's in-progress change, laid over the code map like a layer in a
   drawing app. It holds where the change enters, the path UI -> API -> handler -> store, and the change points. Every
   place a landing names is a node string:
     <container>                       a container (a store is one)
     <container>/<name>                a component, or a code type of that container (a container name may itself hold a slash,
                                       like a scoped package @org/ui: the longest real container name that fits wins)
     <container>/<METHOD> <route>      an HTTP endpoint (ANY when the method is unknown); the route may contain slashes
     <that>#handler                    the endpoint's handler (an inline span, or the named type)
   This module indexes the as-built model, code types and endpoints, resolves a node to what it is on the map (mapped, new,
   or ambiguous: it never guesses between two), validates a record, computes what a view level draws, and holds the edits. */
const Landing = (() => {
  const CORE = typeof Core !== 'undefined' ? Core : (typeof require !== 'undefined' ? require('./core.js') : null);
  const UI = typeof Ui !== 'undefined' ? Ui : (typeof require !== 'undefined' ? require('./ui.js') : null); // sha256 and canon: the helpers ui_preview_approved hashes with
  const ENTRY_KINDS = ['screen', 'action', 'endpoint'];
  const STAGES = ['ui', 'api', 'handler', 'store'];
  const AUTHORS = ['agent', 'human'];
  const STATUSES = ['proposed', 'approved'];
  const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'ANY'];
  const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
  // How a landing is drawn over a dependency: accent, thick, dashed, numbered. Nothing else on the map looks like it.
  const EDGE_STYLE = { color: 'var(--accent)', width: 3, dash: '9 4' };

  const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
  const str = v => (v == null ? '' : String(v)).trim();
  const list = v => (Array.isArray(v) ? v : []);
  const trunc = (s, n) => (String(s).length > n ? String(s).slice(0, n - 1) + '…' : String(s));
  const values = c => (c instanceof Map ? [...c.values()] : Array.isArray(c) ? c : []);

  // The registry file for a requirement id, or null when the id is not safe to build a path from.
  const safeId = id => typeof id === 'string' && SAFE_ID.test(id) && !id.includes('..');
  const fileFor = req => (safeId(req) ? `landings/${req}.yaml` : null);
  const baseName = file => String(file || '').replace(/\\/g, '/').split('/').pop().replace(/\.ya?ml$/i, '');

  // ---------- the node index ----------
  // model: a parsed model (elements Map); facts: the extraction facts (code.types, endpoints). Neither is kept by reference
  // beyond reads, and neither is ever written.
  function buildIndex(model, facts) {
    const els = new Map(values(model && model.elements).map(e => [e.id, e]));
    const containers = new Map(), compsOf = new Map(), typesOf = new Map();
    let system = null;
    for (const e of els.values()) {
      if (e.kind === 'softwareSystem' && !(e.tags && e.tags.has && e.tags.has('External')) && !system) system = e.id;
      if (e.kind === 'container') { if (!containers.has(e.name)) containers.set(e.name, []); containers.get(e.name).push(e); }
      if (e.kind === 'component') { if (!compsOf.has(e.parent)) compsOf.set(e.parent, []); compsOf.get(e.parent).push(e); }
    }
    const f = facts || {};
    for (const t of list(f.code && f.code.types)) { if (!typesOf.has(t.component)) typesOf.set(t.component, []); typesOf.get(t.component).push(t); }
    const endpoints = list(f.endpoints);
    return { els, containers, compsOf, typesOf, endpoints, system };
  }

  const routeKey = r => String(r == null ? '' : r).trim().replace(/\{[^}]*\}/g, '{}').replace(/(^|\/):[^/]+/g, '$1{}').replace(/\/+$/, '') || '/';
  const containerById = (idx, id) => idx.els.get(id) || null;
  const methodOf = ep => String(ep.method || 'ANY').toUpperCase();
  const endpointLabel = ep => `${methodOf(ep)} ${ep.route}`;
  const nameOfEndpoint = endpointLabel;

  const mapped = (idx, node, o) => ({ status: 'mapped', node, kind: o.kind, container: o.container || null, component: o.component || null, type: o.type || null, endpoint: o.endpoint || null, newContainer: false });
  const novel = (node, newContainer, extra = {}) => ({ status: 'new', node, kind: null, container: null, component: null, type: null, endpoint: null, newContainer, ...extra });
  // Split a node into its container name and the rest. The longest real container name that is the whole node or is followed
  // by '/' wins (a scoped package such as @org/ui is a container name). Otherwise the container is new: its name is the part
  // before the first '/', or before the second for a scoped name (@org/name).
  function splitNode(idx, base) {
    let best = null;
    for (const name of idx.containers.keys()) if ((base === name || base.startsWith(name + '/')) && (!best || name.length > best.length)) best = name;
    if (best) return { cname: best, rest: base === best ? null : base.slice(best.length + 1) };
    const parts = base.split('/'), n = base.startsWith('@') && parts.length > 1 ? 2 : 1;
    return { cname: parts.slice(0, n).join('/'), rest: parts.length > n ? parts.slice(n).join('/') : null };
  }

  function endpointResult(idx, node, ep, c, wantHandler) {
    if (!wantHandler) return mapped(idx, node, { kind: 'endpoint', container: c.id, component: ep.component, endpoint: ep.id });
    if (!ep.handler) return novel(node, false, { containerName: c.name, rest: null });
    if (ep.handler.kind === 'inline') return mapped(idx, node, { kind: 'handler', container: c.id, component: ep.component, endpoint: ep.id });
    const named = resolve(idx, ep.handler.node);
    return named.status === 'mapped' ? { ...named, node, endpoint: ep.id } : named;
  }

  // Resolve a node string. Never guesses: two equally good answers are ambiguous, with their candidates listed.
  function resolve(idx, nodeIn) {
    const node = str(nodeIn);
    if (!node) return novel(node, false);
    const wantHandler = node.endsWith('#handler');
    const base = wantHandler ? node.slice(0, -'#handler'.length) : node;
    const { cname, rest } = splitNode(idx, base);
    const cands = idx.containers.get(cname) || [];
    if (cands.length > 1) return { ...novel(node, false), status: 'ambiguous', candidates: cands.map(c => c.id) };
    if (!cands.length) return novel(node, true, { containerName: cname, rest });
    const c = cands[0];
    if (rest === null) return wantHandler ? novel(node, false) : mapped(idx, node, { kind: 'container', container: c.id });
    const m = /^([A-Za-z]+)\s+(\S.*)$/.exec(rest);
    if (m && METHODS.includes(m[1].toUpperCase())) {
      const method = m[1].toUpperCase(), route = routeKey(m[2]);
      const mine = idx.endpoints.filter(e => e.container === c.name && routeKey(e.route) === route);
      let hit = mine.filter(e => methodOf(e) === method);
      if (method === 'ANY' && !hit.length) hit = mine;
      if (hit.length === 1) return endpointResult(idx, node, hit[0], c, wantHandler);
      if (hit.length > 1) return { ...novel(node, false), status: 'ambiguous', candidates: hit.map(e => e.node) };
      return novel(node, false, { containerName: c.name, rest });
    }
    if (wantHandler) return novel(node, false, { containerName: c.name, rest });
    // Exactly one component of that name always wins over types of that name. Two components, or two types and no
    // component, are ambiguous: never a guess.
    const comps = (idx.compsOf.get(c.id) || []).filter(e => e.name === rest);
    if (comps.length > 1) return { ...novel(node, false), status: 'ambiguous', candidates: comps.map(e => e.id) };
    if (comps.length === 1) return mapped(idx, node, { kind: 'component', container: c.id, component: comps[0].id });
    const types = new Map();
    for (const comp of idx.compsOf.get(c.id) || []) for (const t of idx.typesOf.get(comp.id) || []) if (t.name === rest || t.key === rest) types.set(t.id, t);
    const ts = [...types.values()];
    if (ts.length > 1) return { ...novel(node, false), status: 'ambiguous', candidates: ts.map(t => t.id) };
    if (!ts.length) return novel(node, false, { containerName: c.name, rest });
    return mapped(idx, node, { kind: 'type', container: c.id, component: ts[0].component, type: ts[0].id });
  }

  // The endpoints (with their handler) listed for the selected container or component.
  function endpointsOf(idx, { container = null, component = null } = {}) {
    const c = container ? idx.els.get(container) : null;
    return idx.endpoints.filter(e => (component ? e.component === component : c ? e.container === c.name : false));
  }
  const endpointNode = ep => ep.node;
  const handlerNode = ep => (ep.handler ? (ep.handler.kind === 'inline' ? ep.handler.node : ep.handler.node) : null);
  // The node string for a selected box id: a container, a component, or a code type. It must resolve back to that same box
  // (by name, else for a type by its key); when nothing does, it hands back null, never another box's node.
  function nodeOfBox(idx, id) {
    const e = idx.els.get(id);
    let cands = [], back;
    if (e && e.kind === 'container') { cands = [e.name]; back = r => r.kind === 'container' && r.container === id; }
    else if (e && e.kind === 'component') { const c = idx.els.get(e.parent); if (c) cands = [`${c.name}/${e.name}`]; back = r => r.kind === 'component' && r.component === id; }
    else if (!e) {
      for (const [compId, ts] of idx.typesOf) {
        const t = ts.find(x => x.id === id); if (!t) continue;
        const comp = idx.els.get(compId), c = comp && idx.els.get(comp.parent);
        if (c) cands = [...new Set([`${c.name}/${t.name}`, `${c.name}/${t.key}`])];
        back = r => r.kind === 'type' && r.type === id;
        break;
      }
    }
    for (const n of cands) { const r = resolve(idx, n); if (r.status === 'mapped' && back(r)) return n; }
    return null;
  }

  // ---------- records ----------
  function validate(rec, { file = null } = {}) {
    const out = [];
    if (!isObj(rec)) return ['The landing is not a mapping.'];
    const req = rec.requirement;
    if (req == null || !str(req)) out.push('requirement is missing.');
    else if (typeof req !== 'string' || !safeId(req)) out.push(`requirement ${JSON.stringify(req)} is not a safe id (letters, digits, dot, dash, underscore).`);
    else if (file != null && baseName(file) !== req) out.push(`file name ${baseName(file)} must equal the requirement ${req}.`);
    if (req == null || !str(req) ? file != null && !safeId(baseName(file)) : false) out.push(`file name ${baseName(file)} is not a safe id.`);
    if (!AUTHORS.includes(rec.author)) out.push(`author must be ${AUTHORS.join(' or ')}.`);
    if (!STATUSES.includes(rec.status)) out.push(`status must be ${STATUSES.join(' or ')}.`);
    if (rec.entry != null) {
      if (!isObj(rec.entry)) out.push('entry must be a mapping with kind and node.');
      else {
        if (!ENTRY_KINDS.includes(rec.entry.kind)) out.push(`entry kind must be ${ENTRY_KINDS.join(', ')}.`);
        if (!str(rec.entry.node)) out.push('entry node is empty.');
      }
    }
    if (rec.path != null) {
      if (!Array.isArray(rec.path)) out.push('path must be a list of steps.');
      else rec.path.forEach((s, i) => {
        if (!isObj(s)) { out.push(`path[${i + 1}]: a step is a mapping with stage and node.`); return; }
        if (!STAGES.includes(s.stage)) out.push(`path[${i + 1}]: stage must be ${STAGES.join(', ')}.`);
        if (!str(s.node)) out.push(`path[${i + 1}]: node is empty.`);
      });
    }
    if (rec.changes != null) {
      if (!Array.isArray(rec.changes)) out.push('changes must be a list.');
      else rec.changes.forEach((c, i) => {
        if (!isObj(c)) { out.push(`changes[${i + 1}]: a change is a mapping with node and what.`); return; }
        if (!str(c.node)) out.push(`changes[${i + 1}]: node is empty.`);
        if (!str(c.what)) out.push(`changes[${i + 1}]: what is empty.`);
      });
    }
    for (const k of ['principle', 'proposed', 'correction', 'approved']) if (rec[k] != null && !isObj(rec[k])) out.push(`${k} must be a mapping.`);
    return out;
  }
  // A record with the optional fields filled in. Unknown keys are kept. Does not validate.
  const normalize = rec => ({ ...rec, entry: isObj(rec.entry) ? rec.entry : null, path: list(rec.path), changes: list(rec.changes) });
  // Read one landings/ file. Never throws: a bad file comes back with errors and no record.
  function parseFile(file, text, yamlLoad) {
    let o;
    try { o = yamlLoad(text); } catch (e) { return { path: file, record: null, errors: [`not valid YAML: ${(e && (e.reason || e.message)) || e}`], text }; }
    if (!isObj(o)) return { path: file, record: null, errors: ['expected a mapping at the top level.'], text };
    const errors = validate(o, { file });
    return { path: file, record: errors.length ? null : normalize(o), errors, text, requirement: typeof o.requirement === 'string' ? o.requirement : baseName(file) };
  }
  const newRecord = req => ({ requirement: req, author: 'human', status: 'proposed', entry: null, path: [], changes: [], principle: null, proposed: {}, correction: {}, approved: {} });
  const editable = rec => !!rec && rec.author === 'human';
  // With the ledger, the status is what approvalState says; without one an approval cannot be checked and is said so.
  const statusText = (rec, ledger) => {
    if (ledger === undefined) return `${rec.author || '?'}, ${rec.status || '?'}${rec.status === 'approved' ? ' (approval not verified: designc does not check this approval yet)' : ''}`;
    const a = approvalState(rec, ledger);
    return `${rec.author || '?'}, ${a.state}${a.reason ? ` (${a.reason})` : ''}`;
  };

  // ---------- edits (pure; every edit empties approved) ----------
  const cleared = rec => ({ ...rec, status: 'proposed', approved: {} });
  const isStoreEl = e => !!e && ((e.props && e.props['d.store'] != null ? String(e.props['d.store']) === 'yes' : false) || (e.tags && e.tags.has && e.tags.has('Database')));
  const isUiEl = e => !!e && /react|vue|angular|svelte|\bspa\b|vite|next\.?js|front-?end/i.test(String(e.technology || ''));
  function defaultStage(idx, node, rec) {
    const r = resolve(idx, node);
    if (r.status === 'mapped') {
      const c = idx.els.get(r.container);
      if (r.kind === 'endpoint') return 'api';
      if (r.kind === 'handler') return 'handler';
      if (isStoreEl(c)) return 'store';
      if (isUiEl(c)) return 'ui';
      return r.kind === 'container' ? 'api' : 'handler';
    }
    const last = list(rec && rec.path).slice(-1)[0];
    const i = last && STAGES.includes(last.stage) ? STAGES.indexOf(last.stage) : -1;
    return STAGES[Math.min(STAGES.length - 1, i + 1)];
  }
  function entryKind(idx, node) {
    const r = resolve(idx, node);
    if (r.status === 'mapped') {
      if (r.kind === 'endpoint' || r.kind === 'handler') return 'endpoint';
      if (isUiEl(idx.els.get(r.container))) return 'screen';
    }
    return 'action';
  }
  function setEntry(idx, rec, node, kind) {
    const n = str(node); if (!n) return rec;
    return cleared({ ...rec, entry: { kind: ENTRY_KINDS.includes(kind) ? kind : entryKind(idx, n), node: n } });
  }
  function addStep(idx, rec, node, stage) {
    const n = str(node); if (!n) return rec;
    const st = STAGES.includes(stage) ? stage : defaultStage(idx, n, rec);
    const next = cleared({ ...rec, path: [...list(rec.path), { stage: st, node: n }] });
    return rec.entry ? next : { ...next, entry: { kind: entryKind(idx, n), node: n } };
  }
  const removeStep = (rec, i) => (i >= 0 && i < list(rec.path).length ? cleared({ ...rec, path: list(rec.path).filter((_, j) => j !== i) }) : rec);
  function addChange(rec, node, what) {
    const n = str(node), w = str(what); if (!n || !w) return rec;
    return cleared({ ...rec, changes: [...list(rec.changes), { node: n, what: w }] });
  }
  const removeChange = (rec, i) => (i >= 0 && i < list(rec.changes).length ? cleared({ ...rec, changes: list(rec.changes).filter((_, j) => j !== i) }) : rec);
  const clearEntry = rec => (rec.entry ? cleared({ ...rec, entry: null }) : rec);

  // ---------- save ----------
  // What a save would write, or why it must not. loadedText: the file's text when the layer was loaded (null when new);
  // currentText: what is on disk now (null when absent). A person's save never overwrites a file that changed meanwhile.
  // file: the path the layer was loaded from (landings/<id>.yaml or .yml), so a .yml saves back to itself; null for a new one.
  function saveFile(req, loaded) {
    if (loaded == null) return fileFor(req);
    const m = /^landings\/([^/\\]+)\.(yaml|yml)$/.exec(String(loaded));
    return m && safeId(req) && m[1] === req ? String(loaded) : null;
  }
  function prepareSave({ draft, loadedText = null, currentText = null, yaml, file: loadedFile = null }) {
    const file = saveFile(draft && draft.requirement, loadedFile);
    if (!file) return { ok: false, error: 'The requirement id is not safe to use as a file name.' };
    if (loadedText == null && currentText != null) return { ok: false, error: `${file} appeared since this layer was loaded. Reload the layer before saving.` };
    if (loadedText != null && currentText == null) return { ok: false, error: `${file} was removed since this layer was loaded. Reload the layer before saving.` };
    if (loadedText != null && currentText !== loadedText) return { ok: false, error: `${file} changed on disk since this layer was loaded. Reload the layer before saving.` };
    const rec = { ...draft, author: 'human', status: 'proposed', approved: {} };
    if (rec.entry == null) delete rec.entry;
    if (rec.principle == null) delete rec.principle;
    const errors = validate(rec, { file });
    if (errors.length) return { ok: false, error: errors.join(' ') };
    const text = yaml.dump(rec, { lineWidth: -1, noRefs: true, sortKeys: false });
    return { ok: true, path: file, text: text.endsWith('\n') ? text : text + '\n', record: rec };
  }

  // ---------- the layer for one view level ----------
  const OWN_LABEL = { endpoint: 'Endpoint', handler: 'Handler', new: 'Not on the map', container: 'Not on the map' };
  const HIDDEN = 'not shown at this level', NEWTXT = 'not on the map', AMBIG = 'ambiguous, not drawn';
  // view: the view model drawn at this level (its elements say which boxes exist); opts.scope: the container or component the
  // view is scoped to, when it is. Returns
  //   items   every line of the landing in order, each with its resolution and a mark when it is not drawn as a box
  //   boxes   Map box id -> notes, for boxes already on the map
  //   own     boxes the layer adds (dashed): endpoints, inline handlers and new nodes at Components, a new container at Containers
  //   edges   the path's consecutive steps, as {from, to, n, label} between boxes
  function layerFor(idx, rec, level, view, opts = {}) {
    const ids = new Set(values(view && view.elements).map(e => e.id));
    const parentOf = id => { const e = view.elements.get(id); return e ? e.parent : null; };
    // a container can hold the layer's own boxes when the view holds a component of it; unscoped, every container in the view can,
    // and a scoped view's own container can even with no components. Containers outside the scope never do.
    const open = new Set(values(view && view.elements).filter(e => e.kind === 'component').map(e => e.parent));
    if (!opts.scope) values(view && view.elements).filter(e => e.kind === 'container').forEach(e => open.add(e.id));
    else { const sc = view && view.elements.get(opts.scope); if (sc && sc.kind === 'container') open.add(sc.id); }
    const items = [];
    if (rec.entry) items.push({ role: 'entry', kind: rec.entry.kind, node: rec.entry.node });
    list(rec.path).forEach((s, i) => items.push({ role: 'path', i, n: i + 1, stage: s.stage, node: s.node }));
    list(rec.changes).forEach((c, i) => items.push({ role: 'change', i, what: c.what, node: c.node }));
    const noteOf = it => (it.role === 'entry' ? { role: 'entry', text: `Entry (${it.kind})` } : it.role === 'path' ? { role: 'path', n: it.n, stage: it.stage, text: `Path ${it.n}: ${it.stage}` } : { role: 'change', text: `Change: ${it.what}` });
    const boxes = new Map(), ownMap = new Map();
    const system = idx.system && ids.has(idx.system) ? idx.system : null;
    const own = (key, spec) => { if (!ownMap.has(key)) ownMap.set(key, { id: `layer:${key}`, key, notes: [], ...spec }); return ownMap.get(key); };
    const showsContainerBoxes = level === 'component' || level === 'container';
    const ownContainer = (name) => own(`nc:${name}`, { kind: 'container', name, parent: system, notOnMap: true, node: name });
    const firstVisible = chain => chain.find(id => id && ids.has(id)) || null;
    const place = it => {
      const r = it.res = resolve(idx, it.node);
      if (level === 'code') {
        const t = r.type && ids.has(r.type) ? r.type : null;
        return t ? { box: t } : null;
      }
      if (r.status === 'new') {
        const cname = r.containerName != null ? r.containerName : String(r.node).split('/')[0];
        const nm = r.rest != null ? r.rest : String(r.node);
        if (r.newContainer) {
          if (!showsContainerBoxes) return system ? { box: system } : null;
          if (level === 'component' && opts.scope) return null; // a scoped view is not the place for a new container
          const oc = ownContainer(cname);
          if (level === 'container' || r.rest == null) return { own: oc };
          return { own: own(`new:${r.node}`, { kind: 'new', name: nm, parent: oc.id, notOnMap: true, node: r.node }) };
        }
        const cont = (idx.containers.get(cname) || [])[0];
        if (level === 'component') {
          if (!cont || !open.has(cont.id)) return null;
          return { own: own(`new:${r.node}`, { kind: 'new', name: nm, parent: cont.id, notOnMap: true, node: r.node }) };
        }
        return cont ? { box: firstVisible([cont.id]) } : null;
      }
      if (r.status === 'ambiguous') return null;
      if (level === 'component' && (r.kind === 'endpoint' || r.kind === 'handler') && r.endpoint) {
        if (!open.has(r.container)) return null; // outside the scope of this view: not drawn, never floating
        const ep = idx.endpoints.find(e => e.id === r.endpoint);
        if (r.kind === 'endpoint') return { own: own(`ep:${ep.id}`, { kind: 'endpoint', name: nameOfEndpoint(ep), parent: r.container, notOnMap: false, node: ep.node }) };
        return { own: own(`h:${ep.id}`, { kind: 'handler', name: `handler ${nameOfEndpoint(ep)}`, parent: r.container, notOnMap: false, node: `${ep.node}#handler` }) };
      }
      const chain = [r.type, r.component, r.container];
      for (let p = parentOf(r.container); p; p = parentOf(p)) chain.push(p);
      if (system) chain.push(system);
      return { box: firstVisible(chain) };
    };
    const where = new Map();
    for (const it of items) {
      const p = place(it);
      const r = it.res;
      const drawn = !!(p && (p.own || p.box));
      it.mark = r.status === 'ambiguous' ? AMBIG : r.status === 'new' ? (drawn || level === 'code' ? NEWTXT : `${NEWTXT}, ${HIDDEN}`) : drawn ? null : HIDDEN;
      if (!drawn) { where.set(it, null); continue; }
      const note = noteOf(it);
      if (p.own) { p.own.notes.push(note); where.set(it, p.own.id); }
      else { if (!boxes.has(p.box)) boxes.set(p.box, []); boxes.get(p.box).push(note); where.set(it, p.box); }
    }
    const ownList = [...ownMap.values()].sort((a, b) => (a.kind === 'container' ? 0 : 1) - (b.kind === 'container' ? 0 : 1));
    const steps = items.filter(i => i.role === 'path');
    const edges = [];
    for (let k = 0; k + 1 < steps.length; k++) {
      const a = where.get(steps[k]), b = where.get(steps[k + 1]);
      if (a && b && a !== b) edges.push({ from: a, to: b, n: steps[k].n, label: `${steps[k].stage} → ${steps[k + 1].stage}` });
    }
    return { level, items, boxes, own: ownList, edges, where };
  }

  // ---------- approval and correction (S4 A, C; D8, D9) ----------
  // The note's content: what a person approves. Not who drew it, its status or the approval itself.
  const contentOf = rec => ({ entry: isObj(rec.entry) ? rec.entry : null, path: list(rec.path), changes: list(rec.changes), principle: isObj(rec.principle) ? rec.principle : null });
  const asJson = v => JSON.parse(JSON.stringify(v));
  const contentHash = rec => UI.sha256(UI.canon(asJson({ requirement: rec.requirement == null ? null : rec.requirement, ...contentOf(rec), proposed: isObj(rec.proposed) ? rec.proposed : {}, correction: isObj(rec.correction) ? rec.correction : {} })));
  // approved only when the file says so, its hash is the content's hash AND the ledger holds a landing_approved row with it.
  function approvalState(rec, ledger) {
    if (!rec || rec.status !== 'approved') return { state: 'proposed', reason: null };
    const a = isObj(rec.approved) ? rec.approved : {};
    if (!a.hash) return { state: 'proposed', reason: 'no approval recorded' };
    const h = contentHash(rec);
    if (a.hash !== h) return { state: 'proposed', reason: 'edited after approval' };
    const row = list(ledger).some(e => e && e.kind === 'landing_approved' && e.requirement === rec.requirement && e.hash === h);
    return row ? { state: 'approved', reason: null } : { state: 'proposed', reason: 'no approval recorded' };
  }
  const isApproved = (rec, ledger) => approvalState(rec, ledger).state === 'approved';
  const effectCounts = e => ({ callers: list(e && e.callers).length, readers: list(e && e.readers).length, consumers: list(e && e.consumers).length, unknown: list(e && e.unknown).length });
  // An agent note is read-only; Correct makes the person's editable copy. proposed keeps the agent's version (once set, it stays).
  const correct = rec => ({ ...rec, author: 'human', status: 'proposed', approved: {}, proposed: isObj(rec.proposed) && Object.keys(rec.proposed).length ? rec.proposed : asJson(contentOf(rec)) });
  const proposedContent = rec => { const p = isObj(rec.proposed) ? rec.proposed : {}; return Object.keys(p).length ? contentOf(p) : null; };
  const corrected = rec => { const p = proposedContent(rec); return !!p && UI.canon(asJson(p)) !== UI.canon(asJson(contentOf(rec))); };
  const PRINCIPLE_PROPS = ['d.style', 'd.api', 'd.ui'];
  // null when the correction is valid, else why not. Principle: the person edited the model, so the element now has the value.
  // Proposal: proposals/<id>.yaml exists with kind lint rule.
  function correctionProblem(rec, { model, proposals } = {}) {
    const c = isObj(rec.correction) ? rec.correction : {};
    const p = c.principle, id = c.proposal;
    if (isObj(p)) {
      if (!PRINCIPLE_PROPS.includes(p.prop)) return `correction principle prop must be ${PRINCIPLE_PROPS.join(', ')}.`;
      const el = model && [...values(model.elements)].find(e => e.id === p.element || e.name === p.element);
      if (!el) return `correction principle: ${str(p.element) || 'no element'} is not in the model.`;
      return CORE.principle(model, el.id, p.prop).value != null ? null : `${p.prop} is not set on ${el.name} in the model yet: edit the model first.`;
    }
    if (id) return list(proposals).some(x => x && x.id === id && x.kind === 'lint rule') ? null : `proposals/${id}.yaml does not exist as a lint rule.`;
    return 'a corrected note needs a correction: a principle in the model or a lint rule proposal.';
  }
  const approvable = (rec, { model, proposals } = {}) => {
    const errors = validate(rec);
    if (errors.length) return { ok: false, why: errors.join(' ') };
    if (corrected(rec)) { const why = correctionProblem(rec, { model, proposals }); if (why) return { ok: false, why }; }
    return { ok: true, why: null };
  };
  // What Approve would write and record, or why it must not. The note must be saved (loadedText is what the layer loaded, currentText
  // what is on disk) and valid; a corrected one needs its correction. The ledger row is recorded by the UI after the file is written.
  function prepareApprove({ rec, loadedText = null, currentText = null, yaml, file = null, by, at, mapCommit = null, effects, model, proposals }) {
    const path = file && saveFile(rec && rec.requirement, file);
    if (!path || loadedText == null) return { ok: false, error: 'Save the note first: only a saved note can be approved.' };
    if (currentText !== loadedText) return { ok: false, error: `${path} changed on disk since this layer was loaded. Reload the layer before approving.` };
    const can = approvable(rec, { model, proposals });
    if (!can.ok) return { ok: false, error: can.why };
    const hash = contentHash(rec), isCorrected = corrected(rec);
    const next = { ...rec, status: 'approved', approved: { by, at, hash, map_commit: mapCommit == null ? null : mapCommit, effects: effectCounts(effects) } };
    if (next.entry == null) delete next.entry;
    if (next.principle == null) delete next.principle;
    const text = yaml.dump(next, { lineWidth: -1, noRefs: true, sortKeys: false });
    const ledgerRow = { requirement: rec.requirement, hash, author: rec.author, corrected: isCorrected, ...(isCorrected ? { correction: rec.correction } : {}) };
    return { ok: true, path, text: text.endsWith('\n') ? text : text + '\n', record: next, ledgerRow };
  }
  // A lint rule proposal drafted from the difference between what the agent proposed and what the person has now. Same fields and
  // id helper as the mint_proposal handler. null when the note is not corrected.
  function draftProposal(rec, { taken = [] } = {}) {
    if (!corrected(rec)) return null;
    const was = proposedContent(rec), now = contentOf(rec);
    const diff = ['entry', 'path', 'changes', 'principle'].filter(k => UI.canon(asJson(was[k] == null ? (k === 'path' || k === 'changes' ? [] : null) : was[k])) !== UI.canon(asJson(now[k] == null ? (k === 'path' || k === 'changes' ? [] : null) : now[k])));
    const statement = `Landing ${rec.requirement} was corrected by a person (${diff.join(', ')}): proposals like it should land where the person put it`;
    const evidence = `landings/${rec.requirement}.yaml: ` + diff.map(k => `${k}: agent ${JSON.stringify(was[k] == null ? null : was[k])}, person ${JSON.stringify(now[k] == null ? null : now[k])}`).join('; ');
    const id = CORE.slugId(statement, new Set(taken));
    const q = s => JSON.stringify(String(s || ''));
    return { id, path: `proposals/${id}.yaml`, text: `id: ${id}\nstatus: minted\nkind: ${q('lint rule')}\nevidence: ${q(evidence)}\nstatement: ${q(statement)}\ncheck: ${q('TODO')}\ndrafted_by: designc\n` };
  }

  // ---------- what an agent may propose (S4 T, D1, D5) ----------
  // The refusals are decided here, in this order, each an {error}; the prompt is never the guard. args are the tool's arguments: only
  // requirement, entry, path, changes and principle are read, so a status, an author or an approval in them goes nowhere.
  // ctx: requirements (registry), idx (as-built index), model (the design), toDesign (Map as-built container id -> design element,
  // Core.driftModels), existing (the landing now on disk or null), ledger.
  function proposalCheck(args, { requirements, idx, model, toDesign, existing = null, ledger = [] } = {}) {
    const a = isObj(args) ? args : {};
    const req = list(requirements).find(r => r && String(r.id) === String(a.requirement));
    if (!req) return { error: `Requirement ${a.requirement} is not in the registry. Agents never create requirements.` };
    if (existing && (existing.author === 'human' || isApproved(existing, ledger))) return { error: `${req.id}: a person has drawn this one. Do not propose over it; review it with review_landing instead.` };
    const rec = { requirement: String(req.id), author: 'agent', status: 'proposed', entry: isObj(a.entry) ? a.entry : null, path: list(a.path), changes: list(a.changes) };
    if (isObj(a.principle)) rec.principle = a.principle;
    const problems = validate(rec, { file: fileFor(rec.requirement) });
    if (problems.length) return { error: `The proposal is not valid: ${problems.join(' ')}` };
    const nodes = [...(rec.entry ? [rec.entry.node] : []), ...rec.path.map(s => s.node), ...rec.changes.map(c => c.node)];
    const resolved = nodes.map(n => ({ node: n, res: resolve(idx, n) }));
    for (const { node, res } of resolved) if (res.status !== 'mapped') return { error: `${node} is ${res.status === 'ambiguous' ? 'ambiguous' : 'new'}: draw this one yourself.` };
    const elementNames = list(req.elements);
    if (!elementNames.length) return { error: `${req.id} lists no elements: map the requirement first, then propose.` };
    const els = [...values(model && model.elements)];
    const high = el => { for (let c = el; c; c = c.parent && model.elements.get(c.parent)) if (CORE.get(c, 'd.risk') === 'high') return c; return null; };
    for (const n of elementNames) { const el = els.find(e => e.name === n || e.id === n); const h = el && high(el); if (h) return { error: `${h.name} is high-risk: draw this one yourself.` }; }
    for (const { node, res } of resolved) {
      const d = toDesign && toDesign.get(res.container);
      if (!d) return { error: `${node} is new: draw this one yourself (its container is not in the design).` };
      const h = high(d); if (h) return { error: `${h.name} is high-risk: draw this one yourself.` };
    }
    const full = { ...rec, entry: rec.entry };
    return { record: { ...full, principle: rec.principle || null, proposed: asJson(contentOf({ ...full, principle: rec.principle || null })), correction: {}, approved: {} } };
  }
  // A review is kept in memory against the note's content hash, so an edit hides it. Not persisted.
  function reviewCheck(args, { existing } = {}) {
    const a = isObj(args) ? args : {};
    if (!existing) return { error: `There is no landing note for ${a.requirement} to review. Only an existing note is reviewed.` };
    const fs_ = list(a.findings);
    if (!fs_.length) return { error: 'findings is empty. Give at least one finding with its text.' };
    if (fs_.some(f => !isObj(f) || !str(f.text))) return { error: 'Every finding needs text.' };
    return { review: { hash: contentHash(existing), findings: fs_.map(f => (str(f.node) ? { node: str(f.node), text: str(f.text) } : { text: str(f.text) })) } };
  }
  const reviewFor = (reviews, req, rec) => { const r = reviews && reviews[req]; return r && rec && r.hash === contentHash(rec) ? r.findings : null; };

  // ---------- effects (S4 E, D6) ----------
  // What a landing touches beyond its own nodes, read off the as-built model: never written by anyone. Each change node starts
  // at its component (a named handler's type's component; an inline handler's enclosing component, else the container) and the
  // parent container's callers are added (marked via 'container': the extractor often draws calls at container level only).
  // One hop forward, never further: readers of a store, consumers over async rels. An undeclared interaction, a node that is
  // not on the code map and a start with nothing found at all are `unknown` rows, never a bare "affects nothing".
  function effects(idx, model, rec) {
    const els = model.elements, nm = id => (els.get(id) || {}).name || id;
    const callers = new Map(), readers = new Map(), consumers = new Map(), unknown = new Map();
    const addUnknown = (node, why) => unknown.set(`${node}\0${why}`, { node, why });
    const related = (a, b) => a === b || model.isAncestor(a, b) || model.isAncestor(b, a);
    const outgoing = id => model.rels.filter(r => r.src === id && !CORE._shared.structural(model, r));
    for (const ch of list(rec && rec.changes)) {
      const node = str(ch && ch.node), r = resolve(idx, node);
      const start = r.status === 'mapped' ? (r.type || r.component || r.container) : null;
      const S = start && els.has(start) ? start : (r.status === 'mapped' && els.has(r.container) ? r.container : null);
      if (!S) { addUnknown(node, 'not on the code map'); continue; }
      const C = els.get(S).kind === 'component' && els.get(S).parent && els.has(els.get(S).parent) ? els.get(S).parent : null;
      const found = { callers: 0, readers: 0, consumers: 0 };
      const callersOf = (id, via) => {
        const b = CORE.blastRadius(model, id, { mode: 'misbehaves' });
        for (const x of [...b.down, ...b.degraded, ...b.unknown]) {
          if (related(x.id, S) || (C && related(x.id, C))) continue;
          const had = callers.get(x.id);
          if (had && (had.via === 'component' || via === 'container')) continue;
          callers.set(x.id, { id: x.id, name: x.name, via });
          found.callers++;
        }
      };
      callersOf(S, 'component');
      if (C) callersOf(C, 'container');
      const stores = new Set(CORE.isStore(els.get(S)) ? [S] : []);
      for (const rel of outgoing(S)) if (els.has(rel.dst) && CORE.isStore(els.get(rel.dst))) stores.add(rel.dst);
      for (const t of stores) for (const rel of model.rels) {
        if (rel.dst !== t || related(rel.src, S) || CORE._shared.structural(model, rel)) continue;
        readers.set(rel.src, { id: rel.src, name: nm(rel.src) }); found.readers++;
      }
      for (const rel of outgoing(S)) {
        const i = CORE.interaction(rel);
        if (i === 'async') { consumers.set(rel.dst, { id: rel.dst, name: nm(rel.dst) }); found.consumers++; }
        else if (i == null || i === '') addUnknown(node, `interaction undeclared to ${nm(rel.dst)}`);
      }
      if (!found.callers && !found.readers && !found.consumers) addUnknown(node, 'no callers found on the code map');
    }
    const byName = (a, b) => (a.name || '').localeCompare(b.name || '') || String(a.id).localeCompare(String(b.id));
    return { callers: [...callers.values()].sort(byName), readers: [...readers.values()].sort(byName), consumers: [...consumers.values()].sort(byName),
      unknown: [...unknown.values()].sort((a, b) => a.node.localeCompare(b.node) || a.why.localeCompare(b.why)) };
  }

  // A copy of the view model with the layer's own boxes added. The input model is never touched.
  function augment(view, layer) {
    const els = new Map(view.elements);
    for (const o of layer.own) {
      els.set(o.id, { id: o.id, ident: o.id, name: o.name, kind: o.kind === 'container' ? 'container' : 'component', tags: new Set(['Element']), technology: null, description: null, parent: o.parent || null, props: {}, line: 0, file: null, kindLabel: OWN_LABEL[o.kind], layerBox: true });
    }
    return CORE._shared.makeModel(view.name, els, view.rels.slice(), view.errors);
  }
  const noteText = (notes, max = 44) => trunc(notes.map(n => n.text).join(' · '), max);
  // The short note drawn on a box ('entry 1 ui +change', 'new 4 store'); the full text is the tooltip and the panel.
  function shortNote(notes, { isNew = false } = {}) {
    const bits = [];
    if (isNew) bits.push('new');
    if (notes.some(n => n.role === 'entry')) bits.push('entry');
    for (const n of notes) if (n.role === 'path') bits.push(`${n.n} ${n.stage}`);
    if (notes.some(n => n.role === 'change')) bits.push('+change');
    return bits.join(' ');
  }
  const fullNote = notes => notes.map(n => n.text).join('\n');

  return { ENTRY_KINDS, STAGES, AUTHORS, STATUSES, EDGE_STYLE, OWN_LABEL, buildIndex, resolve, endpointsOf, endpointNode, handlerNode, nodeOfBox, endpointLabel, saveFile, shortNote, fullNote, validate, normalize, parseFile, newRecord, editable, statusText, fileFor, safeId,
    defaultStage, entryKind, setEntry, addStep, removeStep, addChange, removeChange, clearEntry, prepareSave, layerFor, augment, noteText, effects,
    contentHash, approvalState, isApproved, effectCounts, correct, corrected, correctionProblem, approvable, prepareApprove, draftProposal, PRINCIPLE_PROPS, proposalCheck, reviewCheck, reviewFor };
})();
if (typeof module !== 'undefined') module.exports = Landing;
