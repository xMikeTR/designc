"""Design properties, validation (DC000) and rules DC001 to DC006. A port of renderer/core.js."""
import json
import math
import os
import re

YN = ['yes', 'no']
SPECS = {
    'relationship': {
        'd.interaction': ('enum', ['sync', 'async']),
        'd.delivery': ('enum', ['at-most-once', 'at-least-once', 'exactly-once']),
        'd.idempotent': ('enum', YN), 'd.retry': ('enum', ['none', 'fixed', 'backoff']),
        'd.retry.max': ('int', None), 'd.encrypted': ('enum', YN), 'd.authenticated': ('enum', YN),
        'd.writes': ('list', None), 'd.concurrency': ('enum', ['none', 'optimistic', 'pessimistic']),
        'd.suppress': ('suppress', None),
    },
    'element': {
        'd.instances': ('int', None), 'd.critical': ('enum', YN), 'd.zone': ('str', None),
        'd.availability': ('float', None), 'd.owns': ('list', None), 'd.store': ('enum', YN),
        'd.aka': ('list', None), 'd.suppress': ('suppress', None),
    },
}


def _load_canvas_specs():
    """The agentic and quality d.* properties, generated from renderer/canvas/vocabulary.js (test/helpers/canvas-specs.js)."""
    with open(os.path.join(os.path.dirname(__file__), 'canvas_specs.json'), encoding='utf-8') as f: data = json.load(f)
    for target in ('element', 'relationship'):
        for key, spec in data[target].items(): SPECS[target][key] = (spec['k'], spec.get('v'))


_load_canvas_specs()
SEV = {'error': 2, 'warning': 1, 'note': 0}


class SpecError(Exception):
    pass


def parse_suppress(raw):
    out = {}
    chunks = [c.strip() for c in re.split(r';\s*(?=DC[0-9]{3}\s*:)', raw, flags=re.I | re.A)]
    for chunk in (c for c in chunks if c):
        i = chunk.find(':')
        if i < 0: raise SpecError(f'"{chunk}" is not "DCnnn: reason"')
        code, reason = chunk[:i].strip().upper(), chunk[i + 1:].strip()
        if not re.fullmatch(r'DC[0-9]{3}', code): raise SpecError(f'"{chunk}" is not "DCnnn: reason"')
        if not reason: raise SpecError(f'suppression of {code} has no reason')
        out[code] = reason
    return out


def parse_val(spec, raw):
    kind, allowed = spec
    v = str(raw).strip()
    if kind == 'enum':
        x = v.lower()
        if x not in allowed: raise SpecError('expected ' + ' | '.join(allowed))
        return x
    if kind == 'int':
        if not re.fullmatch(r'[0-9]+', v): raise SpecError('expected a whole number')
        return int(v)
    if kind == 'float':
        try: f = float(v) if '_' not in v else math.nan
        except ValueError: f = math.nan
        if not (0 < f <= 1) or math.isinf(f): raise SpecError('expected a fraction in (0, 1], e.g. 0.999')
        return f
    if kind == 'list': return [s.strip() for s in v.split(',') if s.strip()]
    if kind == 'suppress': return parse_suppress(v)
    return v


def target_of(o):
    return 'element' if hasattr(o, 'kind') else 'relationship'


def get(o, key):
    raw = o.props.get(key)
    if raw is None: return None
    try: return parse_val(SPECS[target_of(o)][key], raw)
    except (SpecError, KeyError): return None


def lev(a, b):
    d = [[i] + [0] * len(b) for i in range(len(a) + 1)]
    for j in range(1, len(b) + 1): d[0][j] = j
    for i in range(1, len(a) + 1):
        for j in range(1, len(b) + 1):
            d[i][j] = min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (0 if a[i - 1] == b[j - 1] else 1))
    return d[len(a)][len(b)]


def D(code, sev, msg, loc, hint=None, unknown=False, related=None):
    return {'code': code, 'sev': sev, 'msg': msg, 'loc': loc, 'hint': hint, 'unknown': unknown, 'suppressed': None, 'related': related or []}


def validate(m):
    out = []
    items = [('element', e, m.loc_el(e)) for e in m.elements.values()] + [('relationship', r, m.loc_rel(r)) for r in m.rels]
    for target, o, loc in items:
        specs = SPECS[target]
        for key, raw in o.props.items():
            if not key.startswith('d.'): continue
            spec = specs.get(key)
            if not spec:
                best = sorted(((k, lev(key, k)) for k in specs), key=lambda kv: kv[1])[0]
                other = 'relationship' if target == 'element' else 'element'
                if best[1] <= 3: hint = f'did you mean "{best[0]}"?'
                elif key in SPECS[other]: hint = f'"{key}" belongs on {"an element" if other == "element" else "a relationship"}'
                else: hint = None
                out.append(D('DC000', 'error', f'unknown design property "{key}"', loc, hint=hint))
                continue
            try: parse_val(spec, raw)
            except SpecError as e: out.append(D('DC000', 'error', f'"{key}" = "{raw}": {e}', loc))
    return out


def interaction(r): return get(r, 'd.interaction')


