"""designc: UI packs and screen specs. A word-for-word mirror of renderer/ui.js (test/ui-parity.test.js holds them
together). Pure: no I/O. The schemas are python/designc/ui_schemas.json, generated from docs/ui-*.schema.json."""
import json, os, re
from .rules import hash16

with open(os.path.join(os.path.dirname(__file__), 'ui_schemas.json'), encoding='utf-8') as _f:
    SCHEMAS = json.load(_f)

CLOSED_TOKEN_GROUPS = ['space', 'color', 'density', 'tone']
REQUIRED_STATES = ['ready', 'loading', 'empty', 'error']
LOCATOR_ROLES = ['alert', 'button', 'cell', 'checkbox', 'combobox', 'dialog', 'form', 'heading', 'img', 'label', 'link', 'list', 'listitem', 'main', 'navigation', 'option', 'radio', 'region', 'row', 'searchbox', 'status', 'switch', 'tab', 'table', 'tabpanel', 'textbox']
_UNDEF = object()


def _is_map(v): return isinstance(v, dict)
def _normal(t): return str(t).replace('\r\n', '\n')


def _num(v):
    if isinstance(v, float) and v.is_integer() and abs(v) < 1e21: return int(v)
    return v


def _json(v):
    """JSON.stringify: compact, non-ASCII kept, integral floats printed as integers."""
    v = _num(v)
    if isinstance(v, dict): return '{' + ','.join(f'{json.dumps(k, ensure_ascii=False)}:{_json(x)}' for k, x in v.items()) + '}'
    if isinstance(v, list): return '[' + ','.join(_json(x) for x in v) + ']'
    return json.dumps(v, ensure_ascii=False)


def show(v):
    if v is _UNDEF: return 'undefined'
    if v is None: return 'null'
    if isinstance(v, bool): return 'true' if v else 'false'
    if isinstance(v, (dict, list)): return _json(v)
    return str(_num(v))


def canon(v):
    if isinstance(v, list): return '[' + ','.join(canon(x) for x in v) + ']'
    if _is_map(v): return '{' + ','.join(f'{json.dumps(k, ensure_ascii=False)}:{canon(v[k])}' for k in sorted(v)) + '}'
    return _json(v)


# ---------- a small JSON Schema checker (the same subset as ui.js) ----------
def _kind(v):
    if v is None: return 'null'
    if isinstance(v, list): return 'array'
    if isinstance(v, bool): return 'boolean'
    if isinstance(v, (int, float)): return 'integer' if float(v).is_integer() else 'number'
    if isinstance(v, str): return 'string'
    return 'object'


def _type_ok(t, v):
    k = _kind(v)
    return t == k or (t == 'number' and k == 'integer')


def _resolve(ref, root):
    base, _, ptr = ref.partition('#')
    doc = SCHEMAS.get(base) if base else root
    node = doc
    for part in [p for p in ptr.split('/') if p]:
        node = node.get(part) if isinstance(node, dict) else None
    return node, doc


def _check(schema, v, root, at, out):
    if '$ref' in schema:
        s, r = _resolve(schema['$ref'], root)
        return _check(s, v, r, at, out)
    def bad(msg): out.append({'at': at or '/', 'msg': msg})
    t = schema.get('type')
    if t and not _type_ok(t, v): return bad(f'must be {t}')
    if 'enum' in schema and not any(canon(x) == canon(v) for x in schema['enum']):
        bad(f"must be equal to one of the allowed values ({', '.join(str(x) for x in schema['enum'])})")
    if 'const' in schema and canon(schema['const']) != canon(v): bad('must be equal to constant')
    if isinstance(v, str):
        if schema.get('pattern') and not re.search(schema['pattern'], v): bad(f'must match pattern "{schema["pattern"]}"')
        if schema.get('minLength') is not None and len(v) < schema['minLength']: bad(f'must NOT have fewer than {schema["minLength"]} characters')
    if isinstance(v, (int, float)) and not isinstance(v, bool) and schema.get('minimum') is not None and v < schema['minimum']: bad(f'must be >= {schema["minimum"]}')
    if isinstance(v, list):
        if schema.get('minItems') is not None and len(v) < schema['minItems']: bad(f'must NOT have fewer than {schema["minItems"]} items')
        if 'items' in schema:
            for i, x in enumerate(v): _check(schema['items'], x, root, f'{at}/{i}', out)
    if _is_map(v):
        if schema.get('minProperties') is not None and len(v) < schema['minProperties']: bad(f'must NOT have fewer than {schema["minProperties"]} properties')
        for r in schema.get('required') or []:
            if r not in v: bad(f"must have required property '{r}'")
        props = schema.get('properties') or {}
        for k in v:
            if k in props: _check(props[k], v[k], root, f'{at}/{k}', out)
            elif schema.get('additionalProperties') is False: bad(f"must NOT have additional properties: '{k}'")
            elif _is_map(schema.get('additionalProperties')): _check(schema['additionalProperties'], v[k], root, f'{at}/{k}', out)
    for sub in schema.get('allOf') or []:
        if 'if' in sub:
            probe = []
            _check(sub['if'], v, root, at, probe)
            if not probe and 'then' in sub: _check(sub['then'], v, root, at, out)
        else: _check(sub, v, root, at, out)
    if 'oneOf' in schema:
        hits = 0
        for s in schema['oneOf']:
            probe = []
            _check(s, v, root, at, probe)
            if not probe: hits += 1
        if hits != 1: bad('must match exactly one schema in oneOf')


