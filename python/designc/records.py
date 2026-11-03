"""Records (intelligence plane phase 2): one envelope for decisions, requirements and verdicts.
Mirrors renderer/records.js word for word (test/records.test.js compares them)."""
import re

from .rules import hash16

KINDS = ['decision', 'requirement', 'verdict', 'procedure']
PREFIXES = ['ui', 'req', 'el', 'test', 'jira']
STATUSES = ['proposed', 'bound', 'superseded', 'retired']
ALIASES = {'minted': 'proposed', 'checked': 'proposed'}
VERDICTS = ['matched', 'diverged', 'accepted']
GATE_KINDS = ['parse', 'registry', 'duplicate', 'finding', 'decision', 'evidence', 'check', 'promotion', 'assumption',
              'requirement', 'scenario', 'eval', 'needs', 'acceptance', 'tokens', 'domain', 'contracts']

_REF = re.compile(r'([a-z]+):(.+)')
_CHECK_ID = re.compile(r'[A-Za-z0-9._-]+')
_MLANG = re.compile(r'mlang:.+')


def _list(v):
    return [] if v is None else v if isinstance(v, list) else [v]


def _str(v):
    return isinstance(v, str) and v.strip() != ''


def _js(v):
    """String(v) as JavaScript gives it for the scalars YAML yields."""
    if isinstance(v, bool): return 'true' if v else 'false'
    if isinstance(v, float) and v.is_integer(): return str(int(v))
    return str(v)


def check_run(c):
    if isinstance(c, dict): return c['run'] if isinstance(c.get('run'), str) else ''
    return '' if c is None else _js(c)


def check_id(run):
    return 'chk-' + hash16(str(run).strip())[:8]


def checks(rec):
    out = []
    for c in _list((rec or {}).get('checks')):
        run = check_run(c)
        cid = c['id'] if isinstance(c, dict) and _str(c.get('id')) else check_id(run)
        out.append({'id': cid, 'run': run})
    return out


def runs(rec):
    return [check_run(c) for c in _list((rec or {}).get('checks'))]


def status(s):
    return ALIASES.get(s, s) if isinstance(s, str) else s


def parse_ref(s):
    if not isinstance(s, str): return None
    m = _REF.fullmatch(s)
    return {'prefix': m.group(1), 'key': m.group(2)} if m and m.group(1) in PREFIXES else None


def validate(kind, rec):
    errs = []
    if kind not in KINDS: return [f"kind: must be one of {'|'.join(KINDS)}"]
    if not isinstance(rec, dict): return ['record: must be a mapping']
    if not _str(rec.get('id')): errs.append('id: required')
    elif re.search(r'\s', rec['id']): errs.append('id: must have no spaces')
    st = rec.get('status')
    if st is None and kind != 'requirement': errs.append('status: required')
    elif st is not None and status(st) not in STATUSES:
        errs.append(f"status: must be one of {'|'.join(STATUSES)} (minted and checked read as proposed)")
    for f in ('scope', 'supersedes', 'evidence'):
        if rec.get(f) is None: continue
        if not all(_str(x) for x in _list(rec[f])): errs.append(f'{f}: must be a string or a list of strings')
    for s in _list(rec.get('scope')):
        if _str(s) and ':' in s and not parse_ref(s):
            errs.append(f"scope: {s} has an unknown prefix; use {' '.join(p + ':' for p in PREFIXES)}")
    if rec.get('source') is not None and not isinstance(rec['source'], str): errs.append('source: must be a string')
    if kind == 'decision':
        if not _str(rec.get('statement')): errs.append('statement: required')
        if rec.get('rationale') is not None and not isinstance(rec['rationale'], str): errs.append('rationale: must be a string')
        for i, c in enumerate(_list(rec.get('checks'))):
            if isinstance(c, dict):
                if not _str(c.get('run')): errs.append(f'checks[{i}]: run must be a command')
                if c.get('id') is not None and not _CHECK_ID.fullmatch(_js(c['id'])):
                    errs.append(f'checks[{i}]: id must be letters, digits, ".", "_" or "-"')
                extra = [k for k in c if k not in ('id', 'run')]
                if extra: errs.append(f'checks[{i}]: unknown field {extra[0]}')
            elif not _str(c): errs.append(f'checks[{i}]: must be a command or {{id, run}}')
        for e in _list(rec.get('enforced_by')):
            if not _str(e): errs.append('enforced_by: must be a string or a list of strings'); continue
            ok = e[5:] in GATE_KINDS if e.startswith('gate:') else (e.startswith('chk-') or _MLANG.match(e) or _CHECK_ID.fullmatch(e))
            if not ok: errs.append(f'enforced_by: {e} is not a check id, gate:<clause kind> or mlang:<rule id>')
    if kind == 'requirement' and not _str(rec.get('title')): errs.append('title: required')
    if kind == 'verdict':
        if rec.get('verdict') not in VERDICTS: errs.append(f"verdict: must be one of {'|'.join(VERDICTS)}")
        if not _list(rec.get('scope')): errs.append('scope: a verdict names what it judges')
        if rec.get('commit') is not None and not isinstance(rec['commit'], str): errs.append('commit: must be a string')
    if kind == 'procedure':
        if _str(rec.get('id')) and not re.fullmatch(r'[A-Za-z0-9._-]+', rec['id']): errs.append('id: letters, digits, ".", "_" or "-" (a trace row names it verbatim beside prefixed ids such as prompt:)')
        if not _str(rec.get('title')): errs.append('title: required')
        v = rec.get('version')
        if not (_str(v) or (isinstance(v, int) and not isinstance(v, bool) and v >= 1)): errs.append('version: a whole number of at least 1, or a string')
        if not _list(rec.get('scope')): errs.append('scope: a procedure names what it applies to')
        steps = _list(rec.get('steps'))
        if not steps or not all(_str(x) for x in steps): errs.append('steps: a string or a list of strings')
    return errs