def is_store(e):
    return get(e, 'd.store') == 'yes' if e.props.get('d.store') is not None else 'Database' in e.tags


def zone(m, eid):
    c = m.elements.get(eid)
    while c:
        z = get(c, 'd.zone')
        if z: return z
        c = m.elements.get(c.parent) if c.parent else None
    return None


def structural(m, r): return m.is_ancestor(r.src, r.dst) or m.is_ancestor(r.dst, r.src)


def num(n):
    """A number the way JavaScript writes it in a template string."""
    return str(int(n)) if isinstance(n, float) and n.is_integer() else str(n)


def dc001(m, o):
    out = []
    for r in m.rels:
        if interaction(r) != 'async': continue
        d = get(r, 'd.delivery')
        if d is None:
            out.append(D('DC001', 'warning', 'async, but no delivery guarantee declared', m.loc_rel(r), hint='set d.delivery: at-most-once | at-least-once | exactly-once', unknown=True)); continue
        if d != 'at-least-once': continue
        idem = get(r, 'd.idempotent')
        if idem == 'no': out.append(D('DC001', 'error', 'at-least-once into a non-idempotent receiver: some messages are processed twice', m.loc_rel(r), hint='dedupe on a message id, or make the handler idempotent'))
        elif idem is None: out.append(D('DC001', 'warning', 'at-least-once delivery, receiver idempotency undeclared', m.loc_rel(r), hint='set d.idempotent: yes | no', unknown=True))
    return out


def dc002(m, o):
    out, writes, owners = [], {}, {}
    for r in m.rels:
        ents = get(r, 'd.writes')
        if not ents: continue
        store = m.elements[r.dst]
        if not is_store(store):
            out.append(D('DC002', 'warning', f'writes into "{store.name}", which is not a store', m.loc_rel(r), hint='tag it "Database" or set d.store: yes')); continue
        for ent in ents: writes.setdefault(store.id + '|' + ent, []).append(r)
    for e in m.elements.values():
        for ent in get(e, 'd.owns') or []: owners.setdefault(ent, {})[e.id] = True
    for k, rels in writes.items():
        parts = k.split('|'); store_id, ent = parts[0], parts[1]
        store = m.elements[store_id]
        own = owners.get(ent)
        if own:
            for r in rels:
                if r.src not in own:
                    names = ', '.join(m.elements[x].name for x in own)
                    out.append(D('DC002', 'warning', f'writes "{ent}" but {names} owns it', m.loc_rel(r), hint='route the write through the owner, or change d.owns'))
            rels = [r for r in rels if r.src in own]
        writers = list(dict.fromkeys(r.src for r in rels))
        if len(writers) >= 2:
            who = f'{len(writers)} containers ({", ".join(m.elements[w].name for w in writers)})'
        elif len(writers) == 1:
            w = m.elements[writers[0]]; n = get(w, 'd.instances')
            if not n or n < 2: continue
            who = f'{n} instances of {w.name}'
        else: continue
        none = [r for r in rels if get(r, 'd.concurrency') == 'none']
        undecl = [r for r in rels if get(r, 'd.concurrency') is None]
        if not none and not undecl: continue
        related = [m.loc_rel(r) for r in none + undecl]
        if none: out.append(D('DC002', 'error', f'lost update: {who} write "{ent}" and at least one has no concurrency control', m.loc_el(store), hint='declare one owner with d.owns, or set d.concurrency: optimistic', related=related))
        else: out.append(D('DC002', 'warning', f'possible lost update: {who} write "{ent}", concurrency undeclared', m.loc_el(store), hint='set d.concurrency on each writing relationship', unknown=True, related=related))
    return out


def dc003(m, o):
    adj, has_in = {}, set()
    for r in m.rels:
        if interaction(r) == 'async' or structural(m, r) or m.elements[r.src].kind == 'person': continue
        adj.setdefault(r.src, []).append(r); has_in.add(r.dst)
    starts = [n for n in adj if n not in has_in] or list(adj)
    found = []

    def dfs(node, seen, path):
        if len(found) >= 200: return
        ext = False
        for r in adj.get(node, []):
            if r.dst in seen: continue
            ext = True; dfs(r.dst, seen | {r.dst}, path + [r])
        if not ext and len(path) >= o['chainHops']: found.append(path)

    for s in starts: dfs(s, {s}, [])
    out = []
    for path in found:
        nodes = [path[0].src] + [r.dst for r in path]
        av = [get(m.elements[n], 'd.availability') for n in nodes]
        assumed = sum(1 for r in path if interaction(r) is None)
        msg = f'{len(path)} synchronous hops: {" → ".join(m.elements[n].name for n in nodes)}'
        if all(a is not None for a in av):
            prod = 1
            for a in av: prod *= a
            msg += f'; end-to-end availability ≈ {prod * 100:.2f}%'
        else:
            msg += f'; declare d.availability on {sum(1 for a in av if a is None)} more element(s) to compute it'
        if assumed: msg += f' ({assumed} undeclared hop(s) assumed sync)'
        out.append(D('DC003', 'warning', msg, m.loc_rel(path[0]), hint='make a hop async, cache, or add a fallback', related=[m.loc_rel(r) for r in path[1:]]))
    return out