def validate(id_, doc):
    root = SCHEMAS[f'{id_}.schema.json']
    out = []
    _check(root, doc, root, '', out)
    return out


# ---------- tokens ----------
def token_groups(text):
    if text is None: return None
    try: doc = json.loads(text)
    except ValueError: return None
    if not _is_map(doc): return None
    groups = {}
    def walk(node, path, group):
        for k, v in node.items():
            if k.startswith('$') or not _is_map(v): continue
            if '$value' in v: groups.setdefault(group, []).append('.'.join([*path, k]))
            else: walk(v, [*path, k], group)
    for g, v in doc.items():
        if not g.startswith('$') and _is_map(v):
            if '$value' in v: continue
            walk(v, [], g)
    return groups


def _fmt(file, at, msg, fix=None):
    return f"{file}{' ' + at if at and at != '/' else ''}: {msg}{'. ' + fix if fix else ''}"


def _parse_json(f, out):
    try: return json.loads(f['text']), True
    except ValueError:
        out.append(f"{f['path']} does not parse as JSON")
        return None, False


def _base_name(p): return re.sub(r'\.json$', '', p.split('/')[-1])


def read_pack(components, templates, groups):
    problems, comps, tpls = [], {}, {}
    token_names = [g for g in (groups or {}) if g in CLOSED_TOKEN_GROUPS]
    need_tokens = False
    for f in components:
        m, ok = _parse_json(f, problems)
        if not ok or m is None: continue
        for e in validate('ui-component-manifest', m): problems.append(_fmt(f['path'], e['at'], f"schema: {e['msg']}"))
        if not _is_map(m): continue
        name = m.get('name', _UNDEF)
        if name in comps and isinstance(name, str): problems.append(_fmt(f['path'], '/name', f"Duplicate component '{name}' (also in {comps[name]['file']})"))
        props = m.get('props')
        if _is_map(props):
            for p, d in props.items():
                if not _is_map(d) or d.get('type') != 'token' or not isinstance(d.get('token'), str): continue
                if not groups: need_tokens = True
                elif d['token'] not in groups: problems.append(_fmt(f['path'], f'/props/{p}', f"Unknown token group '{d['token']}'", f"Add it to design-tokens/tokens.json or use one of: {', '.join(token_names)}"))
        if isinstance(name, str) and name not in comps: comps[name] = {'file': f['path'], 'm': m}
    if need_tokens: problems.append('ui/pack: a component has a token prop, but design-tokens/tokens.json is missing or does not parse. Add it, with the groups space, color, density and tone')
    for f in templates:
        t, ok = _parse_json(f, problems)
        if not ok or t is None: continue
        for e in validate('ui-template', t): problems.append(_fmt(f['path'], e['at'], f"schema: {e['msg']}"))
        if _is_map(t) and isinstance(t.get('name'), str): tpls[t['name']] = {'file': f['path'], 't': t}
    return {'components': comps, 'templates': tpls, 'problems': problems}


def _flatten_slots(slots, prefix=''):
    out = {}
    for name, s in (slots.items() if _is_map(slots) else []):
        if not _is_map(s): continue
        p = f'{prefix}.{name}' if prefix else name
        out[p] = s
        out.update(_flatten_slots(s.get('subslots'), p))
    return out


def _num_or(v, d=0): return v if isinstance(v, (int, float)) and not isinstance(v, bool) else d


