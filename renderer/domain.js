/* designc desktop: domain packs. Pure, no I/O, no dependencies.
   Dual-load like renderer/pathpattern.js: <script src="domain.js"> before core.js in the renderer,
   require('./renderer/domain.js') from core.js and tests. python/designc/domain.py mirrors read, qualify,
   pEvents and clauses word for word (test/domain-parity.test.js).
   A pack is a team's DDD domain model: aggregates (with identity), value objects (embedded), events
   (payloads), invariants as text and refs to other packs' aggregates. A project pins a copy in
   domain/<key>.yaml; the gate checks the design against it. The format is read here and nowhere else. */
const Domain = (() => {
  const PRIMITIVES = ['string', 'int', 'decimal', 'bool', 'date', 'datetime', 'money', 'percent', 'id'];
  const CONSTRAINTS = ['type', 'ref', 'oneOf', 'min', 'max', 'minLength', 'maxLength', 'pattern'];
  const isMap = v => v != null && typeof v === 'object' && !Array.isArray(v);
  const names = o => (isMap(o) ? Object.keys(o) : []);
  const andList = xs => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
  function lev(a, b) {
    const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
    for (let j = 1; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    return d[a.length][b.length];
  }

  // ---------- reading a pack ----------
  // read(text, load, key): load is a YAML parser (js-yaml's load). {error} when the file is not a mapping;
  // otherwise {pack, problems}, problems being the DDD and format rules the pack breaks, as sentences.
  function read(text, load, key) {
    let raw;
    try { raw = (load || defaultLoad)(String(text)); } catch (e) { return { error: `does not parse: ${String(e.message || e).split('\n')[0]}` }; }
    if (!isMap(raw)) return { error: 'must be a mapping with id, aggregates, values, events and refs' };
    const problems = [];
    const id = raw.id == null ? null : String(raw.id);
    if (!id) problems.push('the pack needs an id');
    else if (key != null && id !== key) problems.push(`id ${id} does not match the file name ${key}`);
    for (const sec of ['aggregates', 'values', 'events', 'refs']) if (raw[sec] != null && !isMap(raw[sec])) problems.push(`${sec} must be a mapping`);
    const aggNames = names(raw.aggregates), valNames = names(raw.values), evNames = names(raw.events);
    const seen = new Set();
    for (const n of [...aggNames, ...valNames, ...evNames]) { if (seen.has(n)) problems.push(`${n} is declared twice: aggregates, values and events share one set of names`); seen.add(n); }
    const refs = {};
    for (const [k, v] of Object.entries(isMap(raw.refs) ? raw.refs : {})) {
      if (typeof v !== 'string' || !/^[^/\s]+\/[^/\s]+$/.test(v)) problems.push(`refs.${k} must be <pack>/<Aggregate>`);
      else refs[k] = v;
    }
    const aggSet = new Set(aggNames), valSet = new Set(valNames), refSet = new Set(Object.keys(refs));
    const isAgg = n => aggSet.has(n) || refSet.has(n);
    function field(owner, name, spec) {
      const where = `${owner}.${name}`;
      const typeName = t => {
        if (isAgg(t)) problems.push(`${where} holds the aggregate ${t}: reference it by id with { ref: ${t} }`);
        else if (!PRIMITIVES.includes(t) && !valSet.has(t)) problems.push(`${where} has unknown type ${t}`);
      };
      if (typeof spec === 'string') { typeName(spec); return { name, type: spec }; }
      if (!isMap(spec)) { problems.push(`${where} must be a type name or a mapping`); return { name }; }
      for (const k of Object.keys(spec)) if (!CONSTRAINTS.includes(k)) problems.push(`${where} has unknown key ${k}`);
      if (spec.ref != null) {
        const r = String(spec.ref);
        if (valSet.has(r)) problems.push(`${where} references the value object ${r}: value objects are embedded, so use ${name}: ${r}`);
        else if (!isAgg(r)) problems.push(`${where} refers to ${r}, which is not an aggregate here or in refs`);
        return { name, ref: r };
      }
      if (spec.oneOf != null) {
        if (!Array.isArray(spec.oneOf) || !spec.oneOf.length) problems.push(`${where} oneOf must be a list of values`);
        return { name, oneOf: Array.isArray(spec.oneOf) ? spec.oneOf.map(String) : [] };
      }
      if (spec.type == null) { problems.push(`${where} needs a type, a ref or oneOf`); return { name }; }
      typeName(String(spec.type));
      return { name, type: String(spec.type) };
    }
    const fieldsOf = (owner, body) => {
      if (body == null) return [];
      if (!isMap(body)) { problems.push(`fields of ${owner} must be a mapping`); return []; }
      return Object.entries(body).map(([n, s]) => field(owner, n, s));
    };
    const textList = (what, owner, v) => {
      if (v == null) return [];
      if (!Array.isArray(v) || v.some(x => typeof x !== 'string' || !x.trim())) { problems.push(`${what} of ${owner} must be text`); return []; }
      return v.map(x => x.trim());
    };
    const aggregates = aggNames.map(n => {
      const a = isMap(raw.aggregates[n]) ? raw.aggregates[n] : {};
      if (!isMap(raw.aggregates[n])) problems.push(`aggregate ${n} must be a mapping`);
      if (a.id == null || !String(a.id).trim()) problems.push(`aggregate ${n} needs an id: aggregates have identity`);
      const publishes = textList('publishes', n, a.publishes);
      for (const e of publishes) if (!evNames.includes(e)) problems.push(`${n} publishes ${e}, which is not in events`);
      return { name: n, id: a.id == null ? null : String(a.id), fields: fieldsOf(n, a.fields), invariants: textList('invariants', n, a.invariants), publishes };
    });
    const values = valNames.map(n => ({ name: n, fields: fieldsOf(n, raw.values[n]) }));
    const events = evNames.map(n => ({ name: n, fields: fieldsOf(n, raw.events[n]) }));
    return { pack: { id, version: raw.version == null ? null : raw.version, aggregates, values, events, refs }, problems };
  }

  // qualify(entry, packs): a d.owns entry to `pack/Aggregate`. A bare name must be defined by exactly one pack.
  function qualify(entry, packs) {
    const s = String(entry).trim();
    const slash = s.indexOf('/');
    if (slash >= 0) {
      const key = s.slice(0, slash), name = s.slice(slash + 1);
      const p = packs.find(x => x.id === key);
      if (!p) return { error: `no pinned pack is called ${key}` };
      if (!p.aggregates.some(a => a.name === name)) return { error: `${key} defines no aggregate ${name}` };
      return { id: s };
    }
    const hits = packs.filter(p => p.aggregates.some(a => a.name === s));
    if (hits.length === 1) return { id: `${hits[0].id}/${s}` };
    if (hits.length > 1) return { error: `${s} is defined by ${andList(hits.map(p => p.id))}: write ${hits[0].id}/${s}` };
    let best = null, bd = 3;
    for (const p of packs) for (const a of p.aggregates) { const d = lev(s.toLowerCase(), a.name.toLowerCase()); if (d < bd) { bd = d; best = `${p.id}/${a.name}`; } }
    return { error: `no pinned pack defines ${s}${best ? ` (did you mean ${best}?)` : ''}` };
  }

  // ---------- P models ----------
  const blank = t => String(t).replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' ')).replace(/\/\/[^\n]*/g, '');
  function splitTop(s) {
    const out = []; let depth = 0, cur = '';
    for (const c of s) {
      if ('([{'.includes(c)) depth++;
      if (')]}'.includes(c)) depth--;
      if (c === ',' && depth === 0) { out.push(cur); cur = ''; } else cur += c;
    }
    if (cur.trim()) out.push(cur);
    return out.map(x => x.trim());
  }
  // A payload's field names: a named tuple `(a: int, b: T)`, else null.
  function tupleFields(t) {
    const m = /^\(([\s\S]*)\)$/.exec(t.trim());
    if (!m) return null;
    const parts = splitTop(m[1]);
    const fields = parts.map(p => (/^(\w+)\s*:/.exec(p) || [])[1]);
    return parts.length && fields.every(Boolean) ? fields : null;
  }
  // pEvents(behaviour): every declared P event as name -> {fields, raw, path, line}. A payload that is not
  // a named tuple (directly or through `type T = (...)`) has fields null.
  function pEvents(behaviour) {
    const types = new Map(), events = new Map();
    for (const f of behaviour || []) {
      const text = blank(f.text);
      for (const m of text.matchAll(/\btype\s+(\w+)\s*=\s*([^;]*);/g)) types.set(m[1], m[2].trim());
      for (const m of text.matchAll(/\bevent\s+([\w\s,]+?)\s*(?::\s*([^;]*))?;/g)) {
        const line = text.slice(0, m.index).split('\n').length;
        for (const name of m[1].split(',').map(x => x.trim()).filter(Boolean)) events.set(name, { raw: m[2] ? m[2].trim() : null, path: f.path, line });
      }
    }
    for (const e of events.values()) e.fields = e.raw == null ? null : tupleFields(types.has(e.raw) ? types.get(e.raw) : e.raw);
    return events;
  }
  const announced = behaviour => new Set((behaviour || []).flatMap(f => [...blank(f.text).matchAll(/\bannounce\s+(\w+)/g)].map(m => m[1])));

  // ---------- pins ----------
  // pins(ledger): the latest domain_pinned per pack (by _ts, later lines win ties).
  function pins(ledger) {
    const out = new Map(), at = new Map();
    for (const e of ledger || []) {
      if (e.kind !== 'domain_pinned' || !e.pack) continue;
      const ts = e._ts || 0;
      if (at.has(e.pack) && at.get(e.pack) > ts) continue;
      at.set(e.pack, ts); out.set(e.pack, { hash: e.hash, registry: e.registry || e.pack });
    }
    return out;
  }
  const normal = t => String(t).replace(/\r\n/g, '\n');

  // ---------- gate clauses ----------
  // clauses({packs: [{key, path, text}], listed, ledger, sources: {key: text | null}, owners: [{id, name, owns}],
  //   behaviour, isAncestor(a, b), hash}): gate clauses of kind `domain`, and notes for what could not be
  // checked (a source registry that could not be read). A source left out of `sources` is not compared.
  // Nothing runs unless a pack is listed or copied, so d.owns stays free text without packs.
  function clauses({ packs = [], listed = [], ledger = [], sources = {}, owners = [], behaviour = [], isAncestor = () => false, hash }) {
    const out = [], notes = [];
    if (!packs.length && !listed.length) return { clauses: out, notes };
    const push = (text, extra = {}) => out.push({ kind: 'domain', text, ...extra });
    const pinned = pins(ledger), have = new Set(packs.map(p => p.key));
    for (const key of listed) if (!have.has(key)) push(`${key} is listed in designc.json domains but not pinned: pin it from the ${key} registry`, { pack: key });
    const read_ = [];
    for (const p of packs) {
      const pin = pinned.get(p.key), reg = pin ? pin.registry : p.key;
      const h = hash(normal(p.text));
      if (!pin) push(`${p.path} is not pinned: pin it from the ${reg} registry`, { pack: p.key });
      else if (pin.hash !== h) push(`${p.path} was edited after it was pinned: restore it, or re-pin from the ${reg} registry`, { pack: p.key });
      else if (Object.prototype.hasOwnProperty.call(sources, p.key)) {
        const src = sources[p.key];
        if (src == null) notes.push(`${p.key}: its registry could not be read, so whether a newer pack exists is unknown`);
        else if (hash(normal(src)) !== h) push(`${p.key} changed in its registry since it was pinned: re-pin to take it`, { pack: p.key });
      }
      const r = read(p.text, p.load || defaultLoad, p.key);
      if (r.error) { push(`${p.path} ${r.error}`, { pack: p.key }); continue; }
      for (const x of r.problems) push(`${p.path}: ${x}`, { pack: p.key });
      read_.push(r.pack);
    }
    const byAgg = new Map();
    for (const o of owners) for (const entry of o.owns || []) {
      const q = qualify(entry, read_);
      if (q.error) { push(`${o.name} owns "${entry}", but ${q.error}`, { about: [o.name] }); continue; }
      if (!byAgg.has(q.id)) byAgg.set(q.id, []);
      if (!byAgg.get(q.id).includes(o)) byAgg.get(q.id).push(o);
    }
    for (const [agg, os] of byAgg) {
      const top = os.filter(o => !os.some(x => x !== o && isAncestor(x.id, o.id)));
      if (top.length > 1) push(`${agg} is owned by ${andList(top.map(o => o.name))}: an aggregate has one owner`, { about: top.map(o => o.name) });
    }
    const pev = pEvents(behaviour);
    for (const p of read_) for (const e of p.events) {
      const got = pev.get(`e${e.name}`);
      if (!got) continue;
      const want = e.fields.map(f => f.name);
      const same = got.fields && got.fields.length === want.length && [...got.fields].sort().join() === [...want].sort().join();
      if (!same) push(`${got.path}: e${e.name} carries ${got.fields ? got.fields.join(', ') : got.raw || 'nothing'}, but ${p.id} event ${e.name} carries ${want.join(', ') || 'nothing'}`, { path: got.path, line: got.line });
    }
    return { clauses: out, notes };
  }
  // The loader when none is passed: js-yaml in the renderer (jsyaml) or from Node.
  function defaultLoad(t) {
    if (typeof jsyaml !== 'undefined') return jsyaml.load(t);
    return require('js-yaml').load(t);
  }

  // ---------- guides (sidebar only, never the gate) ----------
  const invariantStatement = (aggregate, invariant) => `${aggregate} holds: ${invariant}`;
  // guides({packs, owners, behaviour, decisions, focus}): each owned aggregate with its owner, touched (its
  // owner is in focus, or there is no focus) first; and what a person may want to do next: an event the
  // aggregate publishes that no P model announces, an invariant no live decision states.
  function guides({ packs = [], owners = [], behaviour = [], decisions = [], focus = [] }) {
    const read_ = packs.map(p => read(p.text, p.load || defaultLoad, p.key)).filter(r => r.pack).map(r => r.pack);
    const owned = [];
    for (const o of owners) for (const entry of o.owns || []) {
      const q = qualify(entry, read_);
      if (q.error || owned.some(x => x.aggregate === q.id)) continue;
      const [key, name] = q.id.split('/');
      const agg = read_.find(p => p.id === key).aggregates.find(a => a.name === name);
      owned.push({ aggregate: q.id, pack: key, name, owner: o.name, ownerId: o.id, touched: !focus.length || focus.includes(o.name), def: agg });
    }
    owned.sort((a, b) => Number(b.touched) - Number(a.touched));
    const said = announced(behaviour);
    const stated = new Set(decisions.filter(d => d.status !== 'superseded').map(d => String(d.statement || '').trim()));
    const out = [];
    for (const o of owned) {
      for (const e of o.def.publishes) if (!said.has(`e${e}`)) out.push({ kind: 'event', aggregate: o.aggregate, owner: o.owner, event: e });
      for (const inv of o.def.invariants) if (!stated.has(invariantStatement(o.aggregate, inv))) out.push({ kind: 'invariant', aggregate: o.aggregate, owner: o.owner, invariant: inv });
    }
    return { owned, guides: out };
  }

  return { PRIMITIVES, read, qualify, pEvents, announced, pins, clauses, guides, invariantStatement };
})();
if (typeof module !== 'undefined') module.exports = Domain;
