"""The Python ledger append path: validate against ledger_schema.json (generated from renderer/ledger.js),
stamp the designc_v1 envelope and append to the kind's stream file. One validated append path per runtime:
this module is the only code in python/ that writes ledger/*.jsonl."""
import json
import os
import time
import uuid

with open(os.path.join(os.path.dirname(__file__), 'ledger_schema.json'), encoding='utf-8') as _f:
    SCHEMA = json.load(_f)

_TYPE_NAMES = {'boolean': 'a boolean', 'string': 'a string', 'array': 'an array', 'object': 'an object', 'number': 'a number', 'string|null': 'a string or null'}


def _is_type(v, t):
    if t == 'null': return v is None
    if t == 'array': return isinstance(v, list)
    if t == 'boolean': return isinstance(v, bool)
    if t == 'string': return isinstance(v, str)
    if t == 'object': return isinstance(v, dict)
    if t == 'number': return _is_num(v)
    return False


def _is_num(v): return isinstance(v, (int, float)) and not isinstance(v, bool)


def _rule(rid, ev):
    """Conditional rules named in the schema; mirrored from RULES in renderer/ledger.js."""
    if rid == 'fail_needs_evidence':
        if ev.get('outcome') == 'fail' and 'exit_code' not in ev and not ev.get('reason'):
            return "exit_code: required when outcome is 'fail' (or give reason)"
    elif rid == 'budget_shape':
        for k in ('limit_tokens', 'spent_tokens'):
            if k in ev and not (_is_num(ev[k]) and float(ev[k]).is_integer() and ev[k] >= 0):
                return f'{k}: must be a whole number of at least 0'
        if 'status' in ev and ev['status'] != 'within':
            for k in ('limit_tokens', 'spent_tokens'):
                if k not in ev: return f"{k}: required when status is not 'within'"
    elif rid == 'usage_shape':
        if 'usage' not in ev: return None
        us = ev['usage']
        if not isinstance(us, list): return 'usage: must be a list of {model, turns, tokens_in, tokens_out}'
        for i, u in enumerate(us):
            at = f'usage[{i}]'
            if not isinstance(u, dict): return f'{at}: must be an object'
            if not isinstance(u.get('model'), str) or not u['model']: return f'{at}.model: must be a non-empty string'
            if 'tier' in u and not isinstance(u['tier'], str): return f'{at}.tier: must be a string'
            for k in ('turns', 'tokens_in', 'tokens_out'):
                v = u.get(k)
                if not (_is_num(v) and float(v).is_integer() and v >= 0): return f'{at}.{k}: must be a whole number of at least 0'
            if 'cost' in u and not _is_num(u['cost']): return f'{at}.cost: must be a number'
            for k in ('cache_read', 'cache_write'):
                v = u.get(k)
                if k in u and not (_is_num(v) and float(v).is_integer() and v >= 0): return f'{at}.{k}: must be a whole number of at least 0'
            if u.get('cache_read', 0) + u.get('cache_write', 0) > u['tokens_in']:
                return f'{at}: cache_read and cache_write are part of tokens_in, so together at most tokens_in'
    elif rid == 'by_role_shape':
        if 'by_role' not in ev: return None
        us = ev['by_role']
        if not isinstance(us, list): return 'by_role: must be a list of {role, turns, tokens_in, tokens_out}'
        for i, u in enumerate(us):
            at = f'by_role[{i}]'
            if not isinstance(u, dict): return f'{at}: must be an object'
            if not isinstance(u.get('role'), str) or not u['role']: return f'{at}.role: must be a non-empty string'
            for k in ('turns', 'tokens_in', 'tokens_out'):
                v = u.get(k)
                if not (_is_num(v) and float(v).is_integer() and v >= 0): return f'{at}.{k}: must be a whole number of at least 0'
            if 'cold' in u:
                c = u['cold']
                if not (_is_num(c) and float(c).is_integer() and c >= 0): return f'{at}.cold: must be a whole number of at least 0'
                if c > u['turns']: return f'{at}.cold: cannot be more than turns'
    elif rid == 'suite_run_shape':
        t = ev.get('trials')
        if 'trials' in ev and not (_is_num(t) and float(t).is_integer() and t >= 1): return 'trials: must be a whole number of at least 1'
        tasks = ev.get('tasks')
        if not isinstance(tasks, dict): return None
        if not tasks: return 'tasks: must name at least one eval task'
        names = lambda v: isinstance(v, list) and all(isinstance(x, str) and x for x in v)
        for tid, task in tasks.items():
            if not isinstance(task, dict) or not isinstance(task.get('hash'), str) or not task['hash']: return f'tasks.{tid}: needs a hash'
            if not names(task.get('gates')) or not task['gates']: return f'tasks.{tid}: needs at least one gate grader'
            if 'gradients' in task and not names(task['gradients']): return f'tasks.{tid}: gradients must be a list of grader names'
    elif rid == 'ended_needs_reason':
        if 'status' in ev and ev['status'] != 'succeeded' and not ev.get('reason'): return "reason: required when status is not 'succeeded'"
    elif rid == 'fail_needs_note':
        if ev.get('verdict') == 'fail' and isinstance(ev.get('note'), str) and not ev['note'].strip():
            return "note: say what went wrong when verdict is 'fail'"
    elif rid == 'aborted_needs_reason':
        if ev.get('outcome') == 'aborted' and not ev.get('reason'): return "reason: required when outcome is 'aborted'"
    elif rid == 'caught_by_member':
        v = ev.get('caught_by')
        if 'caught_by' in ev and v is not None and v not in SCHEMA['caught_by']:
            return f"caught_by: must be null or one of {'|'.join(SCHEMA['caught_by'])}"
    elif rid == 'origin_member':
        v = ev.get('origin')
        if 'origin' in ev and v is not None and v not in SCHEMA['origins']:
            return f"origin: must be null or one of {'|'.join(SCHEMA['origins'])}"
    return None


