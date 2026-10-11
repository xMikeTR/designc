"""Ledger integrity, rules V1 to V8. Mirrors Ledger.verify in renderer/ledger.js, message by message."""
import json
import os

from .ledger import SCHEMA, validate
from .gate import accept_without_check
from .record import canonical


def _is_num(v): return isinstance(v, (int, float)) and not isinstance(v, bool)


def _bare(r): return '' if r is None else (str(r)[2:] if str(r).startswith('r-') else str(r))


def verify(files, handovers=(), decisions=(), handover_evals=None):
    """files: [{'path', 'text'}]. Returns {'errors': [{rule, msg}], 'warnings': [...], 'skipped': n}."""
    errors, warnings = [], []
    def err(rule, msg): errors.append({'rule': rule, 'msg': msg})
    def warn(rule, msg): warnings.append({'rule': rule, 'msg': msg})
    first_seen, events = {}, []
    for f in sorted(files, key=lambda f: f['path']):
        name = f['path'].replace('\\', '/').split('/')[-1]
        for i, raw in enumerate((f.get('text') or '').split('\n')):
            if not raw.strip(): continue
            at = f'{name}:{i + 1}'
            try: obj = json.loads(raw)
            except ValueError: err('V4', f'{at} not valid JSON'); continue
            if not isinstance(obj, dict): err('V4', f'{at} not a JSON object'); continue
            if 'schema_version' in obj and 'envelope_version' in obj: err('V4', f'{at} both schema_version and envelope_version'); continue
            if 'envelope_version' in obj: continue
            if 'schema_version' not in obj: e = {**obj, 'event_id': f'legacy:{name}:{i + 1}'}
            else:
                if obj['schema_version'] != SCHEMA['schema_version']: err('V4', f"{at} unknown schema_version {obj['schema_version']}"); continue
                errs = validate(obj)
                if errs: err('V4', f"{at} {'; '.join(errs)}"); continue
                e = obj
                seen = first_seen.get(e['event_id'])
                if seen:
                    if seen['body'] != canonical(e) and not seen['reported']:
                        seen['reported'] = True; err('V5', f"event_id {e['event_id']} has different content at {seen['at']} and {at}")
                    continue
                first_seen[e['event_id']] = {'body': canonical(e), 'at': at, 'reported': False}
            events.append({**e, '_ts': e['ts'] if _is_num(e.get('ts')) else 0})
    events.sort(key=lambda e: e['_ts'])
    live = [e for e in events if not e.get('sample')]
    skipped = len(events) - len(live)
    gates = [e for e in live if e.get('kind') == 'gate']
    checks = [e for e in live if e.get('kind') == 'check']
    def latest(lst, pred, ts):
        c = [e for e in lst if pred(e) and e['_ts'] <= ts]
        return c[-1] if c else None
    first_gate = gates[0]['_ts'] if gates else None
    for h in (e for e in live if e.get('kind') == 'handover'):
        if h.get('dirty') is True: err('V2', f"handover {h.get('handover')} was frozen with uncommitted gate inputs")
        if first_gate is None or h['_ts'] < first_gate: warn('V1', f"handover {h.get('handover')} predates gate recording"); continue
        g = latest(gates, lambda x: _bare(x.get('revision')) == _bare(h.get('revision')), h['_ts'])
        if not g: err('V1', f"handover {h.get('handover')} has no gate event at revision {_bare(h.get('revision'))} before it")
        elif not g.get('ready'): err('V1', f"handover {h.get('handover')}: the latest gate event at revision {_bare(h.get('revision'))} before it was not ready")
    for p in (e for e in live if e.get('kind') == 'decision_promoted'):
        d = next((x for x in decisions if x.get('id') == p.get('decision')), None)
        if not d or d.get('kind') == 'business' or accept_without_check(d): continue
        c = latest(checks, lambda x: x.get('decision') == p.get('decision'), p['_ts'])
        if not c or c.get('outcome') != 'pass': err('V3', f"decision {p.get('decision')} was promoted without a passing check before it")
    for u in (e for e in live if e.get('kind') == 'unapproved_change'):
        warn('V6', f"unapproved change by {u.get('agent')} ({u.get('role')}) to {u.get('path')}")
    event_ids = []
    for e in live:
        if e.get('kind') == 'handover' and e.get('handover') not in event_ids: event_ids.append(e.get('handover'))
    for i in handovers:
        if i not in event_ids: err('V7', f'handover {i} has no handover event in the ledger')
    for i in event_ids:
        if i not in handovers: err('V7', f'handover event {i} has no handover in handovers/')
    last = next((e for e in reversed(live) if e.get('kind') == 'handover'), None)
    frozen = (handover_evals or {}).get(last.get('handover'), {}) if last else {}
    said = set()
    for e in (x for x in live if last and x.get('kind') == 'eval' and x.get('source') == 'pipeline' and x['_ts'] > last['_ts']):
        key = f"{e.get('eval')}:{e.get('eval_hash')}"
        if e.get('eval') in frozen and frozen[e['eval']] != e.get('eval_hash') and key not in said:
            said.add(key); err('V8', f"pipeline eval {e['eval']} ran under a different eval file than handover {last.get('handover')} froze")
    return {'errors': errors, 'warnings': warnings, 'skipped': skipped}


def read_ledger_files(root):
    out, d = [], os.path.join(root, 'ledger')
    try: names = sorted(os.listdir(d))
    except OSError: return out
    for n in names:
        if n.endswith('.jsonl'):
            with open(os.path.join(d, n), encoding='utf-8') as f: out.append({'path': f'ledger/{n}', 'text': f.read()})
    return out
