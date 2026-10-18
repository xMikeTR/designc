"""Domain packs. A port of renderer/domain.js: read, qualify, pEvents and clauses say the same words
(test/domain-parity.test.js). A pack is a team's DDD domain model; a project pins a copy in domain/<key>.yaml."""
import re

from .rules import hash16, lev

PRIMITIVES = ['string', 'int', 'decimal', 'bool', 'date', 'datetime', 'money', 'percent', 'id']
CONSTRAINTS = ['type', 'ref', 'oneOf', 'min', 'max', 'minLength', 'maxLength', 'pattern']


def _is_map(v): return isinstance(v, dict)
def _names(o): return list(o.keys()) if _is_map(o) else []
def _and_list(xs): return ''.join(xs) if len(xs) < 2 else f"{', '.join(xs[:-1])} and {xs[-1]}"
def _str(v):
    if isinstance(v, bool): return 'true' if v else 'false'
    if isinstance(v, float) and v.is_integer(): return str(int(v))
    return str(v)
def _normal(t): return str(t).replace('\r\n', '\n')


def read(text, load, key=None):
    """{'error'} when the file is not a mapping; otherwise {'pack', 'problems'}."""
    try: raw = load(str(text))
    except Exception as e: return {'error': f"does not parse: {str(e).splitlines()[0] if str(e) else ''}"}
    if not _is_map(raw): return {'error': 'must be a mapping with id, aggregates, values, events and refs'}
    problems = []
    pid = None if raw.get('id') is None else _str(raw['id'])
    if not pid: problems.append('the pack needs an id')
    elif key is not None and pid != key: problems.append(f'id {pid} does not match the file name {key}')
    for sec in ('aggregates', 'values', 'events', 'refs'):
        if raw.get(sec) is not None and not _is_map(raw[sec]): problems.append(f'{sec} must be a mapping')
    agg_names, val_names, ev_names = _names(raw.get('aggregates')), _names(raw.get('values')), _names(raw.get('events'))
    seen = set()
    for n in agg_names + val_names + ev_names:
        if n in seen: problems.append(f'{n} is declared twice: aggregates, values and events share one set of names')
        seen.add(n)
    refs = {}
    for k, v in (raw['refs'] if _is_map(raw.get('refs')) else {}).items():
        if not isinstance(v, str) or not re.match(r'^[^/\s]+/[^/\s]+$', v): problems.append(f'refs.{k} must be <pack>/<Aggregate>')
        else: refs[k] = v
    agg_set, val_set, ref_set = set(agg_names), set(val_names), set(refs)
    def is_agg(n): return n in agg_set or n in ref_set

    def field(owner, name, spec):
        where = f'{owner}.{name}'
        def type_name(t):
            if is_agg(t): problems.append(f'{where} holds the aggregate {t}: reference it by id with {{ ref: {t} }}')
            elif t not in PRIMITIVES and t not in val_set: problems.append(f'{where} has unknown type {t}')
        if isinstance(spec, str):
            type_name(spec); return {'name': name, 'type': spec}
        if not _is_map(spec):
            problems.append(f'{where} must be a type name or a mapping'); return {'name': name}
        for k in spec:
            if k not in CONSTRAINTS: problems.append(f'{where} has unknown key {k}')
        if spec.get('ref') is not None:
            r = _str(spec['ref'])
            if r in val_set: problems.append(f'{where} references the value object {r}: value objects are embedded, so use {name}: {r}')
            elif not is_agg(r): problems.append(f'{where} refers to {r}, which is not an aggregate here or in refs')
            return {'name': name, 'ref': r}
        if spec.get('oneOf') is not None:
            one = spec['oneOf']
            if not isinstance(one, list) or not one: problems.append(f'{where} oneOf must be a list of values')
            return {'name': name, 'oneOf': [_str(x) for x in one] if isinstance(one, list) else []}
        if spec.get('type') is None:
            problems.append(f'{where} needs a type, a ref or oneOf'); return {'name': name}
        type_name(_str(spec['type']))
        return {'name': name, 'type': _str(spec['type'])}

    def fields_of(owner, body):
        if body is None: return []
        if not _is_map(body):
            problems.append(f'fields of {owner} must be a mapping'); return []
        return [field(owner, n, s) for n, s in body.items()]

    def text_list(what, owner, v):
        if v is None: return []
        if not isinstance(v, list) or any(not isinstance(x, str) or not x.strip() for x in v):
            problems.append(f'{what} of {owner} must be text'); return []
        return [x.strip() for x in v]

    aggregates = []
    for n in agg_names:
        a = raw['aggregates'][n] if _is_map(raw['aggregates'][n]) else {}
        if not _is_map(raw['aggregates'][n]): problems.append(f'aggregate {n} must be a mapping')
        if a.get('id') is None or not _str(a['id']).strip(): problems.append(f'aggregate {n} needs an id: aggregates have identity')
        publishes = text_list('publishes', n, a.get('publishes'))
        for e in publishes:
            if e not in ev_names: problems.append(f'{n} publishes {e}, which is not in events')
        aggregates.append({'name': n, 'id': None if a.get('id') is None else _str(a['id']), 'fields': fields_of(n, a.get('fields')),
                           'invariants': text_list('invariants', n, a.get('invariants')), 'publishes': publishes})
    values = [{'name': n, 'fields': fields_of(n, raw['values'][n])} for n in val_names]
    events = [{'name': n, 'fields': fields_of(n, raw['events'][n])} for n in ev_names]
    return {'pack': {'id': pid, 'version': raw.get('version'), 'aggregates': aggregates, 'values': values, 'events': events, 'refs': refs}, 'problems': problems}


