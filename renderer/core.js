// ===== designc core: Structurizr DSL subset -> IR -> diagnostics =====
const Core = (() => {
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
    const els = new Map(), idents = new Map(), pending = []; let name = 'Untitled workspace', auto = 0;
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
    return makeModel(name, els, rels, errors);
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
      'd.suppress': { k: 'suppress' },
    },
    element: {
      'd.instances': { k: 'int' }, 'd.critical': { k: 'enum', v: YN }, 'd.zone': { k: 'str' },
      'd.availability': { k: 'float' }, 'd.owns': { k: 'list' }, 'd.store': { k: 'enum', v: YN },
      'd.aka': { k: 'list' }, 'd.suppress': { k: 'suppress' },
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
    }
    return out;
  }

  const interaction = r => get(r, 'd.interaction');
  const isStore = e => (e.props['d.store'] != null ? get(e, 'd.store') === 'yes' : e.tags.has('Database'));
  function zone(m, id) { let c = m.elements.get(id); while (c) { const z = get(c, 'd.zone'); if (z) return z; c = c.parent ? m.elements.get(c.parent) : null; } return null; }
  const structural = (m, r) => m.isAncestor(r.src, r.dst) || m.isAncestor(r.dst, r.src);

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
  function gate({ model, diags, decisions, requirements, ledger }) {
    const clauses = [];
    if (model.errors.length) clauses.push({ kind: 'parse', text: `${model.errors.length} model error(s) must be fixed first`, line: model.errors[0].line });
    const bound = decisions.filter(d => d.status === 'bound');
    const covers = (dec, f) => dec.effect === 'accept' && (dec.resolves || []).includes(f.code) && (dec.binds || []).some(b => f.loc.names.includes(b));
    for (const f of diags) {
      if (f.suppressed || f.sev === 'note') continue;
      if (bound.some(dec => covers(dec, f))) continue;
      clauses.push({ kind: 'finding', text: `${f.code} on ${f.loc.label} is neither fixed nor accepted`, line: f.loc.line, finding: f });
    }
    for (const dec of decisions) {
      if (dec.status !== 'bound') { clauses.push({ kind: 'decision', text: `${dec.id} is ${dec.status || 'minted'}, not bound`, decision: dec.id }); continue; }
      if (!(dec.checks || []).length) { clauses.push({ kind: 'decision', text: `${dec.id} has no check`, decision: dec.id }); continue; }
      const last = latestCheck(ledger, dec.id);
      if (!last) clauses.push({ kind: 'check', text: `${dec.id}: no check result recorded yet`, decision: dec.id });
      else if (last.outcome !== 'pass') clauses.push({ kind: 'check', text: `${dec.id}: last check failed`, decision: dec.id });
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
    return { ready: clauses.length === 0, clauses };
  }
  function latestCheck(ledger, decId) {
    return ledger.filter(e => e.kind === 'check' && e.decision === decId).sort((a, b) => (b._ts || 0) - (a._ts || 0))[0] || null;
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

  // Extension hooks (designc-canvas): add property specs and rules without forking the compiler.
  function registerProperties(specs) {
    for (const target of ['element', 'relationship']) Object.assign(SPECS[target], (specs && specs[target]) || {});
  }
  function registerRules(rules) {
    for (const r of rules || []) { const i = RULES.findIndex(x => x.code === r.code); if (i >= 0) RULES[i] = r; else RULES.push(r); }
  }
  const specsFor = target => ({ ...SPECS[target] });

  return { parse, check, gate, drift, driftModels, driftComponents, atLevel, view, containerLevelText, latestCheck, RULES, get, isStore, interaction, registerProperties, registerRules, specsFor };
})();
if (typeof module !== 'undefined') module.exports = Core;