def check_spec(file, text, pack, groups):
    problems, notes = [], []
    def err(at, msg, fix=None): problems.append(_fmt(file, at, msg, fix))
    def note(at, msg, fix=None): notes.append(_fmt(file, at, msg, fix))
    try: spec = json.loads(text)
    except ValueError: return {'problems': [f'{file} does not parse as JSON'], 'notes': notes, 'spec': None}
    for e in validate('ui-screen-spec', spec): err(e['at'], f"schema: {e['msg']}")
    if not _is_map(spec): return {'problems': problems, 'notes': notes, 'spec': None}
    if not pack:
        err('/template', 'No UI pack is pinned, so the template and components cannot be checked', 'Pin the pack from its kind: ui registry')
        return {'problems': problems, 'notes': notes, 'spec': spec}
    tname = spec.get('template', _UNDEF)
    tpl = pack['templates'].get(tname) if isinstance(tname, str) else None
    if not tpl:
        err('/template', f"Unknown template '{show(tname)}'", f"Use one of: {', '.join(pack['templates'])}")
        return {'problems': problems, 'notes': notes, 'spec': spec}
    t = tpl['t']
    if t.get('status') != 'bound': err('/template', f"Template '{tname}' is {show(t.get('status', _UNDEF))}, not bound")
    slots = _flatten_slots(t.get('slots'))
    data = spec['data'] if _is_map(spec.get('data')) else {}
    used, ids = set(), set()
    sspec = spec['slots'] if _is_map(spec.get('slots')) else {}
    for path, placements in sspec.items():
        if not isinstance(placements, list): continue
        slot = slots.get(path)
        if not slot:
            err(f'/slots/{path}', f"Template '{tname}' has no slot '{path}'", f"Slots are: {', '.join(slots)}")
            continue
        if slot.get('max') is not None and len(placements) > slot['max']: err(f'/slots/{path}', f"Slot '{path}' takes at most {show(slot['max'])}, got {len(placements)}")
        for i, pl in enumerate(placements):
            if not _is_map(pl): continue
            at = f'/slots/{path}/{i}'
            if pl.get('id'):
                if pl['id'] in ids: err(f'{at}/id', f"Duplicate id '{show(pl['id'])}'")
                ids.add(pl['id'])
            else: note(at, 'No id: the visual check cannot map this element back to the spec')
            cname = pl.get('component', _UNDEF)
            entry = pack['components'].get(cname) if isinstance(cname, str) else None
            if not entry:
                err(f'{at}/component', f"'{show(cname)}' is not in the catalogue", 'Use a catalogued component, or have the catalogue stage mint a manifest and get it bound')
                continue
            m = entry['m']
            if m.get('status') != 'bound': err(f'{at}/component', f"'{m.get('name')}' is {show(m.get('status', _UNDEF))}, not bound")
            accepts = slot['accepts'] if isinstance(slot.get('accepts'), list) else []
            if m.get('category') not in accepts: err(f'{at}/component', f"'{m.get('name')}' is a {show(m.get('category', _UNDEF))}; slot '{path}' accepts {' | '.join(str(a) for a in accepts)}")
            props = pl['props'] if _is_map(pl.get('props')) else {}
            mprops = m['props'] if _is_map(m.get('props')) else {}
            mdata = m['data'] if _is_map(m.get('data')) else {}
            for p, d in mprops.items():
                if _is_map(d) and d.get('required') and p not in props: err(f'{at}/props', f"'{m.get('name')}' requires prop '{p}'")
            for p, v in props.items():
                d = mprops.get(p)
                if not _is_map(d):
                    hint = f"'{p}' is a data prop: put it under bind" if p in mdata and mdata[p] else f"Allowed props: {', '.join(mprops) or 'none'}"
                    err(f'{at}/props/{p}', f"'{m.get('name')}' has no prop '{p}'", hint)
                    continue
                ty = d.get('type')
                if ty == 'enum' and isinstance(d.get('values'), list) and not any(canon(x) == canon(v) for x in d['values']):
                    err(f'{at}/props/{p}', f"'{show(v)}' is not one of {' | '.join(str(x) for x in d['values'])}")
                if ty == 'token' and groups and d.get('token') in groups and str(_to_js_string(v)) not in groups[d['token']]:
                    err(f'{at}/props/{p}', f"'{show(v)}' is not a {d['token']} token", f"Use one of: {', '.join(groups[d['token']])}")
                if ty in ('string', 'action') and not isinstance(v, str): err(f'{at}/props/{p}', 'Expected a string')
                if ty == 'number' and (isinstance(v, bool) or not isinstance(v, (int, float))): err(f'{at}/props/{p}', 'Expected a number')
                if ty == 'boolean' and not isinstance(v, bool): err(f'{at}/props/{p}', 'Expected a boolean')
            bind = pl['bind'] if _is_map(pl.get('bind')) else {}
            for dp, d in mdata.items():
                if _is_map(d) and d.get('required') and dp not in bind: err(f'{at}/bind', f"'{m.get('name')}' needs data '{dp}' ({show(d.get('shape', _UNDEF))})")
            for dp, key in bind.items():
                d = mdata.get(dp)
                if not _is_map(d):
                    err(f'{at}/bind/{dp}', f"'{m.get('name')}' has no data prop '{dp}'")
                    continue
                dd = data.get(key) if isinstance(key, str) else None
                if not dd:
                    err(f'{at}/bind/{dp}', f"No data key '{show(key)}'", 'Declare it under data with a shape and source')
                    continue
                used.add(key)
                if _get(dd, 'shape') != _get(d, 'shape'): err(f'{at}/bind/{dp}', f"'{show(key)}' is {show(_get(dd, 'shape'))}; '{m.get('name')}.{dp}' expects {show(_get(d, 'shape'))}")
    def filled(p): return len(sspec[p]) if isinstance(sspec.get(p), list) else 0
    for path, slot in slots.items():
        n = filled(path)
        parent = path[:path.rindex('.')] if '.' in path else None
        if _num_or(slot.get('min')) > n and (not parent or filled(parent) > 0): err(f'/slots/{path}', f"Slot '{path}' needs at least {show(slot['min'])}, got {n}")
    for key in data:
        if key not in used: note(f'/data/{key}', f"Data '{key}' is declared but never shown")
    if isinstance(spec.get('screen'), str) and _base_name(file) != spec['screen']: note('/screen', f"File name should be the screen name '{spec['screen']}.json'")
    _check_states(spec, err, note)
    return {'problems': problems, 'notes': notes, 'spec': spec}


