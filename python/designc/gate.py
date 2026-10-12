"""The definition-of-ready gate and scenario report. A port of Core.gate and Core.scenarioReport."""
import datetime as _dt
import re
import time
from urllib.parse import urlparse

from .evals import _OPS, parse_threshold
from .rules import fingerprint, get, hash16, interaction, num, structural



def accept_without_check(dec):
    """An accepted risk rests on its business decision and needs no check; a TODO placeholder is not a check.
    Same rule as core.js and renderer/ledger.js."""
    return dec.get('effect') == 'accept' and not any(c and not str(c).startswith('TODO') for c in (dec.get('checks') or []))

def _s(v):
    """String(v) as JavaScript does it, for ids and versions read from YAML."""
    if isinstance(v, bool): return 'true' if v else 'false'
    if isinstance(v, float) and v.is_integer(): return str(int(v))
    return str(v)


def latest(ledger, kind, key, value):
    hits = [e for e in ledger if e.get('kind') == kind and e.get(key) == value]
    return sorted(hits, key=lambda e: -(e.get('_ts') or 0))[0] if hits else None


def _find_el(model, name):
    return next((e for e in model.elements.values() if e.name == name), None)


RATINGS = ('high', 'medium', 'low')


def _rating(v):
    return v if isinstance(v, str) and v in RATINGS else None


def scenario_report(model, scenarios, ledger):
    rows = []
    for s in scenarios:
        row = {'id': s['id'], 'title': s.get('title') or '', 'attribute': s['attribute'], 'artifact': s['artifact'], 'measure': s.get('measure'), 'importance': _rating(s.get('importance')), 'difficulty': _rating(s.get('difficulty'))}
        el = _find_el(model, s['artifact'])
        cmds = [c for c in (s.get('fitness') or []) if c and not str(c).startswith('TODO')]
        last = latest(ledger, 'fitness', 'scenario', s['id'])
        row['fitness'] = {'status': 'none' if not cmds else 'unchecked' if not last else 'passing' if last.get('outcome') == 'pass' else 'failing', 'commands': cmds}
        if not el:
            row['status'] = 'unresolved'; row['analytic'] = {'status': 'n/a'}; rows.append(row); continue
        row['status'] = 'resolved'
        m = s.get('measure') or {}
        v = m.get('value')
        if s['attribute'] != 'availability' or m.get('metric') != 'availability' or isinstance(v, bool) or not isinstance(v, (int, float)):
            row['analytic'] = {'status': 'n/a'}; rows.append(row); continue
        seen, queue = {el.id}, [el.id]
        for cur in queue:
            for r in model.rels:
                if r.src != cur or r.dst in seen or structural(model, r) or interaction(r) != 'sync': continue
                seen.add(r.dst); queue.append(r.dst)
        els = [model.elements[i] for i in seen]
        missing = [e.name for e in els if get(e, 'd.availability') is None]
        if missing:
            row['analytic'] = {'status': 'unknown', 'missing': missing}; rows.append(row); continue
        value = 1
        for e in els: value *= float(get(e, 'd.availability'))
        value *= 100
        ok = value <= v if m.get('op') == '<=' else value >= v
        row['analytic'] = {'status': 'met' if ok else 'not-met', 'value': value, 'elements': [e.name for e in els]}
        rows.append(row)
    return rows


def _business_evidence(dec, hosts, owners, clauses):
    def say(text): clauses.append({'kind': 'evidence', 'text': text, 'decision': dec['id']})
    if not dec.get('evidence') and dec.get('promoted_by') in owners: return
    if not dec.get('evidence'): return say(f"{dec['id']} is a business decision without evidence")
    u = urlparse(str(dec['evidence']))
    if u.scheme != 'https' or not u.hostname: return say(f"{dec['id']}: evidence must be an https URL")
    if u.hostname not in hosts: say(f"{dec['id']}: evidence host {u.hostname} is not allowed (see evidenceHosts in designc.json)")


def _resolve_binding(model, entry):
    els = list(model.elements.values())
    return next((e for e in els if e.ident and e.ident == entry.get('element')), None) or next((e for e in els if e.name == entry.get('name')), None)


def _iso_day(v):
    if isinstance(v, _dt.datetime): v = v.date()
    if isinstance(v, _dt.date): return v.isoformat()
    if not isinstance(v, str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}', v): return None
    try: return _dt.date.fromisoformat(v).isoformat()
    except ValueError: return None