def lint(records, elements=None):
    out = []
    by_id = {}
    for r in records:
        rec = r.get('rec')
        if not isinstance(rec, dict) or not _str(rec.get('id')): continue
        if rec['id'] in by_id:
            out.append({'path': r.get('path'), 'id': rec['id'], 'sev': 'error', 'msg': f"{rec['id']} is repeated (also {by_id[rec['id']].get('path')})"})
        else: by_id[rec['id']] = r

    def dead(i):
        t = by_id.get(i)
        return bool(t) and status(t['rec'].get('status')) in ('superseded', 'retired')

    replaced = {s for r in records if isinstance(r.get('rec'), dict) for s in _list(r['rec'].get('supersedes'))}
    els = set(elements) if elements is not None else None
    for r in records:
        rec = r.get('rec')
        if not isinstance(rec, dict) or not _str(rec.get('id')): continue

        def add(sev, msg): out.append({'path': r.get('path'), 'id': rec['id'], 'sev': sev, 'msg': msg})
        for s in _list(rec.get('supersedes')):
            if s not in by_id: add('error', f'supersedes {s}, which is not a record')
        for s in _list(rec.get('relies_on')):
            if s not in by_id: add('error', f'relies on {s}, which is not a record')
            elif dead(s): add('warning', f"relies on {s}, which is {status(by_id[s]['rec'].get('status'))}")
        for s in _list(rec.get('scope')):
            if not isinstance(s, str): continue
            ref = parse_ref(s)
            if not ref:
                if ':' not in s:
                    if s not in by_id: add('error', f'scope names {s}, which is not a record')
                    elif dead(s): add('warning', f"scope names {s}, which is {status(by_id[s]['rec'].get('status'))}")
                continue
            if ref['prefix'] == 'req':
                t = by_id.get(ref['key'])
                if not t or t.get('kind') != 'requirement': add('error', f'scope names {s}, which is not a requirement')
                elif dead(ref['key']): add('warning', f"scope names {s}, which is {status(t['rec'].get('status'))}")
            if ref['prefix'] == 'el' and els is not None and ref['key'] not in els:
                add('error', f'scope names {s}, which is not an element of the model')
        if r.get('kind') == 'decision':
            ids = {c['id'] for c in checks(rec)}
            for e in _list(rec.get('enforced_by')):
                if isinstance(e, str) and e.startswith('chk-') and e not in ids: add('error', f'enforced by {e}, which is not one of its checks')
        if status(rec.get('status')) == 'superseded' and rec['id'] not in replaced:
            add('warning', f"{rec['id']} is superseded but no record supersedes it")
    return out


def inverse(records):
    inv = {}

    def at(i): return inv.setdefault(i, {'superseded_by': [], 'relied_on_by': [], 'scoped_by': []})
    for r in records:
        rec = r.get('rec')
        if not isinstance(rec, dict) or not _str(rec.get('id')): continue
        for s in _list(rec.get('supersedes')): at(s)['superseded_by'].append(rec['id'])
        for s in _list(rec.get('relies_on')): at(s)['relied_on_by'].append(rec['id'])
        for s in _list(rec.get('scope')):
            if isinstance(s, str): at(s)['scoped_by'].append(rec['id'])
    return inv