def _get(d, k): return d.get(k, _UNDEF) if _is_map(d) else _UNDEF


def _to_js_string(v):
    return show(v) if not isinstance(v, str) else v


def _check_states(spec, err, note):
    states = spec['states'] if _is_map(spec.get('states')) else {}
    names = list(states)
    def st(n): return states[n] if _is_map(states[n]) else {}
    initial = [n for n in names if st(n).get('initial')]
    if len(initial) != 1: err('/states', f"Exactly one state is initial, found {len(initial)}{': ' + ', '.join(initial) if initial else ''}")
    missing = [s for s in REQUIRED_STATES if s not in states]
    if missing: note('/states', f"No state named {', '.join(missing)}", "Acceptance asks for a case per required state. Add it, or name your main state 'ready'")
    data = spec['data'] if _is_map(spec.get('data')) else {}
    for n in names:
        s = st(n)
        for where, keys in (('data', list(s['data']) if _is_map(s.get('data')) else []), ('pending', s['pending'] if isinstance(s.get('pending'), list) else []), ('failed', s['failed'] if isinstance(s.get('failed'), list) else [])):
            for key in keys:
                if key not in data: err(f'/states/{n}/{where}/{key}', f"No data key '{show(key)}'")
    edges = {}
    trans = spec['transitions'] if isinstance(spec.get('transitions'), list) else []
    for i, t in enumerate(trans):
        if not _is_map(t): continue
        for a in ('click', 'fill', 'select'):
            on = t.get('on')
            if _is_map(on) and _is_map(on.get(a)) and on[a].get('role') not in LOCATOR_ROLES: err(f'/transitions/{i}/on/{a}', f"Locator role '{show(on[a].get('role', _UNDEF))}' is not an acceptance role")
        for end in ('from', 'to'):
            v = t.get(end, _UNDEF)
            if not (isinstance(v, str) and v in states): err(f'/transitions/{i}/{end}', f"No state '{show(v)}'", f"States are: {', '.join(names)}")
        edges.setdefault(_edge_key(t.get('from', _UNDEF)), []).append(t.get('to', _UNDEF))
    if len(initial) == 1:
        seen, todo = {initial[0]}, [initial[0]]
        while todo:
            for n in edges.get(_edge_key(todo.pop()), []):
                if isinstance(n, str) and n not in seen:
                    seen.add(n); todo.append(n)
        for n in names:
            if n not in seen: err(f'/states/{n}', f"State '{n}' cannot be reached from '{initial[0]}'", 'No scenario can record it. Add a transition')
    locs = {}
    sspec = spec['slots'] if _is_map(spec.get('slots')) else {}
    for path, pls in sspec.items():
        if not isinstance(pls, list): continue
        for pl in pls:
            if _is_map(pl) and _is_map(pl.get('locator')):
                loc = pl['locator']
                if loc.get('role') not in LOCATOR_ROLES: err(f'/slots/{path}', f"Locator role '{show(loc.get('role', _UNDEF))}' is not an acceptance role", f"Use one of: {', '.join(LOCATOR_ROLES)}")
                k = f"{_to_js_string(loc.get('role', _UNDEF)) if loc.get('role', _UNDEF) is not _UNDEF else 'undefined'}|{_to_js_string(loc.get('name', _UNDEF)) if loc.get('name', _UNDEF) is not _UNDEF else 'undefined'}"
                if k in locs: note(f'/slots/{path}', f"Locator {show(loc.get('role', _UNDEF))} '{show(loc.get('name', _UNDEF))}' is used twice (also {locs[k]})", 'Parity and acceptance cannot tell them apart')
                pid = pl.get('id')
                locs[k] = pid if pid is not None and pid != '' else path


