"""Work items: the Python mirror of the file rules in renderer/work.js (validate, states, conflicts).
A work item is a file in work/. Done is judged in the app, from recorded evidence and git; this mirror
lets an agent session ask what is active and what clashes: `designc work <registry>`."""
from . import pathpattern

KINDS = ('gate', 'checklist', 'review', 'judge', 'parity')
TARGETS = ('document', 'jira', 'investigation')


def _list(v): return v if isinstance(v, list) else []


def _str(v):
    """String(v) as JavaScript writes it, for the values YAML gives."""
    if v is None: return ''
    if isinstance(v, bool): return 'true' if v else 'false'
    return str(v)


def is_repo(item): return item.get('target') is None


def reqs(item):
    """The requirement ids an item names (Work.reqs): one id or a list of them, blanks dropped."""
    r = item.get('requirement') if isinstance(item, dict) else None
    vals = r if isinstance(r, list) else ([] if r is None else [r])
    return [s for s in (_str(v).strip() for v in vals) if s]


def validate(item, requirements, item_ids, scenarios=None):
    """What is wrong with this item. The sentences are identical to Work.validate in work.js.
    scenarios: the ids in parity/scenarios/, when known; a parity entry naming another id is then a problem."""
    out = []
    if not isinstance(item, dict): return ['The work item is not a mapping.']
    iid = _str(item.get('id')) or '(no id)'
    if not item.get('id'): out.append('The work item has no id.')
    ids = reqs(item)
    has_req = len(ids) > 0
    has_target = item.get('target') is not None
    if has_req == has_target: out.append(f'{iid}: name either a requirement (with elements) or a target, not both and not neither.')
    if has_target:
        t = item['target']
        keys = list(t.keys()) if isinstance(t, dict) else []
        if len(keys) != 1 or keys[0] not in TARGETS or not _str(t[keys[0]] or '').strip():
            out.append(f'{iid}: target must have one of document, jira or investigation, with a value.')
    if has_req:
        found = [next((r for r in requirements if _str(r.get('id')) == x), None) for x in ids]
        for x, r in zip(ids, found):
            if r is None: out.append(f'{iid}: requirement {x} does not exist in requirements/.')
        if not _list(item.get('elements')): out.append(f'{iid}: a repo item needs elements, the design elements it changes.')
        if all(r is not None for r in found):
            named = [e for r in found for e in _list(r.get('elements'))]
            which = f'requirement {ids[0]}' if len(ids) == 1 else f"requirements {', '.join(ids)}"
            fix = 'Add it to the requirement' if len(ids) == 1 else 'Add it to one of them'
            for el in _list(item.get('elements')):
                if el not in named:
                    out.append(f'{iid}: {_str(el)} is not an element of {which}. {fix}, or take it out of this item.')
    for d in _list(item.get('depends_on')):
        if _str(d) not in item_ids: out.append(f'{iid}: depends_on {_str(d)} is not a work item.')
    for w in _list(item.get('writes')):
        v, err = pathpattern.create(w)
        if v is None: out.append(f'{iid}: writes entry is not a path pattern: {err}')
    dw = _list(item.get('done_when'))
    if not dw: out.append(f'{iid}: done_when is empty; say what done means with at least one gate, checklist or review entry.')
    kinds = []
    for i, e in enumerate(dw):
        ks = list(e.keys()) if isinstance(e, dict) else []
        known = [k for k in ks if k in KINDS]
        unknown = [k for k in ks if k not in KINDS]
        n = i + 1
        if unknown: out.append(f"{iid}: done_when entry {n} has unknown kind {', '.join(unknown)}; use gate, checklist, review, judge or parity.")
        elif len(known) != 1: out.append(f'{iid}: done_when entry {n} must have exactly one of gate, checklist, review, judge or parity.')
        elif not _str(e[known[0]]).strip(): out.append(f'{iid}: done_when entry {n} ({known[0]}) is empty.')
        else:
            kinds.append(known[0])
            v = _str(e[known[0]]).strip()
            if known[0] == 'parity' and not has_req:
                out.append(f'{iid}: done_when entry {n} (parity) is allowed only on a repo item: parity is judged at the commit that finished it.')
            elif known[0] == 'parity' and isinstance(scenarios, list) and v != 'all' and v not in scenarios:
                out.append(f'{iid}: done_when entry {n} names parity scenario {v}, which is not in parity/scenarios/.')
    if 'judge' in kinds and all(k == 'judge' for k in kinds):
        out.append(f'{iid}: a judge cannot be the only done_when entry; add a gate, checklist or review (a judge is a gradient, not a decision).')
    if has_req and dw and 'gate' not in kinds and not (kinds and all(k == 'judge' for k in kinds)):
        out.append(f'{iid}: a repo item needs a gate in done_when (a command that passes at the commit).')
    return out


def states(items, events):
    """backlog until pulled, active until done, from the ledger."""
    out = {}
    ev = sorted(events, key=lambda e: e.get('_ts') or 0)
    for it in items:
        s = 'backlog'
        for e in ev:
            if e.get('item') != it['id']: continue
            if e.get('kind') == 'item_pulled': s = 'active'
            elif e.get('kind') == 'item_done': s = 'done'
        out[it['id']] = s
    return out


def conflicts(item, others):
    out = []
    for o in others:
        if o['id'] == item['id']: continue
        aw = [v for v in (pathpattern.create(w)[0] for w in _list(item.get('writes'))) if v]
        bw = [v for v in (pathpattern.create(w)[0] for w in _list(o.get('writes'))) if v]
        hit = next((f'{a} and {b}' for a in aw for b in bw if pathpattern.may_overlap(a, b)), None)
        if hit: out.append({'with': o['id'], 'reason': 'writes', 'detail': f'writes may overlap: {hit}'}); continue
        el = next((e for e in _list(item.get('elements')) if e in _list(o.get('elements'))), None)
        if el is not None: out.append({'with': o['id'], 'reason': 'element', 'detail': f'both change {el}'}); continue
        t, ot = item.get('target'), o.get('target')
        if isinstance(t, dict) and isinstance(ot, dict) and t:
            k = next(iter(t))
            if k in ot and _str(ot[k]) == _str(t[k]):
                out.append({'with': o['id'], 'reason': 'target', 'detail': f'both target {k} {t[k]}'})
    return out


def coverage(items, requirements):
    """Requirement elements no repo item of that requirement covers; only requirements that have an item."""
    out = []
    for r in requirements:
        mine = [i for i in items if is_repo(i) and _str(r.get('id')) in reqs(i)]
        if not mine: continue
        for el in _list(r.get('elements')):
            if not any(el in _list(i.get('elements')) for i in mine):
                out.append({'requirement': r.get('id'), 'element': el, 'items': [i['id'] for i in mine]})
    return out


def report(items, requirements, events, parse_errors=(), scenarios=None):
    """One row per item: state, problems, and clashes with the other active items."""
    ids = [i['id'] for i in items]
    st = states(items, events)
    active = [i for i in items if st[i['id']] == 'active']
    rows, seen = [], set()
    for it in items:
        problems = validate(it, requirements, [x for x in ids if x != it['id']], scenarios)
        if it['id'] in seen: problems.append(f"{it['id']}: duplicate work item id")
        seen.add(it['id'])
        rows.append({'id': it['id'], 'path': it.get('_path'), 'state': st[it['id']], 'problems': problems,
                     'conflicts': conflicts(it, active) if st[it['id']] != 'done' else []})
    return {'items': rows, 'uncovered': coverage(items, requirements), 'errors': [{'path': e['path'], 'msg': e['msg']} for e in parse_errors]}
