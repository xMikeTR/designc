// ===== designc core: Structurizr DSL subset -> IR -> diagnostics =====
const Core = (() => {
  const DM = typeof require === 'function' && typeof module === 'object' ? require('./domain.js') : Domain;
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
  // d.code is where an element's code lives in the handover (docs/path-patterns.json); what is reported here would
  // make a handover a coding agent cannot trust.
  function codeAreaProblems(e) {
    const raw = e.props['d.code'], entries = String(raw).split(',').map(s => s.trim()), out = [];
    if (entries.every(s => !s)) out.push([`"d.code" = "${raw}": lists no paths`, 'remove d.code, or name where the element\'s code lives']);
    else entries.forEach((s, i) => {
      if (!s) { out.push([`"d.code" = "${raw}": entry ${i + 1} is blank`, null]); return; }
      const p = PP.create(s);
      if (!p.ok) out.push([`"d.code" = "${raw}": ${p.error}`, 'use repo-relative paths with *, ? and ** as a whole segment']);
    });
    if (e.props['d.risk'] == null) out.push(['d.code needs d.risk (the handover gives both or neither)', 'set d.risk: low | medium | high']);
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

  // Where the generated acceptance specs live in a handover (slice 30); no element's d.code may claim it (slice 31).
  const RESERVED_TEST_PATH = PP.create('tests/acceptance/**').value;
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
    { code: 'DC009', title: 'Overlapping code areas', source: 'Handover contract: each file belongs to one element\'s d.code (docs/path-patterns.json)',
      doc: 'Each file belongs to one element. d.code may be declared on one level per branch (a container or its components, not both), and the areas of unrelated elements must not overlap. Overlap is judged by the path pattern contract, so two wildcard segments count as overlapping.',
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
          const taken = pats.find(p => PP.mayOverlap(p, RESERVED_TEST_PATH));
          if (taken) out.push(D('DC009', 'error', `code area "${taken}" may overlap the reserved acceptance path "${RESERVED_TEST_PATH}"`, m.locEl(e),
            { hint: 'tests/acceptance/** holds the generated acceptance specs; the agent that writes code never owns them. Narrow the area to the source folder' }));
          for (const a of areas) {
            if (m.isAncestor(a.e.id, e.id) || m.isAncestor(e.id, a.e.id)) continue;
            const hit = pats.flatMap(p => a.pats.filter(q => PP.mayOverlap(p, q)).map(q => [p, q]))[0];
            if (hit) out.push(D('DC009', 'error', `code area "${hit[0]}" may overlap "${hit[1]}" of "${a.e.name}"`, m.locEl(e),
              { hint: 'make the areas disjoint: a file in both areas has no single owner', related: [m.locEl(a.e)] }));
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
  // The live decisions that answer one finding: same code, binding one of its elements; bound ones first. Display only.
  function decisionsFor(f, decisions) {
    const arr = v => (Array.isArray(v) ? v : []);
    return decisions.filter(d => d.status !== 'superseded' && arr(d.resolves).includes(f.code) && arr(d.binds).some(b => (f.loc.names || []).includes(b)))
      .sort((a, b) => (b.status === 'bound') - (a.status === 'bound'));
  }
  function gate({ model, diags, decisions, requirements, ledger, registryErrors = [], evidenceHosts = [], businessOwners = [], scenarios = [], evals = [], acceptance = [], tokens = null, minTextSize = DEFAULT_MIN_TEXT, domains = null, now = Date.now() }) {
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
      clauses.push({ kind: 'finding', text: `${f.code} on ${f.loc.label} is neither fixed nor accepted`, line: f.loc.line, finding: f, about: [...f.loc.names, ...f.related.flatMap(r => r.names || [])] });
    }
    const boundBusiness = new Set(decisions.filter(d => d.status === 'bound' && d.kind === 'business').map(d => d.id));
    for (const dec of decisions) {
      const kind = dec.kind == null ? 'technical' : dec.kind;
      if (kind !== 'business' && kind !== 'technical') clauses.push({ kind: 'decision', text: `${dec.id} has kind ${kind}, expected business or technical`, decision: dec.id });
      if (dec.status !== 'bound') { clauses.push({ kind: 'decision', text: `${dec.id} is ${dec.status || 'minted'}, not bound`, decision: dec.id }); continue; }
      const business = kind === 'business';
      assumptionClauses(dec, today, clauses);
      if (business) businessEvidence(dec, evidenceHosts, businessOwners, clauses);
      else if (dec.effect === 'accept' && !(dec.relies_on || []).some(id => boundBusiness.has(id)))
        clauses.push({ kind: 'decision', text: `${dec.id} accepts a risk without a bound business decision`, decision: dec.id });
      // An accepted risk rests on its business decision, so it needs no check; a TODO placeholder is not a check.
      if (!business && !(dec.effect === 'accept' && !(dec.checks || []).some(c => c && !/^TODO/.test(String(c))))) {
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
      clauses.push({ kind: 'needs', text: `open needs-decision ${nd.id || ''}: ${nd.question}`.trim(), needs: nd, ...(nd.element ? { about: [String(nd.element)] } : {}) });
    for (const s of scenarios) {
      if (!s || typeof s !== 'object' || !s.id || !s.artifact || !s.attribute || !s.measure) { clauses.push({ kind: 'scenario', text: `${(s && s.id) || 'a scenario'} needs artifact, attribute and measure` }); continue; }
    }
    for (const s of scenarios) {
      if (!s || typeof s !== 'object' || !s.id) continue;
      for (const f of ['importance', 'difficulty']) if (s[f] != null && !RATINGS.includes(s[f])) clauses.push({ kind: 'scenario', text: `${s.id}: ${f} must be high, medium or low` });
    }
    for (const r of Core.scenarioReport({ model, scenarios: scenarios.filter(s => s && s.id && s.artifact && s.attribute && s.measure), ledger })) {
      if (r.status === 'unresolved') clauses.push({ kind: 'scenario', text: `${r.id}: artifact "${r.artifact}" is not in the model`, about: [r.artifact] });
      else if (r.analytic.status === 'not-met') clauses.push({ kind: 'scenario', text: `${r.id} is not met: availability ≈ ${r.analytic.value.toFixed(2)}% against ${r.measure.op === '<=' ? '≤' : '≥'} ${r.measure.value}%`, about: [r.artifact] });
      if (r.fitness.status === 'failing') clauses.push({ kind: 'scenario', text: `${r.id}: fitness function failing`, about: [r.artifact] });
    }
    clauses.push(...Core.evalClauses({ model, evals, ledger, now }));
    clauses.push(...acceptanceClauses({ model, acceptance, requirements, decisions }));
    clauses.push(...tokenClauses(tokens, minTextSize));
    if (!domains) return { ready: clauses.length === 0, clauses };
    const dc = domainClauses({ model, ledger, ...domains });
    clauses.push(...dc.clauses);
    return { ready: clauses.length === 0, clauses, notes: dc.notes };
  }
  // ---------- domain packs ----------
  // domains: {listed, packs: [{key, path, text}], sources: {key: text|null}, behaviour: [{path, text}]}. The owners
  // are the model's d.owns declarations; the rules are Domain.clauses.
  function domainOwners(model) {
    return [...model.elements.values()].map(e => ({ id: e.id, name: e.name, owns: get(e, 'd.owns') || [] })).filter(o => o.owns.length);
  }
  function domainClauses({ model, ledger, listed = [], packs = [], sources = {}, behaviour = [] }) {
    return DM.clauses({ packs, listed, sources, behaviour, ledger: ledger || [], owners: domainOwners(model), isAncestor: (a, b) => model.isAncestor(a, b), hash: hash16 });
  }
  // ---------- design tokens (ROADMAP slice 34) ----------
  // design-tokens/tokens.json is a W3C design tokens file. A text size token (a token whose path has a font size
  // or text size segment) below the minimum is a gate clause: the build must not be able to ship unreadable text.
  // Sizes read in px or rem (1rem = 16px); a bare number is px. Nothing else is guessed.
  const DEFAULT_MIN_TEXT = 12;
  function tokenSizePx(v) {
    if (v && typeof v === 'object' && !Array.isArray(v) && 'value' in v) return tokenSizePx(typeof v.unit === 'string' ? `${v.value}${v.unit}` : v.value);
    if (typeof v === 'number') return v;
    const m = /^\s*(-?\d+(?:\.\d+)?)\s*(px|rem)?\s*$/.exec(String(v));
    return m ? Number(m[1]) * (m[2] === 'rem' ? 16 : 1) : null;
  }
  function isTextSizePath(path) {
    const seg = path.map(x => String(x).toLowerCase().replace(/[^a-z0-9]/g, ''));
    return seg.some((x, i) => x === 'fontsize' || x === 'textsize' || (x === 'font' && seg[i + 1] === 'size') || (x === 'text' && seg[i + 1] === 'size'));
  }
  function tokenClauses(text, minTextSize = DEFAULT_MIN_TEXT) {
    if (text == null) return [];
    const say = t => ({ kind: 'tokens', text: `design-tokens/tokens.json: ${t}` });
    let doc;
    try { doc = JSON.parse(text); } catch { return [say('does not parse as JSON. Fix the file, then check again')]; }
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return [say('must be a JSON object of token groups')];
    const out = [];
    const walk = (node, path) => {
      if (!node || typeof node !== 'object' || Array.isArray(node)) return;
      if ('$value' in node) {
        if (!isTextSizePath(path)) return;
        const px = tokenSizePx(node.$value);
        const name = path.join('.');
        if (px == null) out.push(say(`${name} is a text size but its value is not px or rem. Write it as "16px" or "1rem"`));
        else if (px < minTextSize) out.push(say(`${name} is ${px}px, below the minimum text size of ${minTextSize}px. Raise it, or lower ux.minTextSize in designc.json if that is intended`));
        return;
      }
      for (const [k, v] of Object.entries(node)) if (!k.startsWith('$')) walk(v, [...path, k]);
    };
    walk(doc, []);
    return out;
  }

  // ---------- UI acceptance criteria ----------
  // acceptance/*.yaml binds a requirement and a C4 element (its elements.json id) to the states a screen must
  // handle, each with a given/when/then case. An element tagged `UI` that a requirement lists needs a
  // criterion; every criterion needs a case for ready, loading, empty and error, and for forbidden where the
  // element sits behind an auth boundary (a relationship into it, or into something inside it, with
  // d.authenticated yes) or where the criterion lists forbidden itself. Nothing is guessed: the clause says
  // which state is missing. Mirrored in python/designc/gate.py.
  const UI_STATES = ['ready', 'loading', 'empty', 'error', 'forbidden'];
  // Locator contract (slice 29): a case names the locators it uses (`uses`), each declared in `locators`
  // {name: {role, name}} with a role from this closed list; `label` is Playwright's getByLabel.
  const LOCATOR_ROLES = ['alert', 'button', 'cell', 'checkbox', 'combobox', 'dialog', 'form', 'heading', 'img', 'label', 'link', 'list', 'listitem', 'main', 'navigation', 'option', 'radio', 'region', 'row', 'searchbox', 'status', 'switch', 'tab', 'table', 'tabpanel', 'textbox'];
  function acceptanceClauses({ model, acceptance = [], requirements = [], decisions = [] }) {
    const out = [];
    const say = (text, about) => out.push({ kind: 'acceptance', text, ...(about ? { about } : {}) });
    const inside = (m, id, root) => { for (let c = m.elements.get(id); c; c = c.parent ? m.elements.get(c.parent) : null) if (c.id === root) return true; return false; };
    const authBoundary = el => model.rels.some(r => get(r, 'd.authenticated') === 'yes' && inside(model, r.dst, el.id));
    const valid = [];
    for (const a of acceptance) {
      const id = a && a.id ? a.id : null;
      if (!a || typeof a !== 'object' || !id || !a.requirement || !a.element || !Array.isArray(a.states) || !Array.isArray(a.cases)) {
        say(`${id || 'an acceptance criterion'}: needs requirement, element, states and cases`); continue;
      }
      if (!requirements.some(r => r.id === a.requirement)) say(`${id}: requirement ${a.requirement} is not in the registry`);
      if (a.decision && !decisions.some(d => d.id === a.decision)) say(`${id}: decision ${a.decision} is not in the registry`);
      const el = Core.resolveElement(model, a.element);
      if (!el) { say(`${id}: element "${a.element}" is not in the model`, [String(a.element)]); continue; }
      valid.push({ a, el });
      for (const st of a.states) if (!UI_STATES.includes(st)) say(`${id}: unknown state "${st}" (use ${UI_STATES.join(', ')})`, [el.name]);
      for (const c of a.cases) {
        if (!c || !UI_STATES.includes(c.state)) { say(`${id}: a case names an unknown state "${c && c.state}"`, [el.name]); continue; }
        if (!c.given || !c.then) say(`${id}: case for ${c.state} needs given and then`, [el.name]);
      }
      const locs = a.locators && typeof a.locators === 'object' && !Array.isArray(a.locators) ? a.locators : {};
      if (a.locators != null && locs !== a.locators) say(`${id}: locators must map a name to a role and an accessible name`, [el.name]);
      for (const [n, l] of Object.entries(locs)) {
        if (!l || typeof l !== 'object' || !l.name || !String(l.name).trim()) say(`${id}: locator "${n}" needs a role and an accessible name`, [el.name]);
        else if (!LOCATOR_ROLES.includes(l.role)) say(`${id}: locator "${n}" has role "${l.role}" (use ${LOCATOR_ROLES.join(', ')})`, [el.name]);
      }
      for (const c of a.cases) for (const n of c && Array.isArray(c.uses) ? c.uses : []) {
        if (!Object.prototype.hasOwnProperty.call(locs, n)) say(`${id}: case for ${c.state} uses locator "${n}" that is not declared`, [el.name]);
      }
      if (a.ux != null) {
        const u = a.ux, ux = x => say(`${id}: ux ${x}`, [el.name]);
        if (!u || typeof u !== 'object' || Array.isArray(u)) ux('must be a mapping of keyboard, focus_order, focus_return and breakpoints');
        else {
          if ('keyboard' in u && typeof u.keyboard !== 'boolean') ux('keyboard must be true or false');
          const declared = n => Object.prototype.hasOwnProperty.call(locs, n);
          if ('focus_order' in u) {
            if (!Array.isArray(u.focus_order) || !u.focus_order.length) ux('focus_order must list locator names in tab order');
            else for (const n of u.focus_order) if (!declared(n)) ux(`focus_order names locator "${n}" that is not declared`);
          }
          if ('focus_return' in u && !declared(u.focus_return)) ux(`focus_return names locator "${u.focus_return}" that is not declared`);
          if ('breakpoints' in u && (!Array.isArray(u.breakpoints) || !u.breakpoints.length || u.breakpoints.some(b => !Number.isInteger(b) || b < 200 || b > 4000))) ux('breakpoints must be whole pixel widths between 200 and 4000');
        }
      }
      const need = ['ready', 'loading', 'empty', 'error', ...(authBoundary(el) || a.states.includes('forbidden') ? ['forbidden'] : [])];
      for (const st of need) if (!a.cases.some(c => c && c.state === st)) say(`${id}: no case for state ${st}`, [el.name]);
    }
    for (const req of requirements) {
      for (const n of req.elements || []) {
        for (const el of model.elements.values()) {
          if (el.name !== n || !el.tags.has('UI')) continue;
          if (!valid.some(v => v.a.requirement === req.id && v.el.id === el.id)) say(`${req.id}: ${el.name} is a UI element with no acceptance criterion`, [el.name]);
        }
      }
    }
    return out;
  }
  // The gate as one work item sees it (ROADMAP slice 24): a clause counts when it touches an in-scope element.
  // Model-wide clauses (parse, registry, duplicate ids) always count. A decision clause counts when the decision
  // binds an in-scope element; a requirement clause when it is the item's requirement; any other clause when its
  // `about` names one. A clause that names nothing counts: it is never hidden because it cannot be placed.
  // `elements` are element names; the hierarchical label of each also matches (a needs-decision names either).
  function scopedGate(g, { model, elements = [], requirement = null, decisions = [] }) {
    const inScope = new Set(elements);
    for (const e of model.elements.values()) if (inScope.has(e.name)) inScope.add(model.label(e.id));
    const touches = names => names.some(n => inScope.has(n));
    const clauses = g.clauses.filter(c => {
      if (c.kind === 'parse' || c.kind === 'registry' || c.kind === 'duplicate') return true;
      if (c.kind === 'requirement') return c.requirement === requirement;
      if (c.decision != null) { const d = decisions.find(x => x.id === c.decision); return !d || touches(d.binds || []); }
      return c.about ? touches(c.about) : true;
    });
    return { ready: clauses.length === 0, clauses, scoped: true, outside: g.clauses.length - clauses.length };
  }
  // A business decision rests on evidence: an https URL on a host the registry allows (designc.json evidenceHosts).
  // Bound by one of designc.json businessOwners, the bind itself is the record, so no link is needed.
  function businessEvidence(dec, hosts, owners, clauses) {
    const say = text => clauses.push({ kind: 'evidence', text, decision: dec.id });
    if (!dec.evidence && owners.includes(dec.promoted_by)) return;
    if (!dec.evidence) return say(`${dec.id} is a business decision without evidence`);
    let u = null;
    try { u = new URL(String(dec.evidence)); } catch { /* reported below */ }
    if (!u || u.protocol !== 'https:') return say(`${dec.id}: evidence must be an https URL`);
    if (!hosts.includes(u.hostname)) say(`${dec.id}: evidence host ${u.hostname} is not allowed (see evidenceHosts in designc.json)`);
  }
  function latestCheck(ledger, decId) {
    return ledger.filter(e => e.kind === 'check' && e.decision === decId).sort((a, b) => (b._ts || 0) - (a._ts || 0))[0] || null;
  }

  const RATINGS = ['high', 'medium', 'low'];

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
const GATE_INPUTS = ['decisions', 'requirements', 'scenarios', 'acceptance', 'design-tokens', 'evals', 'behaviour', 'vocabulary', 'domain', 'designc.json'];
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

  // Extension hooks (designc-canvas): add property specs and rules without forking the compiler.
  function registerProperties(specs) {
    for (const target of ['element', 'relationship']) Object.assign(SPECS[target], (specs && specs[target]) || {});
  }
  function registerRules(rules) {
    for (const r of rules || []) { const i = RULES.findIndex(x => x.code === r.code); if (i >= 0) RULES[i] = r; else RULES.push(r); }
  }
  const specsFor = target => ({ ...SPECS[target] });

  return { _shared: { makeModel, hash16, RESERVED_TEST_PATH, DM, PP, get, structural, RATINGS }, parse, check, gate, domainOwners, scopedGate, acceptanceClauses, tokenClauses, DEFAULT_MIN_TEXT, decisionsFor, slugId, diffModels, timing, amplificationFrom, fingerprint, resolveBinding, modelRevision, verdictHash, gateRecord, GATE_INPUTS, dirtyInputs, latestCheck, RULES, get, isStore, interaction, registerProperties, registerRules, specsFor };
})();
if (typeof module !== 'undefined') {
  module.exports = Core;
  require('./core-drift.js');
  require('./core-deployment.js');
  require('./core-scenarios.js');
  require('./core-blast.js');
  require('./core-forecast.js');
  require('./core-handover.js');
  require('./core-levels.js');
}