def _edge_key(v): return v if isinstance(v, str) else show(v)


def check_holdout(file, text, spec, spec_path):
    problems = []
    try: h = json.loads(text)
    except ValueError: return [f'{file} does not parse as JSON']
    for e in validate('ui-holdout', h): problems.append(_fmt(file, e['at'], f"schema: {e['msg']}"))
    if not _is_map(h): return problems
    if not spec:
        problems.append(f'{file} has no spec: {_base_name(file)} is not a screen in ui/specs/. Add the spec, or remove the holdout')
        return problems
    data = spec['data'] if _is_map(spec.get('data')) else {}
    for k, v in h.items():
        if k not in data:
            problems.append(_fmt(file, f'/{k}', f"No data key '{k}' in {spec_path}", f"The spec declares: {', '.join(data) or 'no data'}"))
            continue
        d = data[k]
        if _is_map(d) and 'sample' in d and canon(d['sample']) == canon(v):
            problems.append(_fmt(file, f'/{k}', f"The holdout for '{k}' equals the visible sample in {spec_path}", 'Write different values: a holdout that matches the sample proves nothing'))
    return problems


# ---------- pins ----------
def pins(ledger):
    out, at = {}, {}
    for e in ledger or []:
        if e.get('kind') != 'ui_pinned' or not e.get('pack'): continue
        ts = e.get('_ts') or 0
        if e['pack'] in at and at[e['pack']] > ts: continue
        at[e['pack']] = ts
        out[e['pack']] = {'hash': e.get('hash'), 'registry': e.get('registry') or e['pack']}
    return out


def latest_pin(ledger):
    best = None
    for e in ledger or []:
        if e.get('kind') != 'ui_pinned' or not e.get('pack'): continue
        if best is None or (e.get('_ts') or 0) >= (best.get('_ts') or 0): best = e
    return {'pack': best['pack'], 'hash': best.get('hash'), 'registry': best.get('registry') or best['pack']} if best else None


def _rel(p, prefix): return p[len(prefix):] if p.startswith(prefix) else p


def pack_files(components, templates, prefix):
    return sorted(({'path': _rel(f['path'], prefix), 'text': f['text']} for f in [*components, *templates]), key=lambda f: f['path'])


def pack_hash(files): return hash16(''.join(f"{f['path']}\n{_normal(f['text'])}\n" for f in files))


def _by_path(fs): return sorted(fs, key=lambda f: f['path'])