def _assumption_clauses(dec, today, clauses):
    if dec.get('assumptions') is None: return
    bad = {'kind': 'assumption', 'text': f"{dec['id']}: each assumption needs text and a review_by date (YYYY-MM-DD)"}
    if not isinstance(dec['assumptions'], list):
        clauses.append(bad); return
    flagged = False
    for a in dec['assumptions']:
        day = _iso_day(a.get('review_by')) if isinstance(a, dict) and isinstance(a.get('text'), str) and a['text'].strip() else None
        if not day:
            if not flagged: clauses.append(bad)
            flagged = True; continue
        if day < today: clauses.append({'kind': 'assumption', 'text': f"{dec['id']}: assumption \"{a['text'].strip()[:60]}\" was due for review on {day}"})


# ---------- acceptance criteria (Core.acceptanceClauses) ----------
UI_STATES = ['ready', 'loading', 'empty', 'error', 'forbidden']
LOCATOR_ROLES = ['alert', 'button', 'cell', 'checkbox', 'combobox', 'dialog', 'form', 'heading', 'img', 'label', 'link', 'list', 'listitem', 'main', 'navigation', 'option', 'radio', 'region', 'row', 'searchbox', 'status', 'switch', 'tab', 'table', 'tabpanel', 'textbox']


def _key(s): return re.sub(r'[^a-z0-9]', '', str(s).lower())


def resolve_element(model, ref):
    """Core.resolveElement: the elements.json id first, then a name or d.aka exactly one element carries."""
    if ref is None or ref == '': return None
    text = _s(ref)
    allel = list(model.elements.values())
    by_id = [e for e in allel if model.label(e.id) == text]
    if len(by_id) == 1: return by_id[0]
    k = _key(text)
    if not k: return None
    named = [e for e in allel if any(_key(n) == k for n in [e.name, *(get(e, 'd.aka') or [])])]
    return named[0] if len(named) == 1 else None


def acceptance_clauses(model, acceptance, requirements, decisions):
    out = []
    def say(text, about=None): out.append({'kind': 'acceptance', 'text': text, **({'about': about} if about else {})})
    def inside(eid, root):
        c = model.elements.get(eid)
        while c:
            if c.id == root: return True
            c = model.elements.get(c.parent) if c.parent else None
        return False
    def auth_boundary(el): return any(get(r, 'd.authenticated') == 'yes' and inside(r.dst, el.id) for r in model.rels)
    valid = []
    for a in acceptance:
        aid = _s(a['id']) if isinstance(a, dict) and a.get('id') else None
        if not isinstance(a, dict) or not aid or not a.get('requirement') or not a.get('element') or not isinstance(a.get('states'), list) or not isinstance(a.get('cases'), list):
            say(f"{aid or 'an acceptance criterion'}: needs requirement, element, states and cases"); continue
        if not any(r['id'] == _s(a['requirement']) for r in requirements): say(f"{aid}: requirement {_s(a['requirement'])} is not in the registry")
        if a.get('decision') and not any(d['id'] == _s(a['decision']) for d in decisions): say(f"{aid}: decision {_s(a['decision'])} is not in the registry")
        el = resolve_element(model, a['element'])
        if not el:
            say(f"{aid}: element \"{_s(a['element'])}\" is not in the model", [_s(a['element'])]); continue
        valid.append((a, el))
        for st in a['states']:
            if st not in UI_STATES: say(f"{aid}: unknown state \"{_s(st)}\" (use {', '.join(UI_STATES)})", [el.name])
        for c in a['cases']:
            state = c.get('state') if isinstance(c, dict) else None
            if state not in UI_STATES:
                say(f"{aid}: a case names an unknown state \"{'undefined' if state is None else _s(state)}\"", [el.name]); continue
            if not c.get('given') or not c.get('then'): say(f"{aid}: case for {state} needs given and then", [el.name])
        raw = a.get('locators')
        locs = raw if isinstance(raw, dict) else {}
        if raw is not None and not isinstance(raw, dict): say(f"{aid}: locators must map a name to a role and an accessible name", [el.name])
        for n, l in locs.items():
            if not isinstance(l, dict) or not l.get('name') or not str(l['name']).strip(): say(f"{aid}: locator \"{_s(n)}\" needs a role and an accessible name", [el.name])
            elif l.get('role') not in LOCATOR_ROLES: say(f"{aid}: locator \"{_s(n)}\" has role \"{_s(l.get('role'))}\" (use {', '.join(LOCATOR_ROLES)})", [el.name])
        for c in a['cases']:
            uses = c.get('uses') if isinstance(c, dict) and isinstance(c.get('uses'), list) else []
            for n in uses:
                if n not in locs: say(f"{aid}: case for {c.get('state')} uses locator \"{_s(n)}\" that is not declared", [el.name])
        if a.get('ux') is not None:
            u = a['ux']
            def ux(x): say(f"{aid}: ux {x}", [el.name])
            if not isinstance(u, dict): ux('must be a mapping of keyboard, focus_order, focus_return and breakpoints')
            else:
                if 'keyboard' in u and not isinstance(u['keyboard'], bool): ux('keyboard must be true or false')
                if 'focus_order' in u:
                    fo = u['focus_order']
                    if not isinstance(fo, list) or not fo: ux('focus_order must list locator names in tab order')
                    else:
                        for n in fo:
                            if n not in locs: ux(f'focus_order names locator "{_s(n)}" that is not declared')
                if 'focus_return' in u and u['focus_return'] not in locs: ux(f'focus_return names locator "{_s(u["focus_return"])}" that is not declared')
                if 'breakpoints' in u:
                    bp = u['breakpoints']
                    if not isinstance(bp, list) or not bp or any(isinstance(b, bool) or not isinstance(b, int) or b < 200 or b > 4000 for b in bp):
                        ux('breakpoints must be whole pixel widths between 200 and 4000')
        need = ['ready', 'loading', 'empty', 'error'] + (['forbidden'] if auth_boundary(el) or 'forbidden' in a['states'] else [])
        for st in need:
            if not any(isinstance(c, dict) and c.get('state') == st for c in a['cases']): say(f"{aid}: no case for state {st}", [el.name])
    for req in requirements:
        for n in req.get('elements') or []:
            for el in model.elements.values():
                if el.name != n or 'UI' not in el.tags: continue
                if not any(_s(a['requirement']) == req['id'] and e.id == el.id for a, e in valid):
                    say(f"{req['id']}: {el.name} is a UI element with no acceptance criterion", [el.name])
    return out


