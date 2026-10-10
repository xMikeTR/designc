// ===== designc core: Structurizr DSL subset -> IR -> diagnostics =====
const Core = (() => {
  const PP = typeof require === 'function' && typeof module === 'object' ? require('./pathpattern.js') : PathPattern;
  // ---------- tokenizer ----------
  function tokenize(src) {
    const toks = []; let i = 0, line = 1; const n = src.length;
    while (i < n) {
      const c = src[i];
      if (c === '\n') { line++; i++; continue; }
      if (c === ' ' || c === '\t' || c === '\r') { i++; continue; }
      if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i++; continue; }
      if (c === '#') { while (i < n && src[i] !== '\n') i++; continue; }
      if (c === '/' && src[i + 1] === '*') {
        i += 2;
        while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] === '\n') line++; i++; }
        i += 2; continue;
      }
      if (c === '"') {
        const start = line; let j = i + 1, s = '';
        while (j < n && src[j] !== '"') {
          if (src[j] === '\\' && j + 1 < n) { s += src[j + 1]; j += 2; continue; }
          if (src[j] === '\n') line++;
          s += src[j]; j++;
        }
        toks.push({ t: 'str', v: s, line: start }); i = j + 1; continue;
      }
      if (c === '{' || c === '}' || c === '=') { toks.push({ t: c, line }); i++; continue; }
      if (c === '-' && src[i + 1] === '>') { toks.push({ t: '->', line }); i += 2; continue; }
      const num = /^\d+(?![\w.])/.exec(src.slice(i, i + 20));
      if (num) { toks.push({ t: 'id', v: num[0], line }); i += num[0].length; continue; }
      const m = /^[A-Za-z_!][\w.]*/.exec(src.slice(i, i + 200));
      if (m) { toks.push({ t: 'id', v: m[0], line }); i += m[0].length; continue; }
      toks.push({ t: '?', v: c, line }); i++;
    }
    return toks;
  }

  const KINDS = { person: 'person', softwareSystem: 'softwareSystem', softwaresystem: 'softwareSystem', container: 'container', component: 'component' };
  const SKIP = new Set(['views', 'styles', 'configuration', 'deploymentEnvironment', '!docs', '!adrs', '!identifiers', '!impliedRelationships', 'branding', 'terminology']);

  // ---------- parser ----------
  function parse(src) {
    const toks = tokenize(src); let p = 0; const errors = [];
    let curEnv = null; const envScopes = [];
    const els = new Map(), idents = new Map(), pending = [], envs = [], instRefs = [], depViews = []; let name = 'Untitled workspace', auto = 0;
    const peek = (k = 0) => toks[p + k];
    const next = () => toks[p++];
    const err = (tok, msg) => errors.push({ line: tok ? tok.line : (toks.length ? toks[toks.length - 1].line : 1), msg });
    const addTags = (set, s) => s.split(',').map(x => x.trim()).filter(Boolean).forEach(x => set.add(x));

    function strings() { const out = []; while (peek() && peek().t === 'str') out.push(next().v); return out; }
    function skipBlock() {
      let depth = 0;
      while (p < toks.length) { const t = next(); if (t.t === '{') depth++; else if (t.t === '}') { depth--; if (depth === 0) return; } }
    }
    function props(target) {
      const kw = next();
      if (!peek() || peek().t !== '{') { err(kw, 'expected { after properties'); return; }
      next();
      while (peek() && peek().t !== '}') {
        const k = next(), v = peek();
        if (!v || v.t === '}' || (v.t !== 'str' && v.t !== 'id')) { err(k, `property "${k.v}" has no value`); break; }
        next(); target[k.v] = v.v;
      }
      if (peek()) next(); else err(kw, 'properties block is missing }');
    }
    function element(kindTok, ident, parent) {
      const kind = KINDS[kindTok.v]; const s = strings();
      const el = { id: ident || ('_e' + (++auto)), ident, name: s[0] || '(unnamed)', kind, tags: new Set(['Element']),
        technology: null, description: s[1] || null, parent, props: {}, line: kindTok.line };
      if (kind === 'person' || kind === 'softwareSystem') { if (s[2]) addTags(el.tags, s[2]); }
      else { el.technology = s[2] || null; if (s[3]) addTags(el.tags, s[3]); }
      if (!s[0]) err(kindTok, `${kindTok.v} needs a name`);
      if (ident) { if (idents.has(ident)) err(kindTok, `identifier "${ident}" is already used`); idents.set(ident, el.id); }
      els.set(el.id, el);
      if (peek() && peek().t === '{') { const open = next(); if (!body(el)) err(open, `block for "${el.name}" is missing }`); }
    }
    function relationship(srcRef, arrow) {
      const dst = next();
      if (!dst || dst.t !== 'id') { err(arrow, 'expected a destination after ->'); return; }
      const s = strings();
      const r = { srcRef, dstRef: dst.v, description: s[0] || '', technology: s[1] || null, props: {}, line: arrow.line };
      if (peek() && peek().t === '{') {
        const open = next();
        while (peek() && peek().t !== '}') {
          const t = peek();
          if (t.t === 'id' && t.v === 'properties') props(r.props);
          else if (t.t === '{') skipBlock();
          else next();
        }
        if (peek()) next(); else err(open, 'relationship block is missing }');
      }
      pending.push(r);
    }
    // deploymentEnvironment: parsed into its own tree, never into `els`, so lint, drift and fingerprints ignore it.
    const DEPLOY = { deploymentNode: 1, infrastructureNode: 1, containerInstance: 1, softwareSystemInstance: 1 };
    function deployBody(list, owner) {
      while (p < toks.length) {
        const t = peek();
        if (t.t === '}') { next(); return true; }
        if (t.t === '{') { skipBlock(); continue; }
        if (t.t === '->' && owner) { next(); deployRel(owner, peek(-1)); continue; }
        if (t.t === '->') { next(); if (peek() && peek().t === 'id') next(); strings(); if (peek() && peek().t === '{') skipBlock(); continue; }
        if (t.t !== 'id') { err(t, `unexpected "${t.v || t.t}"`); next(); continue; }
        let v = t.v, ident = null;
        if (peek(1) && peek(1).t === '=' && peek(2) && peek(2).t === 'id') { ident = v; next(); next(); v = peek().v; }
        const kw = peek();
        if (owner && v === 'properties' && !ident) { props(owner.props); continue; }
        if (owner && v === 'tags' && !ident) { next(); strings().forEach(x => addTags(owner.tags, x)); continue; }
        if (peek(1) && peek(1).t === '->' && !ident) { next(); const arrow = next(); deployRel(v, arrow); continue; }
        if (!DEPLOY[v]) { next(); strings(); if (peek() && peek().t === '{') skipBlock(); else err(kw, `unknown keyword "${v}"`); continue; }
        next();
        const node = { kind: v, ident, name: '', description: null, technology: null, instances: null, tags: new Set(), props: {}, children: [], line: kw.line };
        if (v === 'containerInstance' || v === 'softwareSystemInstance') {
          const ref = peek();
          if (!ref || ref.t !== 'id') err(kw, `${v} needs an element`); else { next(); node.refName = ref.v; instRefs.push(node); }
          strings();
        } else {
          const s = strings();
          node.name = s[0] || ''; node.description = s[1] || null; node.technology = s[2] || null;
          if (!s[0]) err(kw, `${v} needs a name`);
          if (s[3]) addTags(node.tags, s[3]);
          if (v === 'deploymentNode') {
            if (peek() && peek().t === 'id' && /^\d+$/.test(peek().v)) node.instances = next().v;
            else if (s[4]) node.instances = s[4];
          }
        }
        if (peek() && peek().t === '{') { const open = next(); if (!deployBody(node.children, node)) err(open, `block for "${node.name || node.refName}" is missing }`); }
        list.push(node);
        if (ident) curEnv.idents.set(ident, node);
      }
      return false;
    }
    // `a -> b "desc" "tech"` between deployment elements; `src` is an identifier or the enclosing node.
    function deployRel(src, arrow) {
      const dst = peek() && peek().t === 'id' ? next().v : null, s = strings();
      if (peek() && peek().t === '{') skipBlock();
      curEnv.pending.push({ src, dst, description: s[0] || null, technology: s[1] || null, line: arrow.line });
    }
    function environment(ident) {
      const kw = next(); const s = strings();
      const env = { ident, name: s[0] || '(unnamed)', nodes: [], rels: [], line: kw.line };
      curEnv = { env, idents: new Map(), pending: [] };
      if (!s[0]) err(kw, 'deploymentEnvironment needs a name');
      if (peek() && peek().t === '{') { const open = next(); if (!deployBody(env.nodes, null)) err(open, `block for "${env.name}" is missing }`); }
      else err(kw, `deploymentEnvironment "${env.name}" needs a block`);
      envs.push(env); envScopes.push(curEnv); curEnv = null;
    }
    // views { deployment <scope> <environment> "key" { ... } }: record them, skip every other view.
    function viewsBlock() {
      next();
      while (p < toks.length) {
        const t = peek();
        if (t.t === '}') { next(); return; }
        if (t.t === '{') { skipBlock(); continue; }
        next();
        if (t.t !== 'id' || t.v !== 'deployment') continue;
        const head = []; while (peek() && peek().t !== '{' && peek().t !== '}' && head.length < 6) head.push(next());
        if (head.length < 2) { err(t, 'deployment view needs a scope and an environment'); continue; }
        depViews.push({ scope: head[0].v, environment: head[1].v, key: head[2] && head[2].t === 'str' ? head[2].v : null, line: t.line });
      }
    }
    // returns true when it stopped on a closing brace
    function body(owner) {
      while (p < toks.length) {
        const t = peek();
        if (t.t === '}') { next(); return true; }
        if (t.t === 'id') {
          const v = t.v;
          if (owner && v === 'properties') { props(owner.props); continue; }
          if (owner && v === 'tags') { next(); strings().forEach(x => addTags(owner.tags, x)); continue; }
          if (owner && (v === 'description' || v === 'technology')) { next(); const s = strings(); if (s[0] != null) owner[v] = s[0]; continue; }
          if (v === 'deploymentEnvironment') { environment(null); continue; }
          if (peek(1) && peek(1).t === '=' && peek(2) && peek(2).t === 'id' && peek(2).v === 'deploymentEnvironment') { next(); next(); environment(v); continue; }
          if (peek(1) && peek(1).t === '=' && peek(2) && peek(2).t === 'id' && KINDS[peek(2).v]) {
            next(); next(); const k = next(); element(k, v, owner ? owner.id : null); continue;
          }
          if (KINDS[v]) { next(); element(t, null, owner ? owner.id : null); continue; }
          if (peek(1) && peek(1).t === '->') { next(); const a = next(); relationship(v, a); continue; }
          if (v === 'workspace' || v === 'model') {
            next(); const s = strings(); if (v === 'workspace' && s[0]) name = s[0];
            if (peek() && peek().t === '{') { const open = next(); if (!body(null)) err(open, `${v} block is missing }`); }
            continue;
          }
          if (v === 'views' && peek(1) && peek(1).t === '{') { next(); viewsBlock(); continue; }
          next(); strings();
          if (peek() && peek().t === '{') skipBlock();
          else if (!SKIP.has(v) && v !== 'this') err(t, `unknown keyword "${v}"`);
          continue;
        }
        if (t.t === '->' && owner) { const a = next(); relationship('#' + owner.id, a); continue; }
        if (t.t === '{') { skipBlock(); continue; }
        err(t, `unexpected "${t.v || t.t}"`); next();
      }
      return false;
    }
    while (p < toks.length) { if (body(null)) err(toks[p - 1], 'unmatched }'); }

    const resolve = ref => ref.startsWith('#') ? ref.slice(1) : idents.get(ref);
    const rels = [];
    pending.forEach((r, i) => {
      const src = resolve(r.srcRef), dst = resolve(r.dstRef);
      if (!src) { errors.push({ line: r.line, msg: `unknown element "${r.srcRef}"` }); return; }
      if (!dst) { errors.push({ line: r.line, msg: `unknown element "${r.dstRef}"` }); return; }
      rels.push({ id: 'r' + (i + 1), src, dst, description: r.description, technology: r.technology, props: r.props, line: r.line });
    });
    instRefs.forEach(n => {
      const id = resolve(n.refName), el = id && els.get(id);
      if (!el) { errors.push({ line: n.line, msg: `unknown element "${n.refName}"` }); n.name = n.refName; return; }
      n.ref = el.id; n.name = el.name;
    });
    envScopes.forEach(({ env, idents: ids, pending: rs }) => {
      const paths = new Map(); const walk = (nodes, prefix) => nodes.forEach(n => { const path = prefix ? `${prefix}/${n.name}` : n.name; paths.set(n, path); walk(n.children, path); }); walk(env.nodes, '');
      const pathOf = ref => { const n = typeof ref === 'string' ? ids.get(ref) : ref; return n ? paths.get(n) : null; };
      rs.forEach(r => {
        const src = pathOf(r.src), dst = r.dst == null ? null : pathOf(r.dst);
        if (!src) { errors.push({ line: r.line, msg: `unknown deployment element "${r.src}"` }); return; }
        if (!dst) { errors.push({ line: r.line, msg: `unknown deployment element "${r.dst}"` }); return; }
        env.rels.push({ src, dst, description: r.description, technology: r.technology, line: r.line });
      });
    });
    const views = [];
    depViews.forEach(v => {
      const env = envs.find(e => e.name === v.environment || (e.ident && e.ident === v.environment));
      if (!env) { errors.push({ line: v.line, msg: `deployment view names unknown environment "${v.environment}"` }); return; }
      let system = null;
      if (v.scope !== '*') {
        const id = idents.get(v.scope), el = id && els.get(id);
        if (!el) { errors.push({ line: v.line, msg: `deployment view names unknown software system "${v.scope}"` }); return; }
        if (el.kind !== 'softwareSystem') { errors.push({ line: v.line, msg: 'deployment view scope must be a software system' }); return; }
        system = el.id;
      }
      views.push({ scope: v.scope, environment: env.name, key: v.key, line: v.line, system });
    });
    const m = makeModel(name, els, rels, errors);
    m.deployment = { environments: envs, views };
    return m;
  }

  // Everything the picker offers: each declared view, then "All of <environment>". `id` is `view:<key>` or `env:<name>`.
  function deploymentChoices(model) {
    const dep = model.deployment || { environments: [], views: [] };
    const views = dep.views.map(v => ({ id: `view:${v.key || v.scope}`, label: `${v.key || v.scope} \u00b7 ${v.scope === '*' ? '*' : (model.elements.get(v.system) || { name: v.scope }).name} \u00b7 ${v.environment}`, env: dep.environments.find(e => e.name === v.environment), view: v }));
    return [...views, ...dep.environments.map(e => ({ id: `env:${e.name}`, label: `All of ${e.name}`, env: e, view: null }))];
  }

  // What the Deployment view shows: `wanted` (from `designc.json`) is a view key first, then an environment name; a view wins a
  // clash. With nothing wanted, the only environment. `view` is null when the whole environment is meant.
  function deploymentView(model, wanted) {
    const envs = (model.deployment && model.deployment.environments) || [];
    const views = (model.deployment && model.deployment.views) || [];
    const choices = envs.map(e => e.name);
    if (wanted) {
      const view = views.find(v => (v.key || v.scope) === wanted);
      if (view) return { env: envs.find(e => e.name === view.environment), view, choices };
      const env = envs.find(e => e.name === wanted);
      if (env) return { env, view: null, choices };
      const keys = views.map(v => v.key || v.scope);
      return { error: `designc.json deployment names "${wanted}", which this model does not declare. Choose one of: ${[...keys, ...choices].join(', ') || 'none declared'}.`, choices };
    }
    return envs.length === 1 ? { env: envs[0], view: null, choices } : { choices };
  }

  // The software system an element belongs to (itself, for a system), or null for a person.
  function systemOf(model, id) {
    for (let e = model.elements.get(id); e; e = e.parent ? model.elements.get(e.parent) : null) if (e.kind === 'softwareSystem') return e;
    return null;
  }

  // Group `[{id, name}]` by software system, sorted by system name; elements outside any system come last.
  function bySystem(model, items) {
    const groups = new Map();
    for (const it of items) {
      const sys = systemOf(model, it.id), key = sys ? sys.id : null;
      if (!groups.has(key)) groups.set(key, { system: sys ? sys.name : null, id: key, items: [] });
      groups.get(key).items.push(it);
    }
    const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
    return [...groups.values()].sort((a, b) => (a.system === null) - (b.system === null) || cmp(a.system, b.system));
  }

  // Split impact into the viewed system and the rest: [{here, groups}], an empty side left out. No system means all of it is "here".
  function splitBySystem(model, items, systemId) {
    const groups = bySystem(model, items);
    if (!systemId) return groups.length ? [{ here: true, groups }] : [];
    return [{ here: true, groups: groups.filter(g => g.id === systemId) }, { here: false, groups: groups.filter(g => g.id !== systemId) }].filter(x => x.groups.length);
  }

  // What a deployment view keeps of an environment. Scoped to a system: nodes holding its instances (and their ancestors),
  // infrastructure nodes inside a shown node or linked to a shown instance; other systems' instances in shown nodes collapse
  // to `shared` counts. `*` or no view keeps everything. Returns {scoped, system, nodes, rels, hidden}; each node is
  // {node, path, insts, shared, children}, with `insts` the instance nodes shown and `children` the sub-nodes shown.
  function deploymentScope(model, env, view) {
    const sysId = view && view.system ? view.system : null;
    const scoped = !!sysId;
    const sysName = scoped ? (model.elements.get(sysId) || {}).name : null;
    const isInst = n => n.kind === 'containerInstance' || n.kind === 'softwareSystemInstance';
    const mine = n => { if (!n.ref) return true; const s = systemOf(model, n.ref); return !!s && s.id === sysId; };
    const paths = new Map();
    (function walk(nodes, prefix) { nodes.forEach(n => { const p = prefix ? `${prefix}/${n.name}` : n.name; paths.set(n, p); if (!isInst(n)) walk(n.children, p); }); })(env.nodes, '');
    const shown = new Set(), ancestors = n => { for (let p = paths.get(n); p; p = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '') shown.add(p); };
    const all = [...paths.keys()];
    if (!scoped) all.forEach(n => shown.add(paths.get(n)));
    else {
      for (const n of all) if (isInst(n) && mine(n)) ancestors(n);
      const shownInst = new Set(all.filter(n => isInst(n) && shown.has(paths.get(n))).map(n => paths.get(n)).filter(p => all.some(n => paths.get(n) === p && mine(n))));
      for (const n of all) {
        if (n.kind !== 'infrastructureNode') continue;
        const p = paths.get(n), parent = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : null;
        if ((parent && shown.has(parent)) || (env.rels || []).some(r => (r.src === p && shownInst.has(r.dst)) || (r.dst === p && shownInst.has(r.src)))) ancestors(n);
      }
    }
    const build = nodes => nodes.filter(n => !isInst(n) && shown.has(paths.get(n))).map(n => {
      const insts = n.children.filter(c => isInst(c) && (!scoped || mine(c)));
      const counts = new Map();
      if (scoped) for (const c of n.children.filter(c => isInst(c) && !mine(c))) { const nm = systemOf(model, c.ref).name; counts.set(nm, (counts.get(nm) || 0) + 1); }
      const shared = [...counts].map(([system, count]) => ({ system, count })).sort((a, b) => (a.system < b.system ? -1 : a.system > b.system ? 1 : 0));
      return { node: n, path: paths.get(n), insts, shared, children: build(n.children) };
    });
    const instShown = new Set(all.filter(n => isInst(n) && shown.has(paths.get(n)) && (!scoped || mine(n))).map(n => paths.get(n)));
    const end = p => shown.has(p) || instShown.has(p);
    const nodes = build(env.nodes);
    const rels = (env.rels || []).filter(r => !scoped || end(r.src) || end(r.dst));
    return { scoped, system: sysName, nodes, rels, hidden: all.filter(n => !isInst(n) && !shown.has(paths.get(n))).length };
  }

  function makeModel(name, els, rels, errors) {
    const m = { name, elements: els, rels, errors, relById: new Map(rels.map(r => [r.id, r])) };
    m.label = id => { const parts = []; let c = els.get(id); while (c) { parts.push(c.name); c = c.parent ? els.get(c.parent) : null; } return parts.reverse().join('/'); };
    m.isAncestor = (a, child) => { let c = els.get(child); while (c && c.parent) { if (c.parent === a) return true; c = els.get(c.parent); } return false; };
    m.locEl = e => ({ kind: 'element', id: e.id, label: e.name, names: [e.name], line: e.line });
    m.locRel = r => ({ kind: 'relationship', id: r.id, label: `${els.get(r.src).name} → ${els.get(r.dst).name}`, names: [els.get(r.src).name, els.get(r.dst).name], line: r.line });
    return m;
  }

  // ---------- schema ----------
  const YN = ['yes', 'no'];
  const SPECS = {
    relationship: {
      'd.interaction': { k: 'enum', v: ['sync', 'async'] },
      'd.delivery': { k: 'enum', v: ['at-most-once', 'at-least-once', 'exactly-once'] },
      'd.idempotent': { k: 'enum', v: YN }, 'd.retry': { k: 'enum', v: ['none', 'fixed', 'backoff'] },
      'd.retry.max': { k: 'int' }, 'd.encrypted': { k: 'enum', v: YN }, 'd.authenticated': { k: 'enum', v: YN },
      'd.writes': { k: 'list' }, 'd.concurrency': { k: 'enum', v: ['none', 'optimistic', 'pessimistic'] },
      'd.timeout': { k: 'int' }, 'd.suppress': { k: 'suppress' },
    },
    element: {
      'd.instances': { k: 'int' }, 'd.critical': { k: 'enum', v: YN }, 'd.zone': { k: 'str' },
      'd.availability': { k: 'float' }, 'd.owns': { k: 'list' }, 'd.store': { k: 'enum', v: YN },
      'd.latency.max': { k: 'int' }, 'd.fanout': { k: 'enum', v: ['sequential', 'parallel'] }, 'd.retry.budget': { k: 'int' },
      'd.aka': { k: 'list' }, 'd.suppress': { k: 'suppress' },
      'd.code': { k: 'list' }, 'd.risk': { k: 'enum', v: ['low', 'medium', 'high'] },
    },
  };
  function parseSuppress(raw) {
    const out = {};
    for (const chunk of raw.split(/;\s*(?=DC\d{3}\s*:)/i).map(s => s.trim()).filter(Boolean)) {
      const i = chunk.indexOf(':');
      if (i < 0) throw new Error(`"${chunk}" is not "DCnnn: reason"`);
      const code = chunk.slice(0, i).trim().toUpperCase(), reason = chunk.slice(i + 1).trim();
      if (!/^DC\d{3}$/.test(code)) throw new Error(`"${chunk}" is not "DCnnn: reason"`);
      if (!reason) throw new Error(`suppression of ${code} has no reason`);
      out[code] = reason;
    }
    return out;
  }
  function parseVal(spec, raw) {
    const v = String(raw).trim();
    switch (spec.k) {
      case 'enum': { const x = v.toLowerCase(); if (!spec.v.includes(x)) throw new Error('expected ' + spec.v.join(' | ')); return x; }
      case 'int': if (!/^\d+$/.test(v)) throw new Error('expected a whole number'); return parseInt(v, 10);
      case 'float': { const f = Number(v); if (!(f > 0 && f <= 1)) throw new Error('expected a fraction in (0, 1], e.g. 0.999'); return f; }
      case 'list': return v.split(',').map(s => s.trim()).filter(Boolean);
      case 'suppress': return parseSuppress(v);
      default: return v;
    }
  }
  const targetOf = o => (o.kind ? 'element' : 'relationship');
  function get(o, key) {
    const raw = o.props[key]; if (raw == null) return null;
    try { return parseVal(SPECS[targetOf(o)][key], raw); } catch { return null; }
  }
  function lev(a, b) {
    const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
    for (let j = 1; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    return d[a.length][b.length];
  }

  // ---------- diagnostics ----------
  const D = (code, sev, msg, loc, extra = {}) => ({ code, sev, msg, loc, hint: null, unknown: false, suppressed: null, related: [], ...extra });

  function validate(m) {
    const out = [];
    const items = [...[...m.elements.values()].map(e => ['element', e, m.locEl(e)]), ...m.rels.map(r => ['relationship', r, m.locRel(r)])];
    for (const [target, o, loc] of items) {
      const specs = SPECS[target];
      for (const [key, raw] of Object.entries(o.props)) {
        if (!key.startsWith('d.')) continue;
        const spec = specs[key];
        if (!spec) {
          const best = Object.keys(specs).map(k => [k, lev(key, k)]).sort((a, b) => a[1] - b[1])[0];
          const other = target === 'element' ? 'relationship' : 'element';
          const hint = best && best[1] <= 3 ? `did you mean "${best[0]}"?` : (SPECS[other][key] ? `"${key}" belongs on ${other === 'element' ? 'an element' : 'a relationship'}` : null);
          out.push(D('DC000', 'error', `unknown design property "${key}"`, loc, { hint }));
          continue;
        }
        try { parseVal(spec, raw); } catch (e) { out.push(D('DC000', 'error', `"${key}" = "${raw}": ${e.message}`, loc)); }
      }
      if (target === 'element' && o.props['d.code'] != null) out.push(...codeAreaProblems(o).map(([msg, hint]) => D('DC000', 'error', msg, loc, { hint })));
    }
    return out;
  }
  // d.code is System 2's scope guard; its handover reader refuses what is reported here.
  function codeAreaProblems(e) {
    const raw = e.props['d.code'], entries = String(raw).split(',').map(s => s.trim()), out = [];
    if (entries.every(s => !s)) out.push([`"d.code" = "${raw}": lists no paths`, 'remove d.code, or name where the element\'s code lives']);
    else entries.forEach((s, i) => {
      if (!s) { out.push([`"d.code" = "${raw}": entry ${i + 1} is blank`, null]); return; }
      const p = PP.create(s);
      if (!p.ok) out.push([`"d.code" = "${raw}": ${p.error}`, 'use repo-relative paths with *, ? and ** as a whole segment']);
    });
    if (e.props['d.risk'] == null) out.push(['d.code needs d.risk (System 2 refuses the handover without it)', 'set d.risk: low | medium | high']);
    return out;
  }

  const interaction = r => get(r, 'd.interaction');
  const isStore = e => (e.props['d.store'] != null ? get(e, 'd.store') === 'yes' : e.tags.has('Database'));
  function zone(m, id) { let c = m.elements.get(id); while (c) { const z = get(c, 'd.zone'); if (z) return z; c = c.parent ? m.elements.get(c.parent) : null; } return null; }
  const structural = (m, r) => m.isAncestor(r.src, r.dst) || m.isAncestor(r.dst, r.src);

  // ---------- timing and retry amplification (slice 16) ----------
  // Sync calls only (async, structural pairs and calls from a person are out). A timeout bounds the wait, so a
  // callee's worst case is its own d.latency.max plus what its outgoing calls can take: d.timeout x (1 + retries),
  // summed, or the slowest when the callee declares d.fanout: parallel. Nothing recurses, so cycles cannot matter here.
  const syncCall = (m, r) => interaction(r) !== 'async' && !structural(m, r) && m.elements.get(r.src).kind !== 'person';
  const attemptsOf = r => {
    const k = get(r, 'd.retry');
    if (k !== 'fixed' && k !== 'backoff') return { n: 1 };
    const mx = get(r, 'd.retry.max');
    return mx == null ? { n: 1, unknown: true } : { n: 1 + mx };
  };
  // Both walks below try every simple path; past this many steps they stop rather than freeze the editor.
  const MAX_PATH_STEPS = 100000;
  const outgoing = (m, id) => m.rels.filter(r => r.src === id && syncCall(m, r));
  function worstCase(m, e) {
    const own = get(e, 'd.latency.max'), missing = [], parts = [];
    if (own == null) missing.push(`d.latency.max on ${e.name}`);
    let total = own || 0;
    const costs = [];
    for (const r of outgoing(m, e.id)) {
      const t = get(r, 'd.timeout'), a = attemptsOf(r), to = m.elements.get(r.dst).name;
      if (t == null) { missing.push(`d.timeout on ${e.name} → ${to}`); continue; }
      if (a.unknown) { missing.push(`d.retry.max on ${e.name} → ${to}`); continue; }
      costs.push(t * a.n);
      parts.push(a.n > 1 ? `${to} ${a.n} × ${t}` : `${to} ${t}`);
    }
    const parallel = get(e, 'd.fanout') === 'parallel';
    total += parallel ? costs.reduce((x, y) => Math.max(x, y), 0) : costs.reduce((x, y) => x + y, 0);
    const calls = parallel && parts.length > 1 ? `slowest of ${parts.join(', ')}` : parts.join(' + ');
    return { ms: missing.length ? null : total, missing, text: `${own == null ? '?' : own} own${calls ? ' + ' + calls : ''}` };
  }
  // Per sync rel: its timeout, the callee's worst case, the attempts it allows, and a status for the badges.
  function timing(m, o = {}) {
    const rels = new Map();
    for (const r of m.rels) {
      if (!syncCall(m, r)) continue;
      const t = get(r, 'd.timeout'), a = attemptsOf(r), w = worstCase(m, m.elements.get(r.dst));
      const status = t == null ? 'unknown' : w.missing.length ? 'unknown' : t < w.ms ? 'violation' : 'ok';
      rels.set(r.id, { id: r.id, label: m.locRel(r).label, timeout: t, worst: w.ms, factor: a.unknown ? null : a.n, status, missing: w.missing, text: w.text });
    }
    return { rels };
  }
  // The highest retry multiplier from one element to each element it reaches over sync calls. Each element is
  // entered at most once per path, so a cycle is followed once.
  function amplificationFrom(m, startId) {
    const out = new Map();
    let steps = 0;
    const dfs = (id, seen, mult) => {
      for (const r of outgoing(m, id)) {
        if (seen.has(r.dst)) continue;
        if (++steps > MAX_PATH_STEPS) return;
        const next = mult * attemptsOf(r).n;
        if (next > (out.get(r.dst) || 0)) out.set(r.dst, next);
        dfs(r.dst, new Set([...seen, r.dst]), next);
      }
    };
    dfs(startId, new Set([startId]), 1);
    return out;
  }

  const RULES = [
    { code: 'DC001', title: 'Duplicate processing', source: 'concept note (not yet incident-backed)',
      doc: 'At-least-once delivery into a receiver that is not idempotent processes some messages twice.',
      fn(m) {
        const out = [];
        for (const r of m.rels) {
          if (interaction(r) !== 'async') continue;
          const d = get(r, 'd.delivery');
          if (d == null) { out.push(D('DC001', 'warning', 'async, but no delivery guarantee declared', m.locRel(r), { hint: 'set d.delivery: at-most-once | at-least-once | exactly-once', unknown: true })); continue; }
          if (d !== 'at-least-once') continue;
          const idem = get(r, 'd.idempotent');
          if (idem === 'no') out.push(D('DC001', 'error', `at-least-once into a non-idempotent receiver: some messages are processed twice`, m.locRel(r), { hint: 'dedupe on a message id, or make the handler idempotent' }));
          else if (idem == null) out.push(D('DC001', 'warning', 'at-least-once delivery, receiver idempotency undeclared', m.locRel(r), { hint: 'set d.idempotent: yes | no', unknown: true }));
        }
        return out;
      } },
    { code: 'DC002', title: 'Lost update', source: 'pricing engine concurrency gap (lost update)',
      doc: 'Concurrent writers to one entity without an owner or concurrency control overwrite each other, including one container scaled out.',
      fn(m) {
        const out = [], writes = new Map(), owners = new Map();
        for (const r of m.rels) {
          const ents = get(r, 'd.writes'); if (!ents || !ents.length) continue;
          const store = m.elements.get(r.dst);
          if (!isStore(store)) { out.push(D('DC002', 'warning', `writes into "${store.name}", which is not a store`, m.locRel(r), { hint: 'tag it "Database" or set d.store: yes' })); continue; }
          for (const ent of ents) { const k = store.id + '|' + ent; if (!writes.has(k)) writes.set(k, []); writes.get(k).push(r); }
        }
        for (const e of m.elements.values()) for (const ent of get(e, 'd.owns') || []) { if (!owners.has(ent)) owners.set(ent, new Set()); owners.get(ent).add(e.id); }
        for (const [k, rels0] of writes) {
          const [storeId, ent] = k.split('|'); const store = m.elements.get(storeId); let rels = rels0;
          const own = owners.get(ent);
          if (own && own.size) {
            for (const r of rels) if (!own.has(r.src)) {
              const names = [...own].map(x => m.elements.get(x).name).join(', ');
              out.push(D('DC002', 'warning', `writes "${ent}" but ${names} owns it`, m.locRel(r), { hint: 'route the write through the owner, or change d.owns' }));
            }
            rels = rels.filter(r => own.has(r.src));
          }
          const writers = new Set(rels.map(r => r.src)); let who;
          if (writers.size >= 2) who = `${writers.size} containers (${[...writers].map(w => m.elements.get(w).name).join(', ')})`;
          else if (writers.size === 1) { const w = m.elements.get([...writers][0]); const n = get(w, 'd.instances'); if (!n || n < 2) continue; who = `${n} instances of ${w.name}`; }
          else continue;
          const none = rels.filter(r => get(r, 'd.concurrency') === 'none'), undecl = rels.filter(r => get(r, 'd.concurrency') == null);
          if (!none.length && !undecl.length) continue;
          const related = [...none, ...undecl].map(m.locRel);
          const hint = 'declare one owner with d.owns, or set d.concurrency: optimistic';
          if (none.length) out.push(D('DC002', 'error', `lost update: ${who} write "${ent}" and at least one has no concurrency control`, m.locEl(store), { hint, related }));
          else out.push(D('DC002', 'warning', `possible lost update: ${who} write "${ent}", concurrency undeclared`, m.locEl(store), { hint: 'set d.concurrency on each writing relationship', unknown: true, related }));
        }
        return out;
      } },
    { code: 'DC003', title: 'Compound availability', source: 'concept note (not yet incident-backed)',
      doc: 'A long synchronous chain is only as available as the product of every hop. Undeclared interactions count as sync.',
      fn(m, o) {
        const adj = new Map(), hasIn = new Set();
        for (const r of m.rels) {
          if (interaction(r) === 'async' || structural(m, r) || m.elements.get(r.src).kind === 'person') continue;
          if (!adj.has(r.src)) adj.set(r.src, []); adj.get(r.src).push(r); hasIn.add(r.dst);
        }
        let starts = [...adj.keys()].filter(n => !hasIn.has(n)); if (!starts.length) starts = [...adj.keys()];
        const found = [];
        const dfs = (node, seen, path) => {
          if (found.length >= 200) return; let ext = false;
          for (const r of adj.get(node) || []) { if (seen.has(r.dst)) continue; ext = true; dfs(r.dst, new Set([...seen, r.dst]), [...path, r]); }
          if (!ext && path.length >= o.chainHops) found.push(path);
        };
        starts.forEach(s => dfs(s, new Set([s]), []));
        return found.map(path => {
          const nodes = [path[0].src, ...path.map(r => r.dst)];
          const av = nodes.map(n => get(m.elements.get(n), 'd.availability'));
          const assumed = path.filter(r => interaction(r) == null).length;
          let msg = `${path.length} synchronous hops: ${nodes.map(n => m.elements.get(n).name).join(' → ')}`;
          msg += av.every(a => a != null) ? `; end-to-end availability ≈ ${(av.reduce((a, b) => a * b, 1) * 100).toFixed(2)}%` : `; declare d.availability on ${av.filter(a => a == null).length} more element(s) to compute it`;
          if (assumed) msg += ` (${assumed} undeclared hop(s) assumed sync)`;
          return D('DC003', 'warning', msg, m.locRel(path[0]), { hint: 'make a hop async, cache, or add a fallback', related: path.slice(1).map(m.locRel) });
        });
      } },
    { code: 'DC004', title: 'Retry duplicates side effects', source: 'concept note (not yet incident-backed)',
      doc: 'Retrying a call whose receiver is not idempotent repeats its side effects.',
      fn(m) {
        const out = [];
        for (const r of m.rels) {
          if (!['fixed', 'backoff'].includes(get(r, 'd.retry'))) continue;
          const idem = get(r, 'd.idempotent');
          if (idem === 'no') out.push(D('DC004', 'error', 'retries on a non-idempotent call duplicate side effects', m.locRel(r), { hint: 'send an idempotency key, or remove the retry' }));
          else if (idem == null) out.push(D('DC004', 'warning', 'retries declared, receiver idempotency undeclared', m.locRel(r), { hint: 'set d.idempotent: yes | no', unknown: true }));
        }
        return out;
      } },
    { code: 'DC005', title: 'Single point of failure', source: 'concept note (not yet incident-backed)',
      doc: 'A critical element with one instance takes its path down with it.',
      fn(m) {
        const out = [];
        for (const e of m.elements.values()) {
          if (get(e, 'd.critical') !== 'yes') continue;
          const n = get(e, 'd.instances');
          if (n == null) out.push(D('DC005', 'warning', 'critical, instance count undeclared', m.locEl(e), { hint: 'set d.instances', unknown: true }));
          else if (n <= 1) out.push(D('DC005', 'warning', `critical, but runs ${n} instance`, m.locEl(e), { hint: 'add an instance, or record the fallback as an accepted risk' }));
        }
        return out;
      } },
    { code: 'DC006', title: 'Trust boundary exposure', source: 'concept note (not yet incident-backed)',
      doc: 'Data crossing a trust boundary must be encrypted and authenticated. Active once any element declares d.zone.',
      fn(m) {
        const out = [];
        if (![...m.elements.values()].some(e => get(e, 'd.zone'))) return out;
        for (const r of m.rels) {
          if (structural(m, r)) continue;
          const zs = zone(m, r.src), zd = zone(m, r.dst);
          if (!zs || !zd) { out.push(D('DC006', 'warning', 'cannot tell whether this crosses a trust boundary', m.locRel(r), { hint: 'set d.zone on both ends or a parent', unknown: true })); continue; }
          if (zs === zd) continue;
          const vals = { encrypted: get(r, 'd.encrypted'), authenticated: get(r, 'd.authenticated') };
          const bad = Object.keys(vals).filter(k => vals[k] === 'no'), und = Object.keys(vals).filter(k => vals[k] == null);
          if (bad.length) out.push(D('DC006', 'error', `crosses ${zs} → ${zd} and is not ${bad.join(' or ')}`, m.locRel(r)));
          else if (und.length) out.push(D('DC006', 'warning', `crosses ${zs} → ${zd}; ${und.map(x => 'd.' + x).join(', ')} undeclared`, m.locRel(r), { hint: 'unknown on a boundary is a finding', unknown: true }));
        }
        return out;
      } },
    { code: 'DC007', title: 'Timeout shorter than the callee\'s worst case', source: 'concept note (not yet incident-backed)',
      doc: 'A caller that gives up before its callee can finish abandons work that is still running. Judged only on sync calls that declare d.timeout.',
      fn(m) {
        const out = [];
        for (const r of m.rels) {
          if (!syncCall(m, r) || get(r, 'd.timeout') == null) continue;
          const t = get(r, 'd.timeout'), callee = m.elements.get(r.dst), w = worstCase(m, callee);
          if (w.missing.length) out.push(D('DC007', 'warning', `cannot compare the timeout with ${callee.name}'s worst case; declare ${w.missing.join(', ')}`, m.locRel(r), { hint: 'set the missing d.timeout / d.latency.max / d.retry.max values', unknown: true }));
          else if (t < w.ms) out.push(D('DC007', 'error', `timeout ${t} ms is less than ${callee.name}'s worst case ${w.ms} ms (${w.text})`, m.locRel(r), { hint: 'raise this timeout, lower the callee\'s timeouts or retries, or call in parallel (d.fanout)' }));
        }
        return out;
      } },
    { code: 'DC008', title: 'Retry amplification', source: 'concept note (not yet incident-backed)',
      doc: 'Retries at each layer multiply: one request can become the product of every layer\'s attempts at the last receiver. The limit is retryAmplification in designc.json (default 4); d.retry.budget on a receiver overrides it.',
      fn(m, o) {
        const out = [], limit = o.retryAmplification || 4;
        for (const r of m.rels) {
          if (syncCall(m, r) && attemptsOf(r).unknown) out.push(D('DC008', 'warning', 'retries declared, d.retry.max undeclared', m.locRel(r), { hint: 'set d.retry.max', unknown: true }));
        }
        const adj = new Map(), hasIn = new Set();
        for (const r of m.rels) { if (!syncCall(m, r)) continue; if (!adj.has(r.src)) adj.set(r.src, []); adj.get(r.src).push(r); hasIn.add(r.dst); }
        let starts = [...adj.keys()].filter(n => !hasIn.has(n)); if (!starts.length) starts = [...adj.keys()];
        const hit = new Map(); // rel id -> { path, mult, budget }, the worst path into that rel
        let steps = 0;
        const dfs = (node, seen, path, mult) => {
          if (hit.size >= 200) return;
          for (const r of adj.get(node) || []) {
            if (seen.has(r.dst)) continue;
            if (++steps > MAX_PATH_STEPS) return;
            const next = mult * attemptsOf(r).n, budget = get(m.elements.get(r.dst), 'd.retry.budget') || limit, p = [...path, r];
            if (next > budget) { const old = hit.get(r.id); if (!old || next > old.mult) hit.set(r.id, { path: p, mult: next, budget }); continue; }
            dfs(r.dst, new Set([...seen, r.dst]), p, next);
          }
        };
        starts.forEach(s => dfs(s, new Set([s]), [], 1));
        if (steps > MAX_PATH_STEPS) out.push(D('DC008', 'warning', `the sync calls are too connected to check every retry path (stopped after ${MAX_PATH_STEPS} steps); results below may be incomplete`, m.locRel(adj.get(starts[0])[0]), { hint: 'split the model into smaller systems or reduce cross-calls', unknown: true }));
        for (const { path, mult, budget } of hit.values()) {
          const last = path[path.length - 1], names = [path[0].src, ...path.map(r => r.dst)].map(n => m.elements.get(n).name);
          out.push(D('DC008', 'warning', `retries multiply load ×${mult} along ${names.join(' → ')}; ${m.elements.get(last.dst).name} tolerates ×${budget}`, m.locRel(last), { hint: 'retry at one layer only, lower d.retry.max, or raise d.retry.budget on the receiver', related: path.slice(0, -1).map(m.locRel) }));
        }
        return out;
      } },
    { code: 'DC009', title: 'Overlapping code areas', source: 'System 2 contract: Fitness.owner gives a file to the first element whose d.code matches, and the plan scope guard admits overlapping areas',
      doc: 'Each file belongs to one element. d.code may be declared on one level per branch (a container or its components, not both), and the areas of unrelated elements must not overlap. Overlap is judged as System 2 judges it, so two wildcard segments count as overlapping.',
      fn(m) {
        const out = [], areas = [];
        for (const e of m.elements.values()) {
          if (e.props['d.code'] == null) continue;
          const pats = String(e.props['d.code']).split(',').map(s => PP.create(s)).filter(p => p.ok).map(p => p.value);
          const outer = areas.filter(a => m.isAncestor(a.e.id, e.id)).map(a => a.e);
          if (outer.length) {
            const near = outer[outer.length - 1];
            out.push(D('DC009', 'error', `"${e.name}" declares d.code inside "${near.name}", which also declares it`, m.locEl(e),
              { hint: 'declare d.code on one level per branch: the container or its components, not both', related: outer.map(m.locEl) }));
          }
          for (const a of areas) {
            if (m.isAncestor(a.e.id, e.id) || m.isAncestor(e.id, a.e.id)) continue;
            const hit = pats.flatMap(p => a.pats.filter(q => PP.mayOverlap(p, q)).map(q => [p, q]))[0];
            if (hit) out.push(D('DC009', 'error', `code area "${hit[0]}" may overlap "${hit[1]}" of "${a.e.name}"`, m.locEl(e),
              { hint: 'make the areas disjoint: System 2 gives a shared file to whichever element it reads first', related: [m.locEl(a.e)] }));
          }
          areas.push({ e, pats });
        }
        return out;
      } },
  ];

  const SEV = { error: 2, warning: 1, note: 0 };
  function check(m, o = { chainHops: 4 }) {
    let diags = validate(m);
    for (const r of RULES) diags = diags.concat(r.fn(m, o));
    for (const d of diags) {
      if (d.code === 'DC000') continue;
      const obj = d.loc.kind === 'element' ? m.elements.get(d.loc.id) : m.relById.get(d.loc.id);
      const raw = obj && obj.props['d.suppress'];
      if (raw) { try { d.suppressed = parseSuppress(raw)[d.code] || null; } catch { /* reported by validate */ } }
    }
    return diags.sort((a, b) => SEV[b.sev] - SEV[a.sev] || a.code.localeCompare(b.code) || a.loc.label.localeCompare(b.loc.label));
  }

  // ---------- gate (definition of ready) ----------
  // decision: {id, statement, requirement, binds[], resolves[], effect:'fix'|'accept', checks[], status}
  // A readable id from what a decision or proposal says, so two branches minting at once do not both
  // take "the next number". `taken` is every id already in the registry (array or Set).
  function slugId(statement, taken) {
    const words = String(statement || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
    let base = '';
    for (const w of words) { const next = base ? `${base}-${w}` : w; if (next.length > 48) break; base = next; }
    base = base || (words[0] || 'untitled').slice(0, 48).replace(/-+$/, '') || 'untitled';
    const used = new Set([...taken].map(t => String(t).toLowerCase()));
    let id = base;
    for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
    return id;
  }

  // A decision's assumptions (`assumptions: [{text, review_by}]`) go stale: past review_by the gate blocks until a human
  // reviews them. A YAML date (review_by: 2027-01-01) reads as a Date, so both spellings are normalised first.
  const isoDay = v => {
    const t = v instanceof Date ? v.toISOString().slice(0, 10) : v;
    if (typeof t !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(t)) return null;
    const d = new Date(t + 'T00:00:00Z');
    return !isNaN(d) && d.toISOString().slice(0, 10) === t ? t : null;
  };
  function assumptionClauses(dec, today, clauses) {
    if (dec.assumptions == null) return;
    const bad = { kind: 'assumption', text: `${dec.id}: each assumption needs text and a review_by date (YYYY-MM-DD)`, decision: dec.id };
    if (!Array.isArray(dec.assumptions)) { clauses.push(bad); return; }
    let flagged = false;
    for (const a of dec.assumptions) {
      const day = a && typeof a === 'object' && typeof a.text === 'string' && a.text.trim() ? isoDay(a.review_by) : null;
      if (!day) { if (!flagged) clauses.push(bad); flagged = true; continue; }
      if (day < today) clauses.push({ kind: 'assumption', text: `${dec.id}: assumption "${Array.from(a.text.trim()).slice(0, 60).join('')}" was due for review on ${day}`, decision: dec.id });
    }
  }
  function gate({ model, diags, decisions, requirements, ledger, registryErrors = [], evidenceHosts = [], scenarios = [], evals = [], now = Date.now() }) {
    const clauses = [];
    if (model.errors.length) clauses.push({ kind: 'parse', text: `${model.errors.length} model error(s) must be fixed first`, line: model.errors[0].line });
    for (const [kind, list] of [['decision', decisions], ['requirement', requirements]]) {
      const seen = new Set(), said = new Set();
      for (const x of list) { if (seen.has(x.id) && !said.has(x.id)) { said.add(x.id); clauses.push({ kind: 'duplicate', text: `duplicate id ${x.id}`, [kind]: x.id }); } seen.add(x.id); }
    }
    for (const e of registryErrors) clauses.push({ kind: 'registry', text: `${e.path} does not parse`, path: e.path });
    const today = new Date(now).toISOString().slice(0, 10);
    const bound = decisions.filter(d => d.status === 'bound');
    const covers = (dec, f) => dec.effect === 'accept' && (dec.resolves || []).includes(f.code) && (dec.binds || []).some(b => f.loc.names.includes(b));
    for (const f of diags) {
      if (f.suppressed || f.sev === 'note') continue;
      if (bound.some(dec => covers(dec, f))) continue;
      clauses.push({ kind: 'finding', text: `${f.code} on ${f.loc.label} is neither fixed nor accepted`, line: f.loc.line, finding: f });
    }
    const boundBusiness = new Set(decisions.filter(d => d.status === 'bound' && d.kind === 'business').map(d => d.id));
    for (const dec of decisions) {
      const kind = dec.kind == null ? 'technical' : dec.kind;
      if (kind !== 'business' && kind !== 'technical') clauses.push({ kind: 'decision', text: `${dec.id} has kind ${kind}, expected business or technical`, decision: dec.id });
      if (dec.status !== 'bound') { clauses.push({ kind: 'decision', text: `${dec.id} is ${dec.status || 'minted'}, not bound`, decision: dec.id }); continue; }
      const business = kind === 'business';
      assumptionClauses(dec, today, clauses);
      if (business) businessEvidence(dec, evidenceHosts, clauses);
      else if (dec.effect === 'accept' && !(dec.relies_on || []).some(id => boundBusiness.has(id)))
        clauses.push({ kind: 'decision', text: `${dec.id} accepts a risk without a bound business decision`, decision: dec.id });
      if (!business) {
        if (!(dec.checks || []).length) { clauses.push({ kind: 'decision', text: `${dec.id} has no check`, decision: dec.id }); continue; }
        const last = latestCheck(ledger, dec.id);
        if (!last) clauses.push({ kind: 'check', text: `${dec.id}: no check result recorded yet`, decision: dec.id });
        else if (last.outcome !== 'pass') clauses.push({ kind: 'check', text: `${dec.id}: last check failed`, decision: dec.id });
      }
      if (!Array.isArray(dec.promoted_against)) clauses.push({ kind: 'promotion', text: `${dec.id} is bound without a fingerprint`, decision: dec.id });
      else for (const pa of dec.promoted_against) {
        if (pa.requirement != null) {
          const req = requirements.find(r => r.id === pa.requirement);
          if (!req) clauses.push({ kind: 'promotion', text: `${dec.id}: binding ${pa.requirement} does not resolve`, decision: dec.id });
          else if (String(req.version) !== String(pa.version)) clauses.push({ kind: 'promotion', text: `${dec.id}: ${req.id} changed since promotion`, decision: dec.id, requirement: req.id });
          continue;
        }
        const el = resolveBinding(model, pa);
        if (!el) clauses.push({ kind: 'promotion', text: `${dec.id}: binding ${pa.name} does not resolve`, decision: dec.id });
        else if (fingerprint(model, el.id).hash !== pa.hash) clauses.push({ kind: 'promotion', text: `${dec.id}: ${el.name} changed since promotion`, decision: dec.id, element: el.name });
      }
      if (dec.effect === 'fix') {
        const still = diags.filter(f => !f.suppressed && (dec.resolves || []).includes(f.code) && (dec.binds || []).some(b => f.loc.names.includes(b)));
        if (still.length) clauses.push({ kind: 'decision', text: `${dec.id} says ${dec.resolves.join(', ')} is fixed, but the model still raises it`, decision: dec.id, line: still[0].loc.line });
      }
    }
    for (const req of requirements) {
      const traced = decisions.some(d => d.requirement === req.id) || (req.elements || []).some(n => [...model.elements.values()].some(e => e.name === n));
      if (!traced) clauses.push({ kind: 'requirement', text: `${req.id} is not traced to any element or decision`, requirement: req.id });
    }
    for (const nd of ledger.filter(e => e.kind === 'needs_decision' && e.status === 'open'))
      clauses.push({ kind: 'needs', text: `open needs-decision ${nd.id || ''}: ${nd.question}`.trim(), needs: nd });
    for (const s of scenarios) {
      if (!s || typeof s !== 'object' || !s.id || !s.artifact || !s.attribute || !s.measure) { clauses.push({ kind: 'scenario', text: `${(s && s.id) || 'a scenario'} needs artifact, attribute and measure` }); continue; }
    }
    for (const s of scenarios) {
      if (!s || typeof s !== 'object' || !s.id) continue;
      for (const f of ['importance', 'difficulty']) if (s[f] != null && !RATINGS.includes(s[f])) clauses.push({ kind: 'scenario', text: `${s.id}: ${f} must be high, medium or low` });
    }
    for (const r of scenarioReport({ model, scenarios: scenarios.filter(s => s && s.id && s.artifact && s.attribute && s.measure), ledger })) {
      if (r.status === 'unresolved') clauses.push({ kind: 'scenario', text: `${r.id}: artifact "${r.artifact}" is not in the model` });
      else if (r.analytic.status === 'not-met') clauses.push({ kind: 'scenario', text: `${r.id} is not met: availability ≈ ${r.analytic.value.toFixed(2)}% against ${r.measure.op === '<=' ? '≤' : '≥'} ${r.measure.value}%` });
      if (r.fitness.status === 'failing') clauses.push({ kind: 'scenario', text: `${r.id}: fitness function failing` });
    }
    clauses.push(...evalClauses({ model, evals, ledger, now }));
    return { ready: clauses.length === 0, clauses };
  }
  // A business decision rests on evidence: an https URL on a host the registry allows (designc.json evidenceHosts).
  function businessEvidence(dec, hosts, clauses) {
    const say = text => clauses.push({ kind: 'evidence', text, decision: dec.id });
    if (!dec.evidence) return say(`${dec.id} is a business decision without evidence`);
    let u = null;
    try { u = new URL(String(dec.evidence)); } catch { /* reported below */ }
    if (!u || u.protocol !== 'https:') return say(`${dec.id}: evidence must be an https URL`);
    if (!hosts.includes(u.hostname)) say(`${dec.id}: evidence host ${u.hostname} is not allowed (see evidenceHosts in designc.json)`);
  }
  function latestCheck(ledger, decId) {
    return ledger.filter(e => e.kind === 'check' && e.decision === decId).sort((a, b) => (b._ts || 0) - (a._ts || 0))[0] || null;
  }

  // ---------- quality attribute scenarios and fitness functions ----------
  // A scenario (scenarios/*.yaml) is a quality attribute scenario: stimulus, artifact (an element name),
  // response and a measure. Availability scenarios are checked analytically against the model: the
  // artifact's availability times that of everything it depends on through declared sync relationships
  // (async and undeclared ones are left out, as in blastRadius). Every other attribute is judged only by
  // its fitness function: shell commands run like decision checks, recorded as `fitness` ledger events.
  function latestFitness(ledger, id) {
    return ledger.filter(e => e.kind === 'fitness' && e.scenario === id).sort((a, b) => (b._ts || 0) - (a._ts || 0))[0] || null;
  }
  const RATINGS = ['high', 'medium', 'low'];
  const rating = v => (RATINGS.includes(v) ? v : null);
  function scenarioReport({ model, scenarios = [], ledger = [] }) {
    const byName = n => [...model.elements.values()].find(e => e.name === n) || null;
    return scenarios.map(s => {
      const row = { id: s.id, title: s.title || '', attribute: s.attribute, artifact: s.artifact, measure: s.measure || null, importance: rating(s.importance), difficulty: rating(s.difficulty) };
      const el = byName(s.artifact);
      const cmds = (s.fitness || []).filter(c => c && !/^TODO/.test(c));
      const last = latestFitness(ledger, s.id);
      row.fitness = { status: !cmds.length ? 'none' : !last ? 'unchecked' : last.outcome === 'pass' ? 'passing' : 'failing', commands: cmds };
      if (!el) { row.status = 'unresolved'; row.analytic = { status: 'n/a' }; return row; }
      row.status = 'resolved';
      const m = s.measure || {};
      if (s.attribute !== 'availability' || m.metric !== 'availability' || typeof m.value !== 'number') { row.analytic = { status: 'n/a' }; return row; }
      const seen = new Set([el.id]), queue = [el.id];
      for (let i = 0; i < queue.length; i++) for (const r of model.rels) {
        if (r.src !== queue[i] || seen.has(r.dst) || structural(model, r) || interaction(r) !== 'sync') continue;
        seen.add(r.dst); queue.push(r.dst);
      }
      const els = [...seen].map(id => model.elements.get(id));
      const missing = els.filter(e => get(e, 'd.availability') == null).map(e => e.name);
      if (missing.length) { row.analytic = { status: 'unknown', missing }; return row; }
      const value = els.reduce((a, e) => a * Number(get(e, 'd.availability')), 1) * 100;
      const ok = m.op === '<=' ? value <= m.value : value >= m.value;
      row.analytic = { status: ok ? 'met' : 'not-met', value, elements: els.map(e => e.name) };
      return row;
    });
  }

  // The utility tree: scenarios grouped by quality attribute, most important and hardest first, unrated last.
  // It only orders; nothing here reaches the gate.
  function utilityTree(rows) {
    const weight = v => 3 - RATINGS.indexOf(v), key = r => [r.importance ? weight(r.importance) : 0, r.difficulty ? weight(r.difficulty) : 0];
    const cmp = (a, b) => { const x = key(a), y = key(b); return y[0] - x[0] || y[1] - x[1] || String(a.id).localeCompare(String(b.id)); };
    const groups = new Map();
    for (const r of rows) { const k = r.attribute || ''; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); }
    const out = [...groups].map(([attribute, scenarios]) => ({ attribute, scenarios: scenarios.sort(cmp) }));
    return out.sort((a, b) => cmp(a.scenarios[0], b.scenarios[0]) || a.attribute.localeCompare(b.attribute));
  }

  // ---------- agent topology ----------
  // The agents in a model, what they call and who calls them, for the topology view. Only elements one declared
  // relationship away from an agent appear. An agent has the Agent tag or declares d.agent.autonomy (as the evals do). An irreversible call with no human approval is `unguarded`.
  function agentTopology(model) {
    const agents = new Set([...model.elements.values()].filter(e => e.tags.has('Agent') || get(e, 'd.agent.autonomy') != null).map(e => e.id));
    const edges = model.rels.filter(r => (agents.has(r.src) || agents.has(r.dst)) && r.src !== r.dst && model.elements.has(r.src) && model.elements.has(r.dst) && !structural(model, r)).map(r => {
      const effect = get(r, 'd.tool.effect'), approval = get(r, 'd.approval');
      return { id: r.id, src: r.src, dst: r.dst, description: r.description || '', effect: effect == null ? null : effect, approval: approval == null ? null : approval,
        protocol: get(r, 'd.protocol') == null ? null : get(r, 'd.protocol'), unguarded: effect === 'irreversible' && approval !== 'human' };
    });
    const ids = new Set([...agents, ...edges.flatMap(e => [e.src, e.dst])]);
    const nodes = [...ids].map(id => model.elements.get(id)).filter(Boolean).map(e => ({ id: e.id, name: e.name, kind: e.kind, agent: agents.has(e.id),
      pattern: agents.has(e.id) && get(e, 'd.agent.pattern') != null ? get(e, 'd.agent.pattern') : null, autonomy: agents.has(e.id) && get(e, 'd.agent.autonomy') != null ? get(e, 'd.agent.autonomy') : null }));
    return { nodes: agents.size ? nodes : [], edges: agents.size ? edges : [], agents: agents.size, unguarded: edges.filter(e => e.unguarded).length };
  }

  // ---------- agent evals ----------
  // evals/<id>.yaml names an agent, a command that writes a results file, and thresholds on its metrics.
  // The runner only reports numbers; designc applies the thresholds, so the same results always give the same verdict.
  const THRESHOLD = /^\s*([A-Za-z_][\w.-]*)\s*(>=|<=|==|>|<)\s*(-?\d+(?:\.\d+)?)\s*$/;
  function parseThreshold(text) {
    const m = typeof text === 'string' ? THRESHOLD.exec(text) : null;
    if (!m) return { error: `"${text}" is not "<metric> <op> <number>", e.g. task_success >= 0.85` };
    return { metric: m[1], op: m[2], value: Number(m[3]) };
  }
  const THRESHOLD_OPS = { '>=': (a, b) => a >= b, '<=': (a, b) => a <= b, '>': (a, b) => a > b, '<': (a, b) => a < b, '==': (a, b) => a === b };
  function scoreEval(evalDef, results) {
    const list = (evalDef && evalDef.thresholds) || [];
    if (!list.length) return { error: `eval ${evalDef && evalDef.id} has no thresholds` };
    const parsed = list.map(parseThreshold);
    const bad = parsed.find(t => t.error);
    if (bad) return { error: bad.error };
    if (!results || typeof results !== 'object' || Array.isArray(results)) return { error: 'results must be an object with metrics and cases' };
    const metrics = results.metrics;
    if (!metrics || typeof metrics !== 'object' || Array.isArray(metrics) || !Object.values(metrics).every(v => typeof v === 'number' && Number.isFinite(v)))
      return { error: 'results.metrics must be an object of numbers' };
    if (!Number.isInteger(results.cases) || results.cases < 0) return { error: 'results.cases must be a whole number, 0 or more' };
    const thresholds = parsed.map(t => {
      const actual = Object.prototype.hasOwnProperty.call(metrics, t.metric) ? metrics[t.metric] : null;
      return { ...t, actual, ok: actual !== null && THRESHOLD_OPS[t.op](actual, t.value) };
    });
    const reasons = thresholds.filter(t => !t.ok).map(t => t.actual === null ? `${t.metric} is missing from the results` : `${t.metric} ${t.actual} is not ${t.op} ${t.value}`);
    const out = { outcome: reasons.length ? 'fail' : 'pass', metrics, cases: results.cases, thresholds };
    if (reasons.length) out.reason = reasons.join('; ');
    return out;
  }

  // The hash of an eval file's text, line endings normalised so a Windows checkout hashes like the commit.
  const evalHash = e => hash16(String((e && e._text) || '').replace(/\r\n/g, '\n'));
  const elementsOf = model => (model && model.elements ? [...model.elements.values()] : []);
  const AGE = /^(\d+)\s*([mhd])$/i;
  const AGE_MS = { m: 60000, h: 3600000, d: 86400000 };
  const insideRegistry = p => !/^([A-Za-z]:|[\\/])/.test(p) && !p.split(/[\\/]/).includes('..');
  function evalProblems(e) {
    const out = [];
    const missing = ['agent', 'command', 'results'].filter(k => typeof e[k] !== 'string' || !e[k].trim());
    if (missing.length) out.push(`needs ${missing.join(', ')}`);
    const list = Array.isArray(e.thresholds) ? e.thresholds : [];
    if (!list.length) out.push('needs thresholds');
    else { const bad = list.map(parseThreshold).find(t => t.error); if (bad) out.push(bad.error); }
    if (e.maxAge != null && !AGE.test(String(e.maxAge))) out.push(`maxAge "${e.maxAge}" is not like 30m, 12h or 7d`);
    if (typeof e.results === 'string' && e.results.trim() && !insideRegistry(e.results)) out.push('results must be a path inside the registry');
    return out;
  }
  // One row per element that declares d.agent.autonomy. approve-writes and autonomous agents block the gate
  // unless the latest result for their eval passes and is current: run under this eval file, against this agent
  // (Core.fingerprint), and within maxAge when the eval sets one. A suggest agent gets a row but never blocks.
  function evalReport({ model, evals = [], ledger = [], now = Date.now() }) {
    const byId = new Map();
    for (const e of evals) if (e && e.id != null && !byId.has(String(e.id))) byId.set(String(e.id), e);
    const rows = [];
    for (const el of elementsOf(model)) {
      const autonomy = get(el, 'd.agent.autonomy');
      if (!autonomy) continue;
      const evalId = get(el, 'd.agent.eval');
      const row = { agent: el.name, agentId: el.id, autonomy, evalId, status: 'missing', reason: '', latest: null, thresholds: [], defInvalid: false };
      const done = (status, reason) => { row.status = status; row.reason = reason; row.blocking = autonomy !== 'suggest' && status !== 'passing'; rows.push(row); };
      if (!evalId) { done('missing', 'd.agent.eval names no eval'); continue; }
      const d = byId.get(String(evalId));
      if (!d) { done('missing', `eval ${evalId} is not in evals/`); continue; }
      row.evalHash = evalHash(d);
      if (evalProblems(d).length) { row.defInvalid = true; done('invalid', `eval ${evalId} is invalid`); continue; }
      if (d.agent !== el.name) { done('invalid', `eval ${evalId} is for "${d.agent}", not ${el.name}`); continue; }
      const mine = ledger.filter(e => e.kind === 'eval' && e.eval === String(d.id)).sort((a, b) => (b._ts || 0) - (a._ts || 0));
      const current = mine.filter(e => e.eval_hash === row.evalHash);
      const latest = row.latest = current[0] || null;
      row.thresholds = (d.thresholds || []).map(parseThreshold).map(t => {
        const actual = latest && Object.prototype.hasOwnProperty.call(latest.metrics || {}, t.metric) ? latest.metrics[t.metric] : null;
        return { ...t, actual, ok: actual !== null && THRESHOLD_OPS[t.op](actual, t.value) };
      });
      if (!mine.length) done('unchecked', `eval ${evalId} has no result recorded yet`);
      else if (!latest) done('stale', `eval ${evalId}: the last result was run under a different version of the eval file`);
      else if (latest.fingerprint !== fingerprint(model, el.id).hash) done('stale', `eval ${evalId}: the agent changed since the last result`);
      else if (d.maxAge != null && now - (latest._ts || 0) > Number(AGE.exec(String(d.maxAge))[1]) * AGE_MS[AGE.exec(String(d.maxAge))[2].toLowerCase()])
        done('stale', `eval ${evalId}: the last result is older than ${d.maxAge}`);
      else if (latest.outcome !== 'pass') done('failing', `eval ${evalId} failed: ${latest.reason || 'a threshold was not met'}`);
      else done('passing', '');
    }
    return rows;
  }
  function evalClauses({ model, evals, ledger, now }) {
    const clauses = [], said = new Set(), seen = new Set(), names = new Set(elementsOf(model).map(e => e.name));
    for (const e of evals) {
      if (!e || typeof e !== 'object') continue;
      if (seen.has(e.id) && !said.has(e.id)) { said.add(e.id); clauses.push({ kind: 'duplicate', text: `duplicate id ${e.id}`, eval: e.id }); }
      seen.add(e.id);
      const problems = evalProblems(e);
      if (problems.length) clauses.push({ kind: 'eval', text: `eval ${e.id} is invalid: ${problems.join('; ')}`, evalId: e.id });
      if (typeof e.agent === 'string' && e.agent.trim() && !names.has(e.agent)) clauses.push({ kind: 'eval', text: `eval ${e.id}: agent "${e.agent}" is not in the model`, evalId: e.id });
    }
    for (const r of evalReport({ model, evals, ledger, now })) {
      if (!r.blocking || r.defInvalid) continue;
      clauses.push({ kind: 'eval', text: `${r.agent} (${r.autonomy}) needs a passing eval: ${r.reason}`, agent: r.agent, evalId: r.evalId || null });
    }
    return clauses;
  }

  // ---------- blast radius ----------
  // Who is hurt when one element misbehaves (fails, stalls or answers wrongly). Callers are found by
  // walking relationships backwards. A sync caller goes `down` and the damage continues through it; an
  // async caller is `degraded` (decoupled, so its backlog grows but it stays up) and stops there; a caller
  // whose interaction is undeclared is `unknown` and stops there, because nothing is guessed. An element
  // reached several ways keeps the worst class. `paths` holds one shortest route per affected element.
  const BLAST_RANK = { unknown: 1, degraded: 2, down: 3 };
  // Mode 'unavailable': `ref` is a deployment node path ("Azure/Zone A") in `environment`. An element is
  // lost when every one of its instances in that environment sits under the node; each lost element then
  // spreads as in 'misbehaves', the worst class winning. Lost elements are listed as lost, not as down.
  function unavailableRadius(model, nodePath, environment) {
    const envs = (model.deployment && model.deployment.environments) || [];
    if (!envs.length) return { error: 'This model has no deploymentEnvironment, so unavailability cannot be assessed.' };
    const env = envs.find(e => e.name === environment) || (environment == null && envs.length === 1 ? envs[0] : null);
    if (!env) return { error: `Environment "${environment}" is not declared. Choose one of: ${envs.map(e => e.name).join(', ')}.` };
    const segs = String(nodePath).split('/');
    let list = env.nodes, hit = null;
    for (const s of segs) { hit = list.find(n => n.kind !== 'containerInstance' && n.name === s); if (!hit) break; list = hit.children; }
    if (!hit) return { error: `No deployment node "${nodePath}" in ${env.name}.` };
    const instances = (nodes, out = []) => { for (const n of nodes) { if (n.ref) out.push(n.ref); instances(n.children, out); } return out; };
    const inside = new Set(instances([hit]));
    // an instance counts as outside when it is not under `hit`
    const rest = new Set(); (function walk(nodes) { for (const n of nodes) { if (n === hit) continue; if (n.ref) rest.add(n.ref); walk(n.children); } })(env.nodes);
    const lost = [...inside].filter(id => !rest.has(id));
    const survivors = [...inside].filter(id => rest.has(id));
    const rank = { down: 3, degraded: 2, unknown: 1 };
    const best = new Map(), paths = [];
    for (const id of lost) {
      const r = blastRadius(model, id, { mode: 'misbehaves' });
      for (const p of r.paths) { const eid = [...model.elements.values()].find(e => e.name === p.to).id; if (lost.includes(eid)) continue; const cur = best.get(eid); if (!cur || rank[cur.kind] < rank[p.kind]) best.set(eid, p); }
    }
    const nm = id => model.elements.get(id).name;
    const pick = kind => [...best].filter(([, p]) => p.kind === kind).map(([id]) => ({ id, name: nm(id) }));
    return { node: nodePath, environment: env.name, lost: lost.map(id => ({ id, name: nm(id) })), survivors: survivors.map(id => ({ id, name: nm(id) })),
      down: pick('down'), degraded: pick('degraded'), unknown: pick('unknown'), paths: [...best.values()] };
  }

  function blastRadius(model, elementId, { mode, environment } = {}) {
    if (mode === 'unavailable') return unavailableRadius(model, elementId, environment);
    if (mode !== 'misbehaves') return { error: `Unknown blast radius mode: ${mode}. Supported: misbehaves, unavailable.` };
    if (!model.elements.has(elementId)) return { error: 'No such element' };
    const best = new Map(); // id -> { kind, via: [ids] }
    const queue = [{ id: elementId, via: [elementId] }];
    for (let i = 0; i < queue.length; i++) {
      const { id, via } = queue[i];
      for (const r of model.rels) {
        if (r.dst !== id || r.src === elementId || structural(model, r)) continue;
        const i2 = interaction(r), kind = i2 === 'sync' ? 'down' : i2 === 'async' ? 'degraded' : 'unknown';
        const cur = best.get(r.src);
        if (cur && BLAST_RANK[cur.kind] >= BLAST_RANK[kind]) continue;
        const path = [...via, r.src];
        best.set(r.src, { kind, via: path });
        if (kind === 'down') queue.push({ id: r.src, via: path });
      }
    }
    const pick = kind => [...best].filter(([, v]) => v.kind === kind).map(([id]) => ({ id, name: model.elements.get(id).name }));
    const nm = id => model.elements.get(id).name;
    return {
      down: pick('down'), degraded: pick('degraded'), unknown: pick('unknown'),
      paths: [...best].map(([id, v]) => ({ to: nm(id), kind: v.kind, via: v.via.map(nm) })),
    };
  }

  // ---------- change impact ----------
  // What a model change touches beyond the model: bound decisions whose element (or a rel touching it)
  // changed or went away, requirements tied to those decisions or listing a changed element, and the
  // findings introduced or resolved. Built on diffModels and fingerprint, so it shares their notion of
  // "changed". `decisions` and `requirements` are the registry's parsed files.
  function changeImpact(before, after, { decisions = [], requirements = [], chainHops = 4 } = {}) {
    const diff = diffModels(before, after);
    const touched = new Set();
    for (const e of diff.elements) { touched.add(e.name); if (e.renamedFrom) touched.add(e.renamedFrom); }
    const byName = (m, n) => [...m.elements.values()].find(e => e.name === n) || null;
    const hits = [];
    for (const d of decisions) {
      if (d.status !== 'bound' && d.status !== 'checked') continue;
      for (const name of d.binds || []) {
        const b = byName(before, name), a = byName(after, name);
        let reason = null;
        if (b && !a) reason = 'removed';
        else if (!b && a) reason = 'added';
        else if (b && a && fingerprint(before, b.id).hash !== fingerprint(after, a.id).hash) reason = 'changed';
        if (reason) { hits.push({ id: d.id, element: name, reason: `${name} ${reason}`, requirement: d.requirement || null }); break; }
      }
    }
    const reqIds = new Set(hits.map(h => h.requirement).filter(Boolean));
    for (const r of requirements) if ((r.elements || []).some(n => touched.has(n))) reqIds.add(r.id);
    const keyed = m => new Map(check(m, { chainHops }).filter(f => !f.suppressed && f.sev !== 'note').map(f => [`${f.code}|${f.loc.label}`, { code: f.code, label: f.loc.label, sev: f.sev, msg: f.msg }]));
    const kb = keyed(before), ka = keyed(after);
    return {
      changed: diff.summary.added + diff.summary.removed + diff.summary.changed + diff.summary.relsAdded + diff.summary.relsRemoved + diff.summary.relsChanged,
      decisions: hits.map(({ id, element, reason }) => ({ id, element, reason })),
      requirements: [...reqIds],
      introduced: [...ka].filter(([k]) => !kb.has(k)).map(([, v]) => v),
      resolved: [...kb].filter(([k]) => !ka.has(k)).map(([, v]) => v),
    };
  }

  // ---------- fingerprint ----------
  // What a bound decision is promoted against: the element's own definition plus every relationship
  // touching it. Covers kind, parent, name, technology, all d.* (d.suppress too) and each incident rel
  // (direction, other end, technology, its d.*). Leaves out description, tags, comments, whitespace,
  // order, lines, descendants and rel descriptions. The hash is two FNV-1a 32-bit passes (different
  // offsets) written as 16 hex digits, small enough to mirror in the Python package.
  function fnv(str, seed) {
    let h = seed >>> 0;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    return h.toString(16).padStart(8, '0');
  }
  const hash16 = str => fnv(str, 2166136261) + fnv(str, 2654435769);
  function fingerprint(model, elementId) {
    const el = model.elements.get(elementId);
    if (!el) return null;
    const who = e => (e ? `${e.ident || ''}|${e.name}` : '');
    const dprops = p => Object.keys(p || {}).filter(k => k.startsWith('d.')).sort().map(k => `${k}=${p[k]}`).join(';');
    const rels = model.rels.filter(r => r.src === elementId || r.dst === elementId).map(r => {
      const out = r.src === elementId;
      return `rel ${out ? 'out' : 'in'} ${who(model.elements.get(out ? r.dst : r.src))} [${r.technology || ''}] {${dprops(r.props)}}`;
    }).sort();
    const content = [`kind ${el.kind}`, `parent ${who(model.elements.get(el.parent))}`, `name ${el.name}`, `technology ${el.technology || ''}`, `props {${dprops(el.props)}}`, ...rels].join('\n');
    return { hash: hash16(content), content };
  }
  // Where a promoted_against entry points now: by the recorded identifier first, then by name.
  function resolveBinding(model, entry) {
    const els = [...model.elements.values()];
    return els.find(e => e.ident && e.ident === entry.element) || els.find(e => e.name === entry.name) || null;
  }

  // ---------- gate record ----------
  // The model revision a handover and a gate event both carry: r- plus 8 hex of the model text.
  const modelRevision = text => `r-${hash16(String(text)).slice(0, 8)}`;
  // Canonical JSON: keys sorted at every level, no whitespace. Mirrored in python/designc/record.py.
  const canonical = v => Array.isArray(v) ? `[${v.map(canonical).join(',')}]`
    : v && typeof v === 'object' ? `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`
      : JSON.stringify(v);
  const byCanonical = list => list.map(x => [canonical(x), x]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(p => p[1]);
  const verdictHash = ({ ready, clauses, findings }) => hash16(canonical({ ready, clauses, findings }));
  // One gate ledger event (without envelope) for what the gate says now. Findings keep the label as `on`
  // (Improve joins on element names) and drop lines, messages, hints and related locations. Clauses and
  // findings are in canonical order, so diagnostic order never changes the record or its verdict.
  // What the gate reads from the registry besides the model file. `ledger/` is left out on purpose: recording must not make a run dirty.
const GATE_INPUTS = ['decisions', 'requirements', 'scenarios', 'evals', 'behaviour', 'vocabulary', 'designc.json'];
// Registry-relative changed files (from git status) that are gate inputs.
function dirtyInputs(files, cfg) {
  const model = (cfg && cfg.model) || 'model/workspace.dsl';
  // evals/ holds the definitions (.yaml) the gate reads and the results files it does not, so only the definitions count.
  return files.map(f => f.path).filter(p => p === model || GATE_INPUTS.some(i => p === i || p.startsWith(i + '/')) && !(p.startsWith('evals/') && !/\.ya?ml$/.test(p)));
}
function gateRecord({ modelText, diags, gate, source, git }) {
    const clauses = byCanonical(gate.clauses.map(c => ({ kind: c.kind, text: c.text })));
    const findings = byCanonical(diags.map(d => ({ code: d.code, sev: d.sev, on: d.loc.label, loc: d.loc.kind, unknown: !!d.unknown, suppressed: !!d.suppressed })));
    const ev = { kind: 'gate', source, revision: modelRevision(modelText), ready: !!gate.ready, verdict: verdictHash({ ready: !!gate.ready, clauses, findings }), clauses, findings };
    if (git) { ev.commit = git.commit; ev.dirty = !!git.dirty; }
    return ev;
  }

  // ---------- handover ----------
  // A frozen handover is a folder: handovers/<yyyymmdd>-<hash8>/ holding handover.yaml and verbatim copies
  // of the model, requirements, bound decisions, behaviour (.p) and vocabulary it was frozen from. The
  // hash part comes from the copied content only, so identical content gives an identical id on any day.
  // Pure: the caller reads the files and writes the result.
  function handoverPlan({ date, now, by, model, requirements = [], decisions = [], behaviour = [], vocabulary = [], evals = [], forecast = null }) {
    const content = [model, ...requirements, ...decisions, ...evals, ...behaviour, ...vocabulary].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const id = `${String(date).replace(/-/g, '')}-${hash16(content.map(f => `${f.path}\0${f.text}`).join('\0\0')).slice(0, 8)}`;
    const dir = `handovers/${id}/`;
    const idOf = f => { const m = /^id:\s*["']?([^"'\n#]+?)["']?\s*(#.*)?$/m.exec(f.text); return m ? m[1] : f.path.split('/').pop().replace(/\.ya?ml$/, ''); };
    const q = JSON.stringify;
    const head = `id: ${id}
revision: ${modelRevision(model.text)}
created: ${q(now)}
by: ${q(by)}
model: ${q(model.path)}
requirements: ${q(requirements.map(idOf))}
decisions: ${q(decisions.map(idOf))}
evals: ${q(Object.fromEntries(evals.map(f => [idOf(f), evalHash({ _text: f.text })])))}
${forecast ? `forecast: ${q(forecast)}\n` : ''}files:
${content.map(f => `  - { path: ${q(f.path)}, hash: ${hash16(f.text)} }`).join('\n')}
`;
    return { id, files: [{ path: dir + 'handover.yaml', text: head }, ...content.map(f => ({ path: dir + f.path, text: f.text }))] };
  }

  // Decisions the gate blocks on promotion (no fingerprint, or what they bind changed): a human can re-bind them.
  function rebindable(g) {
    const ids = [];
    for (const c of (g && g.clauses) || []) if (c.kind === 'promotion' && c.decision && !ids.includes(c.decision)) ids.push(c.decision);
    return ids;
  }

  // The model copy inside the newest handover that names one. `handovers` is ordered oldest first.
  function latestHandoverModel(handovers) {
    const h = [...handovers].reverse().find(x => x && x.id && x.model);
    return h ? { id: h.id, path: `handovers/${h.id}/${h.model}` } : null;
  }

  // ---------- semantic diff ----------
  // What changed between two parses of a model, by meaning rather than by line. Identity: the same DSL
  // identifier is the same element; otherwise the same normalised name under the same (matched) parent;
  // otherwise removed and added. No fuzzy matching. Rels are keyed on their matched ends plus their
  // ordinal among parallel rels. Description, tags, order, whitespace and lines never count.
  function diffModels(before, after) {
    const norm = x => String(x).toLowerCase().replace(/[^a-z0-9]/g, '');
    const match = new Map(), taken = new Set(); // before id -> after id
    const bEls = [...before.elements.values()], aEls = [...after.elements.values()];
    const byIdent = new Map(aEls.filter(e => e.ident).map(e => [e.ident, e]));
    for (const b of bEls) { const a = b.ident && byIdent.get(b.ident); if (a && !taken.has(a.id)) { match.set(b.id, a.id); taken.add(a.id); } }
    for (const b of bEls) {
      if (match.has(b.id)) continue;
      const parent = b.parent == null ? null : match.get(b.parent);
      if (b.parent != null && parent == null) continue;
      const a = aEls.find(x => !taken.has(x.id) && norm(x.name) === norm(b.name) && x.parent === parent);
      if (a) { match.set(b.id, a.id); taken.add(a.id); }
    }
    const nameOf = (m, id) => (id == null ? null : (m.elements.get(id) || {}).name || null);
    const propFields = (bp, ap, prefix = '') => {
      const out = [];
      for (const k of [...new Set([...Object.keys(bp), ...Object.keys(ap)])].sort())
        if (bp[k] !== ap[k]) out.push({ field: prefix + k, from: bp[k] == null ? null : bp[k], to: ap[k] == null ? null : ap[k] });
      return out;
    };
    const elements = [];
    for (const b of bEls) {
      const aid = match.get(b.id);
      if (aid == null) { elements.push({ change: 'removed', name: b.name, kind: b.kind, beforeId: b.id, afterId: null, fields: [] }); continue; }
      const a = after.elements.get(aid), fields = [];
      if (b.name !== a.name) fields.push({ field: 'name', from: b.name, to: a.name });
      if (b.kind !== a.kind) fields.push({ field: 'kind', from: b.kind, to: a.kind });
      if ((b.technology || null) !== (a.technology || null)) fields.push({ field: 'technology', from: b.technology || null, to: a.technology || null });
      const pb = nameOf(before, b.parent), pa = nameOf(after, a.parent);
      if (match.get(b.parent) !== a.parent && !(b.parent == null && a.parent == null)) fields.push({ field: 'parent', from: pb, to: pa });
      fields.push(...propFields(b.props, a.props));
      if (fields.length) elements.push({ change: 'changed', name: a.name, kind: a.kind, beforeId: b.id, afterId: a.id, fields, ...(b.name !== a.name ? { renamedFrom: b.name } : {}) });
    }
    for (const a of aEls) if (!taken.has(a.id)) elements.push({ change: 'added', name: a.name, kind: a.kind, beforeId: null, afterId: a.id, fields: [] });

    const keyed = (rels, map) => {
      const n = new Map(), out = new Map();
      for (const r of rels) {
        const s = map(r.src), d = map(r.dst);
        const base = `${s}>${d}`, i = n.get(base) || 0; n.set(base, i + 1);
        out.set(`${base}#${i}`, r);
      }
      return out;
    };
    const bk = keyed(before.rels, id => (match.has(id) ? match.get(id) : `gone:${id}`));
    const ak = keyed(after.rels, id => id);
    const rels = [];
    const label = (m, r) => `${nameOf(m, r.src)} → ${nameOf(m, r.dst)}`;
    for (const [k, b] of bk) {
      const a = ak.get(k);
      if (!a) { rels.push({ change: 'removed', label: label(before, b), ends: [nameOf(before, b.src), nameOf(before, b.dst)], fields: [] }); continue; }
      const fields = [];
      if ((b.technology || null) !== (a.technology || null)) fields.push({ field: 'technology', from: b.technology || null, to: a.technology || null });
      fields.push(...propFields(b.props, a.props));
      if (fields.length) rels.push({ change: 'changed', label: label(after, a), ends: [nameOf(after, a.src), nameOf(after, a.dst)], fields });
    }
    for (const [k, a] of ak) if (!bk.has(k)) rels.push({ change: 'added', label: label(after, a), ends: [nameOf(after, a.src), nameOf(after, a.dst)], fields: [] });

    const count = (list, c) => list.filter(x => x.change === c).length;
    return { elements, rels, summary: { added: count(elements, 'added'), removed: count(elements, 'removed'), changed: count(elements, 'changed'), relsAdded: count(rels, 'added'), relsRemoved: count(rels, 'removed'), relsChanged: count(rels, 'changed') } };
  }

  // ---------- forecast ----------
  // What a handover is likely to cost, priced by the elements it changes against the previous handover's model
  // (`before` null means the first handover: everything counts as added). `history` is
  // Map(element name -> [{handover, tokens, cost}]) from Ledger.elementHistory, passed in as plain data so
  // Core does not depend on Ledger. An element with at least `minSamples` handovers of history is measured:
  // the median is the expected figure and the nearest-rank p90 the high end. Otherwise it is "no basis" and
  // adds nothing, and `coverage` says how many changed elements were priced. Containers and components only.
  function forecast({ before, after, history, minSamples = 3 }) {
    const diff = diffModels(before || parse('workspace { model { } }'), after);
    const priced = new Map(); // name -> why
    const mark = (name, why) => { if (name != null && !priced.has(name)) priced.set(name, why); };
    for (const e of diff.elements.filter(x => x.change === 'added')) mark(e.name, 'added');
    for (const e of diff.elements.filter(x => x.change === 'changed')) mark(e.name, 'changed');
    for (const r of diff.rels) for (const n of r.ends || []) mark(n, 'relationship');
    const hasHistory = history instanceof Map ? history : new Map(Object.entries(history || {}));
    const rows = [];
    for (const [name, why] of priced) {
      const same = [...after.elements.values()].filter(x => x.name === name && (x.kind === 'container' || x.kind === 'component'));
      if (!same.length) continue;
      // Spend is recorded under the element's name, so a name two elements share cannot be told apart: no basis.
      const ambiguous = same.length > 1;
      const h = ambiguous ? [] : hasHistory.get(name) || [];
      const row = { name, kind: same[0].kind, why, samples: h.length, status: 'no basis', expected: null, high: null };
      if (ambiguous) row.ambiguous = true;
      if (h.length >= minSamples) {
        const pick = key => {
          const v = h.map(x => x[key]).sort((a, b) => a - b), mid = v.length >> 1;
          return { expected: v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2, high: v[Math.ceil(0.9 * v.length) - 1] };
        };
        const t = pick('tokens'), c = pick('cost');
        Object.assign(row, { status: 'measured', expected: { tokens: t.expected, cost: c.expected }, high: { tokens: t.high, cost: c.high } });
      }
      rows.push(row);
    }
    const sum = (key, f) => rows.reduce((s, r) => s + (r[key] ? r[key][f] : 0), 0);
    const round = x => Math.round(x * 1e6) / 1e6;
    const total = { expected: { tokens: sum('expected', 'tokens'), cost: round(sum('expected', 'cost')) }, high: { tokens: sum('high', 'tokens'), cost: round(sum('high', 'cost')) } };
    return { rows, removed: diff.elements.filter(x => x.change === 'removed').map(x => x.name), total, coverage: { priced: rows.filter(r => r.status === 'measured').length, changed: rows.length } };
  }

  // The part of a forecast that is frozen into handover.yaml: the figures, how many elements they cover and
  // one row per priced element. `baseline` is the id of the handover it was compared against (null for the first).
  function freezeForecast(f, { currency = 'GBP', baseline = null } = {}) {
    return {
      currency, baseline,
      tokens: { expected: f.total.expected.tokens, high: f.total.high.tokens },
      cost: { expected: f.total.expected.cost, high: f.total.high.cost },
      coverage: f.coverage,
      elements: f.rows.map(r => ({ name: r.name, why: r.why, status: r.status, samples: r.samples,
        tokens: r.expected ? { expected: r.expected.tokens, high: r.high.tokens } : null,
        cost: r.expected ? { expected: r.expected.cost, high: r.high.cost } : null })),
      removed: f.removed,
    };
  }

  // Plain text for a leadership update: the frozen forecast against what was actually spent. Nothing is sent
  // anywhere; the Build view copies it to the clipboard. `forecast` is the frozen block (or null), `actual`
  // is Ledger.handoverActuals (or null).
  function forecastSummary({ id, created, requirements = [], forecast, actual }) {
    const num = n => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    const cur = forecast && forecast.currency || 'GBP';
    const money = n => `${cur} ${n.toFixed(2)}`;
    const signed = (n, f) => (n < 0 ? '-' : '+') + f(Math.abs(n));
    const lines = [`Handover ${id} (${String(created).slice(0, 10)})`];
    if (requirements.length) lines.push(`Requirements: ${requirements.join(', ')}`);
    if (!forecast) lines.push('Forecast: not recorded (frozen before forecasts existed)');
    else {
      lines.push(`Forecast: ${num(forecast.tokens.expected)} tokens, ${money(forecast.cost.expected)} (up to ${num(forecast.tokens.high)} tokens, ${money(forecast.cost.high)})`);
      const { priced, changed } = forecast.coverage;
      lines.push(priced === changed ? `Covers all ${changed} changed elements` : `Covers ${priced} of ${changed} changed elements; ${changed - priced} has no history yet`.replace(/; (\d+) has/, (m, n) => `; ${n} ${n === '1' ? 'has' : 'have'}`));
    }
    if (!actual || (!actual.tasks && !actual.closed)) lines.push('Actual: none recorded yet');
    else {
      lines.push(`Actual ${actual.closed ? `(${actual.closed})` : 'so far (in progress)'}: ${num(actual.tokens)} tokens, ${money(actual.cost)} across ${actual.tasks} ${actual.tasks === 1 ? 'task' : 'tasks'}`);
      if (forecast) {
        const dt = actual.tokens - forecast.tokens.expected, dc = actual.cost - forecast.cost.expected;
        lines.push(`Difference: ${signed(dt, num)} tokens${forecast.tokens.expected ? ` (${signed(dt, x => Math.round(100 * x / forecast.tokens.expected) + '%')})` : ''}, ${signed(dc, money)}`);
      }
      if (actual.afterClose) lines.push(`${actual.afterClose} ${actual.afterClose === 1 ? 'task' : 'tasks'} recorded after close, not counted`);
    }
    return lines.join('\n');
  }

  // ---------- drift: designed vs as-built ----------
  const key = s => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
  function drift(m, ledger) {
    const idx = new Map();
    for (const e of m.elements.values()) { if (e.kind === 'person') continue; [e.name, ...(get(e, 'd.aka') || [])].forEach(n => { if (!idx.has(key(n))) idx.set(key(n), e); }); }
    const built = ledger.filter(e => e.kind === 'asbuilt_edge');
    if (!built.length) return null;
    const unknownEls = new Set(), undeclared = [], seen = new Set(), mapped = new Set();
    const designed = new Set(m.rels.filter(r => m.elements.get(r.src).kind !== 'person').map(r => r.src + '>' + r.dst));
    for (const b of built) {
      const s = idx.get(key(b.from)), d = idx.get(key(b.to));
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
    return { toDesign, toBuilt, relStatus, undeclared, unrealised, unknownEls, missingEls };
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
        // An exact path matches one file of that name only (System 2's meaning); say so when it names a folder.
        const under = a.matched || /[*?]/.test(p.value) ? 0 : files.filter(f => f.startsWith(p.value + '/')).length;
        if (under) a.hint = `${p.value} is a folder with ${under} file${under === 1 ? '' : 's'}; System 2 matches it as a single file. Did you mean ${p.value}/**?`;
        areas.push(a);
      }
    }
    const unclaimed = areas.length ? files.filter(f => !areas.some(a => PP.matches(a.pattern, f))).sort() : [];
    return { areas, unclaimed, files: files.length };
  }

  function driftComponents(design, built) {
    const cmap = driftModels(atLevel(design, 'container'), atLevel(built, 'container'));
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
      if (m) { if (m[0] === 'container') { kw = i; break; } i += m[0].length; } else i++;
    }
    if (kw < 0) return { error: `The declaration line of "${el.name}" has no container keyword.` };
    let p = trivia(kw + 'container'.length), lastEnd = kw + 'container'.length;
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
    let text;
    if (close >= 0) {
      const cl = lineAt(close);
      if (!src.slice(starts[cl], close).trim()) text = src.slice(0, starts[cl]) + body.join(eol) + eol + src.slice(starts[cl]);
      else text = src.slice(0, close).replace(/[ \t]+$/, '') + eol + body.join(eol) + eol + base + src.slice(close);
    } else {
      let e = src.indexOf('\n', lastEnd); if (e < 0) e = n; else if (src[e - 1] === '\r') e--;
      text = src.slice(0, lastEnd) + ' {' + src.slice(lastEnd, e) + eol + body.join(eol) + eol + base + '}' + src.slice(e);
    }
    if (parse(text).errors.length > design.errors.length) return { error: `The spliced design for "${el.name}" would not parse.` };
    return { text };
  }

  // Extension hooks (designc-canvas): add property specs and rules without forking the compiler.
  function registerProperties(specs) {
    for (const target of ['element', 'relationship']) Object.assign(SPECS[target], (specs && specs[target]) || {});
  }
  function registerRules(rules) {
    for (const r of rules || []) { const i = RULES.findIndex(x => x.code === r.code); if (i >= 0) RULES[i] = r; else RULES.push(r); }
  }
  const specsFor = target => ({ ...SPECS[target] });

  return { parse, check, gate, rebindable, latestHandoverModel, slugId, diffModels, deploymentView, deploymentChoices, deploymentScope, bySystem, splitBySystem, scenarioReport, utilityTree, agentTopology, latestFitness, parseThreshold, scoreEval, evalHash, evalReport, changeImpact, forecast, freezeForecast, forecastSummary, blastRadius, timing, amplificationFrom, fingerprint, resolveBinding, handoverPlan, modelRevision, verdictHash, gateRecord, GATE_INPUTS, dirtyInputs, drift, driftModels, driftComponents, codeAreaDrift, atLevel, view, containerLevelText, spliceComponents, latestCheck, RULES, get, isStore, interaction, registerProperties, registerRules, specsFor };
})();
if (typeof module !== 'undefined') module.exports = Core;