def qualify(entry, packs):
    s = str(entry).strip()
    slash = s.find('/')
    if slash >= 0:
        key, name = s[:slash], s[slash + 1:]
        p = next((x for x in packs if x['id'] == key), None)
        if not p: return {'error': f'no pinned pack is called {key}'}
        if not any(a['name'] == name for a in p['aggregates']): return {'error': f'{key} defines no aggregate {name}'}
        return {'id': s}
    hits = [p for p in packs if any(a['name'] == s for a in p['aggregates'])]
    if len(hits) == 1: return {'id': f"{hits[0]['id']}/{s}"}
    if len(hits) > 1: return {'error': f"{s} is defined by {_and_list([p['id'] for p in hits])}: write {hits[0]['id']}/{s}"}
    best, bd = None, 3
    for p in packs:
        for a in p['aggregates']:
            d = lev(s.lower(), a['name'].lower())
            if d < bd: bd, best = d, f"{p['id']}/{a['name']}"
    return {'error': f"no pinned pack defines {s}{f' (did you mean {best}?)' if best else ''}"}


def _blank(t):
    t = re.sub(r'/\*[\s\S]*?\*/', lambda m: re.sub(r'[^\n]', ' ', m.group(0)), str(t))
    return re.sub(r'//[^\n]*', '', t)


def _split_top(s):
    out, depth, cur = [], 0, ''
    for c in s:
        if c in '([{': depth += 1
        if c in ')]}': depth -= 1
        if c == ',' and depth == 0: out.append(cur); cur = ''
        else: cur += c
    if cur.strip(): out.append(cur)
    return [x.strip() for x in out]


def _tuple_fields(t):
    m = re.match(r'^\(([\s\S]*)\)$', t.strip())
    if not m: return None
    parts = _split_top(m.group(1))
    fields = [(re.match(r'^(\w+)\s*:', p) or [None, None])[1] for p in parts]
    return fields if parts and all(fields) else None