# ---------- design tokens (Core.tokenClauses) ----------
DEFAULT_MIN_TEXT = 12


def _token_px(v):
    if isinstance(v, dict) and 'value' in v:
        return _token_px(f"{v['value']}{v['unit']}" if isinstance(v.get('unit'), str) else v['value'])
    if isinstance(v, bool): return None
    if isinstance(v, (int, float)): return v
    m = re.match(r'^\s*(-?\d+(?:\.\d+)?)\s*(px|rem)?\s*$', str(v))
    return float(m.group(1)) * (16 if m.group(2) == 'rem' else 1) if m else None


def _is_text_size_path(path):
    seg = [re.sub(r'[^a-z0-9]', '', str(x).lower()) for x in path]
    return any(x in ('fontsize', 'textsize') or (x in ('font', 'text') and i + 1 < len(seg) and seg[i + 1] == 'size') for i, x in enumerate(seg))


def token_clauses(text, min_text_size=DEFAULT_MIN_TEXT):
    if text is None: return []
    def say(t): return {'kind': 'tokens', 'text': f'design-tokens/tokens.json: {t}'}
    import json
    try: doc = json.loads(text)
    except ValueError: return [say('does not parse as JSON. Fix the file, then check again')]
    if not isinstance(doc, dict): return [say('must be a JSON object of token groups')]
    out = []
    def walk(node, path):
        if not isinstance(node, dict): return
        if '$value' in node:
            if not _is_text_size_path(path): return
            px = _token_px(node['$value'])
            name = '.'.join(path)
            if px is None: out.append(say(f'{name} is a text size but its value is not px or rem. Write it as "16px" or "1rem"'))
            elif px < min_text_size:
                shown = int(px) if px == int(px) else px
                out.append(say(f'{name} is {shown}px, below the minimum text size of {min_text_size}px. Raise it, or lower ux.minTextSize in designc.json if that is intended'))
            return
        for k, v in node.items():
            if not str(k).startswith('$'): walk(v, path + [k])
    walk(doc, [])
    return out