def validate(ev):
    """Same errors, in the same order, as Ledger.validate in renderer/ledger.js."""
    if not isinstance(ev, dict): return ['event must be an object']
    kind = ev.get('kind')
    spec = SCHEMA['kinds'].get(kind) if isinstance(kind, str) else None
    if not spec: return [f"kind: unknown kind '{kind}'"]
    errors = []
    if not isinstance(ev.get('by'), str) or not ev['by']: errors.append('by: required string')
    if 'schema_version' in ev and ev['schema_version'] != SCHEMA['schema_version']:
        errors.append(f"schema_version: must be {SCHEMA['schema_version']}, got {ev['schema_version']}")
    if 'envelope_version' in ev: errors.append('envelope_version: not allowed on a designc kind')
    if ev.get('ts') is not None and not _is_num(ev['ts']): errors.append('ts: must be a number (epoch ms)')
    for k in ev:
        if k.startswith('_'): errors.append(f"{k}: '_'-prefixed keys are reserved")
    if 'payload' in ev and not isinstance(ev['payload'], dict): errors.append('payload: must be an object')
    known = {'schema_version', 'event_id', 'ts', 'kind', 'by', *SCHEMA['envelope_optional'], *spec['required'], *spec['optional']}
    for k in ev:
        if k not in known and not k.startswith('_'): errors.append(f"{k}: unknown field for kind '{kind}' (put extra data under payload)")
    for r in spec['required']:
        if r not in ev: errors.append(f'{kind}.{r}: required')
    for f, vals in spec['enums'].items():
        if f in ev and ev[f] not in vals: errors.append(f"{kind}.{f}: must be one of {'|'.join(vals)}")
    for f, t in spec['types'].items():
        if f in ev and not any(_is_type(ev[f], x) for x in t.split('|')): errors.append(f'{kind}.{f}: must be {_TYPE_NAMES.get(t, t)}')
    for rid in spec['rules']:
        msg = _rule(rid, ev)
        if msg: errors.append(f'{kind}.{msg}')
    return errors


def append_event(root, event, now=None, new_id=None):
    """Validate, stamp and append. Returns {'ok': True, 'event': stamped} or {'ok': False, 'errors': [...]};
    writes nothing when invalid."""
    errors = validate(event)
    if errors: return {'ok': False, 'errors': errors}
    stamped = {**event, 'schema_version': SCHEMA['schema_version'],
               'event_id': event.get('event_id') or (new_id or (lambda: str(uuid.uuid4())))(),
               'ts': event['ts'] if event.get('ts') is not None else int((now or time.time)() * 1000)}
    path = os.path.join(root, 'ledger', SCHEMA['kinds'][event['kind']]['stream'])
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'a', encoding='utf-8') as f: f.write(json.dumps(stamped, ensure_ascii=False, separators=(',', ':')) + '\n')
    return {'ok': True, 'event': stamped}


def gate_unchanged(events, ev):
    """True when the latest gate event from the same source has the same revision, commit (absent equals
    null) and verdict. `events` carry `_ts`. Mirrors Ledger.gateUnchanged."""
    last = None
    for e in events:
        if e.get('kind') == 'gate' and e.get('source') == ev.get('source') and (last is None or (e.get('_ts') or 0) >= (last.get('_ts') or 0)): last = e
    return last is not None and last.get('revision') == ev.get('revision') and last.get('commit') == ev.get('commit') and last.get('verdict') == ev.get('verdict')