# ---------- gate clauses ----------
def clauses(pack=None, specs=(), holdouts=(), tokens=None, ledger=(), sources=None, acceptance=(), scenarios=(), previews=None, spec_hashes=None, ui_elements=(), legacy=(), decisions=()):
    """The mirror of Ui.clauses: {clauses, notes, coverage}. pack: {components, templates} (the ui/pack/ copy);
    sources: {pack: {components, templates} | None}, a pack left out is not compared."""
    pack = pack or {'components': [], 'templates': []}
    sources = sources or {}
    out, notes, coverage = [], [], []
    has_pack = len(pack['components']) + len(pack['templates']) > 0
    if not has_pack and not specs and not holdouts: return {'clauses': out, 'notes': notes, 'coverage': coverage}
    def push(text, **extra): out.append({'kind': 'ui', 'text': text, **extra})
    groups = token_groups(tokens)
    read_p = None
    if has_pack:
        h = pack_hash(pack_files(pack['components'], pack['templates'], 'ui/pack/'))
        cur = latest_pin(ledger)
        if not cur: push('ui/pack/ is not pinned: pin it from its kind: ui registry')
        elif cur['hash'] != h: push(f"ui/pack/ was edited after it was pinned: restore it, or re-pin from the {cur['registry']} registry", pack=cur['pack'])
        elif cur['pack'] in sources:
            src = sources[cur['pack']]
            if src is None: notes.append(f"{cur['pack']}: its registry could not be read, so whether a newer pack exists is unknown")
            elif pack_hash(pack_files(src['components'], src['templates'], 'ui/')) != h: push(f"{cur['pack']} changed in its registry since it was pinned: re-pin to take it", pack=cur['pack'])
        read_p = read_pack(_by_path(pack['components']), _by_path(pack['templates']), groups)
        for p in read_p['problems']: push(p)
    parsed = {}
    for f in _by_path(specs):
        r = check_spec(f['path'], f['text'], read_p, groups)
        for p in r['problems']:
            extra = {'path': f['path']}
            if r['spec'] and isinstance(r['spec'].get('screen'), str): extra['screen'] = r['spec']['screen']
            push(p, **extra)
        notes.extend(r['notes'])
        if r['spec'] is not None: parsed[_base_name(f['path'])] = {'path': f['path'], 'spec': r['spec']}
    held = set()
    for f in _by_path(holdouts):
        screen = _base_name(f['path'])
        s = parsed.get(screen)
        held.add(screen)
        for p in check_holdout(f['path'], f['text'], s['spec'] if s else None, s['path'] if s else f'ui/specs/{screen}.json'): push(p, path=f['path'], screen=screen)
    for screen in sorted(parsed):
        if screen not in held: coverage.append(f"{parsed[screen]['path']}: no holdout sample (ui/holdout/{screen}.json), so a page hard-coded to the visible sample would pass")
    _state_rules(parsed, acceptance or [], scenarios or [], push, coverage)
    _preview_rules(parsed, acceptance or [], ledger or [], previews or {}, spec_hashes or {}, ui_elements or [], push)
    _legacy_rules(parsed, legacy or [], decisions or [], ledger or [], previews or {}, spec_hashes or {}, read_p, push, notes)
    return {'clauses': out, 'notes': notes, 'coverage': coverage}


def spec_diff(legacy, nxt):
    """The mirror of Ui.specDiff."""
    def place(spec):
        m = {}
        slots = spec.get('slots') if _is_map(spec) and _is_map(spec.get('slots')) else {}
        for slot, lst in slots.items():
            for pl in lst if isinstance(lst, list) else []:
                if not _is_map(pl): continue
                loc = pl['locator'] if _is_map(pl.get('locator')) and pl['locator'].get('role') and pl['locator'].get('name') is not None else None
                loc = {'role': loc['role'], 'name': loc['name']} if loc else None
                key = f"{loc['role']}:{loc['name']}" if loc else f"{slot}/{pl.get('id')}"
                m[key] = {'key': key, 'slot': slot, 'id': pl.get('id'), 'component': pl.get('component'), 'locator': loc,
                          'props': pl['props'] if _is_map(pl.get('props')) else {}, 'bind': pl['bind'] if _is_map(pl.get('bind')) else {}}
        return m
    brief = lambda p: {'key': p['key'], 'slot': p['slot'], 'id': p['id'], 'component': p['component'], 'locator': p['locator']}
    a, b = place(legacy), place(nxt)
    added = [brief(p) for k, p in b.items() if k not in a]
    removed, changed = [], []
    for k, p in a.items():
        q = b.get(k)
        if q is None: removed.append(brief(p)); continue
        fields = []
        if p['slot'] != q['slot']: fields.append('slot')
        if p['component'] != q['component']: fields.append('component')
        for grp in ('props', 'bind'):
            x, y = p[grp], q[grp]
            for n in set(x) | set(y):
                if (n in x) != (n in y) or canon(x.get(n)) != canon(y.get(n)): fields.append(f'{grp}.{n}')
        if fields: changed.append({**brief(q), 'fields': sorted(fields)})
    def names(x, y):
        x = x if _is_map(x) else {}; y = y if _is_map(y) else {}
        return sorted(n for n in y if n not in x)
    ld = legacy['data'] if _is_map(legacy) and _is_map(legacy.get('data')) else {}
    nd = nxt['data'] if _is_map(nxt) and _is_map(nxt.get('data')) else {}
    dchanged = []
    for n in sorted(nd):
        if n in ld:
            f = [k for k in ('shape', 'source') if canon((ld[n] or {}).get(k) if _is_map(ld[n]) else None) != canon((nd[n] or {}).get(k) if _is_map(nd[n]) else None)]
            if f: dchanged.append({'key': n, 'fields': f})
    lt, nt = (legacy or {}).get('template'), (nxt or {}).get('template')
    key = lambda p: p['key']
    return {'template': None if lt == nt else {'from': lt, 'to': nt},
            'placements': {'added': sorted(added, key=key), 'removed': sorted(removed, key=key), 'changed': sorted(changed, key=key)},
            'states': {'added': names((legacy or {}).get('states'), (nxt or {}).get('states')), 'removed': names((nxt or {}).get('states'), (legacy or {}).get('states'))},
            'data': {'added': names(ld, nd), 'removed': names(nd, ld), 'changed': dchanged}}