def gate(model, diags, decisions, requirements, ledger, registry_errors=(), evidence_hosts=(), scenarios=(), evals=(), now=None, business_owners=(), acceptance=(), tokens=None, min_text_size=DEFAULT_MIN_TEXT):
    clauses = []
    if model.errors:
        clauses.append({'kind': 'parse', 'text': f'{len(model.errors)} model error(s) must be fixed first'})
    for kind, lst in (('decision', decisions), ('requirement', requirements)):
        seen, said = set(), set()
        for x in lst:
            i = x['id']
            if i in seen and i not in said:
                said.add(i); clauses.append({'kind': 'duplicate', 'text': f'duplicate id {i}'})
            seen.add(i)
    for e in registry_errors: clauses.append({'kind': 'registry', 'text': f"{e['path']} does not parse"})
    today = _dt.datetime.fromtimestamp((time.time() * 1000 if now is None else now) / 1000, _dt.timezone.utc).date().isoformat()
    bound = [d for d in decisions if d.get('status') == 'bound']

    def covers(dec, f):
        return dec.get('effect') == 'accept' and f['code'] in (dec.get('resolves') or []) and any(b in f['loc']['names'] for b in (dec.get('binds') or []))

    for f in diags:
        if f['suppressed'] or f['sev'] == 'note': continue
        if any(covers(d, f) for d in bound): continue
        clauses.append({'kind': 'finding', 'text': f"{f['code']} on {f['loc']['label']} is neither fixed nor accepted",
                        'about': list(f['loc']['names']) + [n for r in f.get('related') or [] for n in r.get('names', [])]})
    bound_business = {d['id'] for d in decisions if d.get('status') == 'bound' and d.get('kind') == 'business'}
    for dec in decisions:
        mark = len(clauses)
        try:
            kind = 'technical' if dec.get('kind') is None else dec['kind']
            if kind not in ('business', 'technical'):
                clauses.append({'kind': 'decision', 'text': f"{dec['id']} has kind {_s(kind)}, expected business or technical"})
            if dec.get('status') != 'bound':
                clauses.append({'kind': 'decision', 'text': f"{dec['id']} is {dec.get('status') or 'minted'}, not bound"}); continue
            business = kind == 'business'
            _assumption_clauses(dec, today, clauses)
            if business: _business_evidence(dec, list(evidence_hosts), list(business_owners), clauses)
            elif dec.get('effect') == 'accept' and not any(i in bound_business for i in (dec.get('relies_on') or [])):
                clauses.append({'kind': 'decision', 'text': f"{dec['id']} accepts a risk without a bound business decision"})
            if not business and not accept_without_check(dec):
                if not (dec.get('checks') or []):
                    clauses.append({'kind': 'decision', 'text': f"{dec['id']} has no check"}); continue
                last = latest(ledger, 'check', 'decision', dec['id'])
                if not last: clauses.append({'kind': 'check', 'text': f"{dec['id']}: no check result recorded yet"})
                elif last.get('outcome') != 'pass': clauses.append({'kind': 'check', 'text': f"{dec['id']}: last check failed"})
            pa_list = dec.get('promoted_against')
            if not isinstance(pa_list, list):
                clauses.append({'kind': 'promotion', 'text': f"{dec['id']} is bound without a fingerprint"})
            else:
                for pa in pa_list:
                    pa = pa if isinstance(pa, dict) else {}
                    if pa.get('requirement') is not None:
                        req = next((r for r in requirements if r['id'] == pa['requirement']), None)
                        if not req: clauses.append({'kind': 'promotion', 'text': f"{dec['id']}: binding {_s(pa['requirement'])} does not resolve"})
                        elif _s(req.get('version')) != _s(pa.get('version')): clauses.append({'kind': 'promotion', 'text': f"{dec['id']}: {req['id']} changed since promotion"})
                        continue
                    el = _resolve_binding(model, pa)
                    if not el: clauses.append({'kind': 'promotion', 'text': f"{dec['id']}: binding {_s(pa.get('name'))} does not resolve"})
                    elif fingerprint(model, el.id)['hash'] != pa.get('hash'): clauses.append({'kind': 'promotion', 'text': f"{dec['id']}: {el.name} changed since promotion"})
            if dec.get('effect') == 'fix':
                still = [f for f in diags if not f['suppressed'] and f['code'] in (dec.get('resolves') or []) and any(b in f['loc']['names'] for b in (dec.get('binds') or []))]
                if still: clauses.append({'kind': 'decision', 'text': f"{dec['id']} says {', '.join(dec['resolves'])} is fixed, but the model still raises it"})
        finally:
            for c in clauses[mark:]: c.setdefault('decision', dec['id'])

    names = {e.name for e in model.elements.values()}
    for req in requirements:
        traced = any(d.get('requirement') == req['id'] for d in decisions) or any(n in names for n in (req.get('elements') or []))
        if not traced: clauses.append({'kind': 'requirement', 'text': f"{req['id']} is not traced to any element or decision", 'requirement': req['id']})
    for nd in (e for e in ledger if e.get('kind') == 'needs_decision' and e.get('status') == 'open'):
        clauses.append({'kind': 'needs', 'text': f"open needs-decision {nd.get('id') or ''}: {nd.get('question')}".strip(),
                        **({'about': [_s(nd['element'])]} if nd.get('element') else {})})
    complete = []
    for s in scenarios:
        if not isinstance(s, dict) or not s.get('id') or not s.get('artifact') or not s.get('attribute') or not s.get('measure'):
            sid = s.get('id') if isinstance(s, dict) else None
            clauses.append({'kind': 'scenario', 'text': f"{sid or 'a scenario'} needs artifact, attribute and measure"})
        else: complete.append(s)
    for s in scenarios:
        if not isinstance(s, dict) or not s.get('id'): continue
        for f in ('importance', 'difficulty'):
            if s.get(f) is not None and _rating(s.get(f)) is None: clauses.append({'kind': 'scenario', 'text': f"{s['id']}: {f} must be high, medium or low"})
    for r in scenario_report(model, complete, ledger):
        if r['status'] == 'unresolved': clauses.append({'kind': 'scenario', 'text': f"{r['id']}: artifact \"{r['artifact']}\" is not in the model", 'about': [r['artifact']]})
        elif r['analytic']['status'] == 'not-met':
            m = r['measure']
            clauses.append({'kind': 'scenario', 'text': f"{r['id']} is not met: availability ≈ {r['analytic']['value']:.2f}% against {'≤' if m.get('op') == '<=' else '≥'} {num(m.get('value'))}%", 'about': [r['artifact']]})
        if r['fitness']['status'] == 'failing': clauses.append({'kind': 'scenario', 'text': f"{r['id']}: fitness function failing", 'about': [r['artifact']]})
    clauses.extend(acceptance_clauses(model, acceptance, requirements, decisions))
    clauses.extend(token_clauses(tokens, min_text_size))
    clauses.extend(eval_clauses(model, evals, ledger, time.time() * 1000 if now is None else now))
    return {'ready': not clauses, 'clauses': clauses}