def dc004(m, o):
    out = []
    for r in m.rels:
        if get(r, 'd.retry') not in ('fixed', 'backoff'): continue
        idem = get(r, 'd.idempotent')
        if idem == 'no': out.append(D('DC004', 'error', 'retries on a non-idempotent call duplicate side effects', m.loc_rel(r), hint='send an idempotency key, or remove the retry'))
        elif idem is None: out.append(D('DC004', 'warning', 'retries declared, receiver idempotency undeclared', m.loc_rel(r), hint='set d.idempotent: yes | no', unknown=True))
    return out


def dc005(m, o):
    out = []
    for e in m.elements.values():
        if get(e, 'd.critical') != 'yes': continue
        n = get(e, 'd.instances')
        if n is None: out.append(D('DC005', 'warning', 'critical, instance count undeclared', m.loc_el(e), hint='set d.instances', unknown=True))
        elif n <= 1: out.append(D('DC005', 'warning', f'critical, but runs {n} instance', m.loc_el(e), hint='add an instance, or record the fallback as an accepted risk'))
    return out


def dc006(m, o):
    out = []
    if not any(get(e, 'd.zone') for e in m.elements.values()): return out
    for r in m.rels:
        if structural(m, r): continue
        zs, zd = zone(m, r.src), zone(m, r.dst)
        if not zs or not zd:
            out.append(D('DC006', 'warning', 'cannot tell whether this crosses a trust boundary', m.loc_rel(r), hint='set d.zone on both ends or a parent', unknown=True)); continue
        if zs == zd: continue
        vals = {'encrypted': get(r, 'd.encrypted'), 'authenticated': get(r, 'd.authenticated')}
        bad = [k for k in vals if vals[k] == 'no']
        und = [k for k in vals if vals[k] is None]
        if bad: out.append(D('DC006', 'error', f'crosses {zs} → {zd} and is not {" or ".join(bad)}', m.loc_rel(r)))
        elif und: out.append(D('DC006', 'warning', f'crosses {zs} → {zd}; {", ".join("d." + x for x in und)} undeclared', m.loc_rel(r), hint='unknown on a boundary is a finding', unknown=True))
    return out


RULES = [('DC001', dc001), ('DC002', dc002), ('DC003', dc003), ('DC004', dc004), ('DC005', dc005), ('DC006', dc006)]


def _collate(s):
    # Close to Intl's localeCompare for the names a model uses: case-insensitive first, lower case before upper.
    return (s.casefold(), s.swapcase())


def check(m, chain_hops=4):
    diags = validate(m)
    for _, fn in RULES: diags += fn(m, {'chainHops': chain_hops})
    for d in diags:
        if d['code'] == 'DC000': continue
        obj = m.elements.get(d['loc']['id']) if d['loc']['kind'] == 'element' else m.rel_by_id.get(d['loc']['id'])
        raw = obj.props.get('d.suppress') if obj else None
        if raw:
            try: d['suppressed'] = parse_suppress(raw).get(d['code']) or None
            except SpecError: pass
    return sorted(diags, key=lambda d: (-SEV[d['sev']], d['code'], _collate(d['loc']['label'])))


def _fnv(units, seed):
    h = seed & 0xFFFFFFFF
    for u in units:
        h ^= u
        h = (h * 16777619) & 0xFFFFFFFF
    return f'{h:08x}'


def hash16(s):
    b = s.encode('utf-16-le', 'surrogatepass')
    units = [b[i] | (b[i + 1] << 8) for i in range(0, len(b), 2)]
    return _fnv(units, 2166136261) + _fnv(units, 2654435769)


def fingerprint(m, element_id):
    el = m.elements.get(element_id)
    if not el: return None

    def who(e): return f'{e.ident or ""}|{e.name}' if e else ''

    def dprops(p): return ';'.join(f'{k}={p[k]}' for k in sorted(k for k in (p or {}) if k.startswith('d.')))

    rels = []
    for r in m.rels:
        if r.src != element_id and r.dst != element_id: continue
        out = r.src == element_id
        rels.append(f'rel {"out" if out else "in"} {who(m.elements.get(r.dst if out else r.src))} [{r.technology or ""}] {{{dprops(r.props)}}}')
    rels.sort()
    content = '\n'.join([f'kind {el.kind}', f'parent {who(m.elements.get(el.parent))}', f'name {el.name}',
                         f'technology {el.technology or ""}', f'props {{{dprops(el.props)}}}'] + rels)
    return {'hash': hash16(content), 'content': content}


def slug_id(statement, taken):
    words = re.sub(r'[^a-z0-9]+', ' ', str(statement or '').lower(), flags=re.A).strip().split(' ')
    words = [w for w in words if w]
    base = ''
    for w in words:
        nxt = f'{base}-{w}' if base else w
        if len(nxt) > 48: break
        base = nxt
    base = base or (words[0] if words else 'untitled')[:48].rstrip('-') or 'untitled'
    used = {str(t).lower() for t in taken}
    i, n = base, 2
    while i in used:
        i = f'{base}-{n}'; n += 1
    return i