def _legacy_rules(parsed, legacy, decisions, ledger, previews, spec_hashes, read_p, push, notes):
    """The mirror of legacyRules in renderer/ui.js: a spec copied from ui/legacy/<screen>.json says what it changed."""
    sq = lambda t: re.sub(r'\s+', ' ', '' if t is None else str(t)).strip()
    for f in _by_path(legacy):
        screen = _base_name(f['path'])
        mine = parsed.get(screen)
        if not mine or not _is_map(mine['spec']): continue
        try: old = json.loads(f['text'])
        except ValueError: old = None
        if not _is_map(old): notes.append(f"{f['path']} does not parse as a JSON object, so {mine['path']} is not compared with it"); continue
        d, path = spec_diff(old, mine['spec']), mine['path']
        extra = {'path': path, 'screen': screen}
        bound = [x for x in decisions if isinstance(x, dict) and x.get('status') == 'bound']
        for p in d['placements']['added'] + d['placements']['changed']:
            if not p['locator']: push(_fmt(path, '', f"{p['key']} is new or changed from legacy, so it needs a locator"), **extra)
        removes = []
        for x in bound:
            if x.get('kind') != 'business' or not isinstance(x.get('removes'), list): continue
            for r in x['removes']:
                if _is_map(r) and isinstance(r.get('role'), str) and (r.get('screen') in (None, '', screen)): removes.append(f"{r['role']}\n{sq(r.get('name'))}")
        for p in d['placements']['removed']:
            if not p['locator']: push(_fmt(path, '', f"{p['key']} is removed from legacy and has no locator, so no decision can say it is removed", 'Give it a locator in the legacy spec'), **extra)
            elif f"{p['locator']['role']}\n{sq(p['locator']['name'])}" not in removes: push(_fmt(path, '', f"{p['locator']['role']} '{p['locator']['name']}' is removed from legacy with no bound decision that removes it"), **extra)
        def token_prop(p, x):
            if not x.startswith('props.'): return False
            c = read_p['components'].get(p['component']) if read_p else None
            props = c['m'].get('props') if c and _is_map(c['m'].get('props')) else {}
            dfn = props.get(x[6:])
            return _is_map(dfn) and dfn.get('type') == 'token'
        look = d['template'] is not None or any(token_prop(p, x) for p in d['placements']['changed'] for x in p['fields'])
        if look and not (any(x.get('look') == screen for x in bound) and _approval_current(screen, ledger, previews, spec_hashes)):
            push(_fmt(path, '', f'the look of {screen} differs from legacy with no bound decision citing its approved previews'), **extra)


def _approval_current(screen, ledger, previews, spec_hashes):
    def latest(kind):
        best = None
        for e in ledger:
            if e.get('kind') == kind and e.get('screen') == screen and (best is None or (e.get('_ts') or 0) >= (best.get('_ts') or 0)): best = e
        return best
    rend, appr = latest('ui_preview_rendered'), latest('ui_preview_approved')
    if not rend or not appr or (appr.get('_ts') or 0) <= (rend.get('_ts') or 0): return False
    return canon(appr['files'] if _is_map(appr.get('files')) else {}) == canon(previews.get(screen) or {}) and appr.get('spec') == spec_hashes.get(screen)


# The spec's states are the spine: R1 (criterion states/cases), R2 (parity step states), R4 (unrecorded states), R5 (commits).
_ACCEPTANCE_STATES = ['ready', 'loading', 'empty', 'error', 'forbidden']