def scoped_gate(g, model, elements, requirement, decisions):
    """The gate as one work item sees it (Core.scopedGate): model-wide clauses always count, a decision clause
    when the decision binds an in-scope element, a requirement clause when it is the item's requirement, any
    other clause when `about` names one. A clause that names nothing counts."""
    scope = set(elements)
    for e in model.elements.values():
        if e.name in scope: scope.add(model.label(e.id))
    def touches(names): return any(n in scope for n in names)
    keep = []
    for c in g['clauses']:
        k = c['kind']
        if k in ('parse', 'registry', 'duplicate'): ok = True
        elif k == 'requirement': ok = c.get('requirement') == requirement
        elif c.get('decision') is not None:
            d = next((x for x in decisions if x['id'] == c['decision']), None)
            ok = d is None or touches(d.get('binds') or [])
        else: ok = touches(c['about']) if c.get('about') else True
        if ok: keep.append(c)
    return {'ready': not keep, 'clauses': keep, 'scoped': True, 'outside': len(g['clauses']) - len(keep)}


# ---------- agent evals (Core.evalReport, Core.evalClauses) ----------
_AGE = re.compile(r'^(\d+)\s*([mhd])$', re.I | re.A)
_AGE_MS = {'m': 60000, 'h': 3600000, 'd': 86400000}


def eval_hash(e):
    return hash16(str((e or {}).get('_text') or '').replace('\r\n', '\n'))


def _inside_registry(p):
    return not re.match(r'^([A-Za-z]:|[\\/])', p) and '..' not in re.split(r'[\\/]', p)


def _blank(v): return not isinstance(v, str) or not v.strip()