def p_events(behaviour):
    """name -> {'fields', 'raw', 'path', 'line'}."""
    types, events = {}, {}
    for f in behaviour or []:
        text = _blank(f['text'])
        for m in re.finditer(r'\btype\s+(\w+)\s*=\s*([^;]*);', text): types[m.group(1)] = m.group(2).strip()
        for m in re.finditer(r'\bevent\s+([\w\s,]+?)\s*(?::\s*([^;]*))?;', text):
            line = text[:m.start()].count('\n') + 1
            for name in [x.strip() for x in m.group(1).split(',') if x.strip()]:
                events[name] = {'raw': m.group(2).strip() if m.group(2) else None, 'path': f['path'], 'line': line}
    for e in events.values():
        e['fields'] = None if e['raw'] is None else _tuple_fields(types[e['raw']] if e['raw'] in types else e['raw'])
    return events


def pins(ledger):
    out, at = {}, {}
    for e in ledger or []:
        if e.get('kind') != 'domain_pinned' or not e.get('pack'): continue
        ts = e.get('_ts') or 0
        if e['pack'] in at and at[e['pack']] > ts: continue
        at[e['pack']] = ts; out[e['pack']] = {'hash': e.get('hash'), 'registry': e.get('registry') or e['pack']}
    return out


def clauses(packs=(), listed=(), ledger=(), sources=None, owners=(), behaviour=(), is_ancestor=lambda a, b: False, load=None):
    """({clauses, notes}). packs: [{'key', 'path', 'text'}]; sources: {key: text or None}; owners: [{'id', 'name', 'owns'}]."""
    out, notes = [], []
    sources = sources or {}
    if not packs and not listed: return {'clauses': out, 'notes': notes}
    def push(text, **extra): out.append({'kind': 'domain', 'text': text, **extra})
    pinned = pins(ledger)
    have = {p['key'] for p in packs}
    for key in listed:
        if key not in have: push(f'{key} is listed in designc.json domains but not pinned: pin it from the {key} registry', pack=key)
    parsed = []
    for p in packs:
        pin = pinned.get(p['key'])
        reg = pin['registry'] if pin else p['key']
        h = hash16(_normal(p['text']))
        if not pin: push(f"{p['path']} is not pinned: pin it from the {reg} registry", pack=p['key'])
        elif pin['hash'] != h: push(f"{p['path']} was edited after it was pinned: restore it, or re-pin from the {reg} registry", pack=p['key'])
        elif p['key'] in sources:
            src = sources[p['key']]
            if src is None: notes.append(f"{p['key']}: its registry could not be read, so whether a newer pack exists is unknown")
            elif hash16(_normal(src)) != h: push(f"{p['key']} changed in its registry since it was pinned: re-pin to take it", pack=p['key'])
        r = read(p['text'], load, p['key'])
        if 'error' in r:
            push(f"{p['path']} {r['error']}", pack=p['key']); continue
        for x in r['problems']: push(f"{p['path']}: {x}", pack=p['key'])
        parsed.append(r['pack'])
    by_agg = {}
    for o in owners:
        for entry in o.get('owns') or []:
            q = qualify(entry, parsed)
            if 'error' in q:
                push(f"{o['name']} owns \"{entry}\", but {q['error']}", about=[o['name']]); continue
            lst = by_agg.setdefault(q['id'], [])
            if o not in lst: lst.append(o)
    for agg, os_ in by_agg.items():
        top = [o for o in os_ if not any(x is not o and is_ancestor(x['id'], o['id']) for x in os_)]
        if len(top) > 1: push(f"{agg} is owned by {_and_list([o['name'] for o in top])}: an aggregate has one owner", about=[o['name'] for o in top])
    pev = p_events(behaviour)
    for p in parsed:
        for e in p['events']:
            got = pev.get(f"e{e['name']}")
            if not got: continue
            want = [f['name'] for f in e['fields']]
            same = got['fields'] is not None and len(got['fields']) == len(want) and sorted(got['fields']) == sorted(want)
            if not same:
                have_s = ', '.join(got['fields']) if got['fields'] else (got['raw'] or 'nothing')
                push(f"{got['path']}: e{e['name']} carries {have_s}, but {p['id']} event {e['name']} carries {', '.join(want) or 'nothing'}", path=got['path'], line=got['line'])
    return {'clauses': out, 'notes': notes}