def _state_rules(parsed, acceptance, scenarios, push, coverage):
    specs = sorted((x for x in parsed.values() if _is_map(x['spec']) and _is_map(x['spec'].get('states'))), key=lambda x: x['path'])
    for x in specs:
        path, spec = x['path'], x['spec']
        names = list(spec['states'])
        hint = f"The spec has: {', '.join(names)}"
        def bad(at, state, path=path, spec=spec, hint=hint): push(_fmt(at, '', f"State '{show(state)}' is not in spec {spec.get('screen')}", hint), path=path, screen=spec.get('screen'))
        for a in acceptance:
            if not isinstance(a, dict) or a.get('component') != spec.get('component'): continue
            for i, st in enumerate(a['states'] if isinstance(a.get('states'), list) else []):
                if st in _ACCEPTANCE_STATES and st not in names: bad(f"acceptance/{a['id']}/states/{i}", st)
            for i, c in enumerate(a['cases'] if isinstance(a.get('cases'), list) else []):
                if isinstance(c, dict) and c.get('state') in _ACCEPTANCE_STATES and c['state'] not in names: bad(f"acceptance/{a['id']}/cases/{i}/state", c['state'])
        recorded = set()
        for sc in scenarios:
            if not isinstance(sc, dict) or not isinstance(sc.get('screen'), str) or sc['screen'] != spec.get('screen'): continue
            for i, st in enumerate(sc['steps'] if isinstance(sc.get('steps'), list) else []):
                if not isinstance(st, dict) or not isinstance(st.get('state'), str): continue
                recorded.add(st['state'])
                if st['state'] not in names: bad(f"parity/scenarios/{sc.get('id')}/steps/{i}/state", st['state'])
        trans = spec['transitions'] if isinstance(spec.get('transitions'), list) else []
        initial = [n for n in names if _is_map(spec['states'][n]) and spec['states'][n].get('initial')]
        def reach(read_only):
            m = {}
            for t in trans:
                if _is_map(t) and (not read_only or t.get('commits') is not True): m.setdefault(_edge_key(t.get('from', _UNDEF)), []).append(t.get('to', _UNDEF))
            seen = set(initial) if len(initial) == 1 else set()
            todo = list(seen)
            while todo:
                for n in m.get(_edge_key(todo.pop()), []):
                    if isinstance(n, str) and n not in seen: seen.add(n); todo.append(n)
            return seen
        commit_only = set()
        for i, t in enumerate(trans):
            if _is_map(t) and t.get('commits') is True: coverage.append(f"{path} /transitions/{i}: {show(t.get('from', _UNDEF))} → {show(t.get('to', _UNDEF))} commits, so parity cannot record it read-only")
        if len(initial) == 1:
            allr, ro = reach(False), reach(True)
            for n in names:
                if n in allr and n not in ro:
                    commit_only.add(n); coverage.append(f"{path} /states/{n}: State '{n}' is reachable only through transitions that commit, so no read-only scenario can record it")
        for n in names:
            if n not in recorded and n not in commit_only: coverage.append(f"{path} /states/{n}: State '{n}' is recorded by no parity step, so no scenario shows it")


def _preview_rules(parsed, acceptance, ledger, previews, spec_hashes, ui_elements, push):
    """Check 4, the mirror of previewRules in renderer/ui.js: a UI element needs a bound spec and previews a person approved."""
    def latest(kind, screen):
        best = None
        for e in ledger:
            if e.get('kind') == kind and e.get('screen') == screen and (best is None or (e.get('_ts') or 0) >= (best.get('_ts') or 0)): best = e
        return best
    for name in ui_elements:
        mine = sorted((x for x in parsed.values() if _is_map(x['spec']) and x['spec'].get('component') == name), key=lambda x: x['path'])
        if not mine:
            push(f'no screen spec for component {name}. Add ui/specs/<screen>.json with component "{name}"', about=[name]); continue
        for x in mine:
            path, spec = x['path'], x['spec']
            screen = spec.get('screen')
            extra = {'about': [name], 'path': path, 'screen': screen}
            def say(msg, hint, path=path, extra=extra): push(_fmt(path, '', msg, hint), **extra)
            if spec.get('status') != 'bound': say('spec not bound', 'Check the previews, then press Approve and bind'); continue
            rend = latest('ui_preview_rendered', screen)
            if not rend: say('previews not rendered', f'Run factory-s2 preview for {screen}'); continue
            appr = latest('ui_preview_approved', screen)
            if not appr: say('previews not approved', 'Look at the page pictures, then press Approve previews'); continue
            if (appr.get('_ts') or 0) <= (rend.get('_ts') or 0): say('approval is stale: rendered again since', 'Look at the new previews, then approve again'); continue
            disk = previews.get(screen) or {}
            held = appr['files'] if _is_map(appr.get('files')) else {}
            if disk != held: say('approval is stale: files changed since', 'Render again, then approve'); continue
            if appr.get('spec') != spec_hashes.get(screen): say('approval is stale: the spec changed since', 'Render again, then approve'); continue
            crit = [a for a in acceptance if isinstance(a, dict) and a.get('component') == name]
            if crit:
                wanted = []
                for a in crit:
                    for st in (a['states'] if isinstance(a.get('states'), list) else []):
                        if st not in wanted: wanted.append(st)
            else: wanted = list(spec['states']) if _is_map(spec.get('states')) else []
            for st in wanted:
                if not any('/' not in k and k.startswith(f'{st}-') and k.endswith('.png') for k in held): say(f'no approved preview for state {st}', 'Render the spec again, then approve')