def eval_problems(e):
    out = []
    missing = [k for k in ('agent', 'command', 'results') if _blank(e.get(k))]
    if missing: out.append(f"needs {', '.join(missing)}")
    lst = e.get('thresholds') if isinstance(e.get('thresholds'), list) else []
    if not lst: out.append('needs thresholds')
    else:
        bad = next((t for t in map(parse_threshold, lst) if 'error' in t), None)
        if bad: out.append(bad['error'])
    if e.get('maxAge') is not None and not _AGE.match(_s(e['maxAge'])): out.append(f"maxAge \"{_s(e['maxAge'])}\" is not like 30m, 12h or 7d")
    if isinstance(e.get('results'), str) and e['results'].strip() and not _inside_registry(e['results']): out.append('results must be a path inside the registry')
    return out


def eval_report(model, evals, ledger, now):
    by_id = {}
    for e in evals:
        if isinstance(e, dict) and e.get('id') is not None: by_id.setdefault(_s(e['id']), e)
    rows = []
    for el in model.elements.values():
        autonomy = get(el, 'd.agent.autonomy')
        if not autonomy: continue
        eval_id = get(el, 'd.agent.eval')
        row = {'agent': el.name, 'agentId': el.id, 'autonomy': autonomy, 'evalId': eval_id}

        def done(status, reason):
            row.update(status=status, reason=reason, blocking=autonomy != 'suggest' and status != 'passing')
            rows.append(row)
        if not eval_id: done('missing', 'd.agent.eval names no eval'); continue
        d = by_id.get(_s(eval_id))
        if not d: done('missing', f'eval {_s(eval_id)} is not in evals/'); continue
        row['evalHash'] = eval_hash(d)
        if eval_problems(d): row['defInvalid'] = True; done('invalid', f'eval {_s(eval_id)} is invalid'); continue
        if d.get('agent') != el.name: done('invalid', f"eval {_s(eval_id)} is for \"{d.get('agent')}\", not {el.name}"); continue
        mine = sorted((e for e in ledger if e.get('kind') == 'eval' and e.get('eval') == _s(d['id'])), key=lambda e: -(e.get('_ts') or 0))
        current = [e for e in mine if e.get('eval_hash') == row['evalHash']]
        latest = current[0] if current else None
        eid = _s(eval_id)
        if not mine: done('unchecked', f'eval {eid} has no result recorded yet')
        elif not latest: done('stale', f'eval {eid}: the last result was run under a different version of the eval file')
        elif latest.get('fingerprint') != fingerprint(model, el.id)['hash']: done('stale', f'eval {eid}: the agent changed since the last result')
        elif d.get('maxAge') is not None and now - (latest.get('_ts') or 0) > _age_ms(d['maxAge']): done('stale', f"eval {eid}: the last result is older than {_s(d['maxAge'])}")
        elif latest.get('outcome') != 'pass': done('failing', f"eval {eid} failed: {latest.get('reason') or 'a threshold was not met'}")
        else: done('passing', '')
    return rows


def _age_ms(v):
    m = _AGE.match(_s(v))
    return int(m.group(1)) * _AGE_MS[m.group(2).lower()]


def eval_clauses(model, evals, ledger, now):
    clauses, said, seen = [], set(), set()
    names = {e.name for e in model.elements.values()}
    for e in evals:
        if not isinstance(e, dict): continue
        if e.get('id') in seen and e.get('id') not in said:
            said.add(e.get('id')); clauses.append({'kind': 'duplicate', 'text': f"duplicate id {_s(e.get('id'))}"})
        seen.add(e.get('id'))
        problems = eval_problems(e)
        if problems: clauses.append({'kind': 'eval', 'text': f"eval {_s(e.get('id'))} is invalid: {'; '.join(problems)}"})
        if isinstance(e.get('agent'), str) and e['agent'].strip() and e['agent'] not in names:
            clauses.append({'kind': 'eval', 'text': f"eval {_s(e.get('id'))}: agent \"{e['agent']}\" is not in the model", 'about': [e['agent']]})
    for r in eval_report(model, evals, ledger, now):
        if not r['blocking'] or r.get('defInvalid'): continue
        clauses.append({'kind': 'eval', 'text': f"{r['agent']} ({r['autonomy']}) needs a passing eval: {r['reason']}", 'about': [r['agent']]})
    return clauses
