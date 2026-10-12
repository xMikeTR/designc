"""Load a registry folder the way the desktop app does (loadSettings, loadRegistry, loadLedger)."""
import json
import os
import re

import yaml

from .gate import _s

REG_DIRS = ['decisions', 'requirements', 'proposals', 'handovers', 'scenarios', 'evals', 'acceptance']
ENVELOPE_OPTIONAL = {'system', 'session', 'task', 'element', 'payload'}

# Required fields and enums for the ledger kinds the gate reads (renderer/ledger.js FINAL_KIND_FIELDS).
GATE_KINDS = {
    'check': (['decision', 'check', 'outcome', 'source'], ['ms', 'exit_code', 'reason'], {'outcome': ['pass', 'fail'], 'source': ['local', 'pipeline']}),
    'fitness': (['scenario', 'check', 'outcome', 'source'], ['ms', 'exit_code', 'reason'], {'outcome': ['pass', 'fail'], 'source': ['local', 'pipeline']}),
    'eval': (['eval', 'agent', 'outcome', 'metrics', 'cases', 'source', 'fingerprint', 'eval_hash'], ['ms', 'exit_code', 'reason'], {'outcome': ['pass', 'fail'], 'source': ['local', 'pipeline']}),
    'needs_decision': (['id', 'question', 'status'], ['task', 'element'], {'status': ['open', 'resolved']}),
    'needs_decision_resolved': (['id'], [], {}),
}


class _Loader(yaml.SafeLoader):
    """js-yaml reads YAML 1.2: only true and false are booleans, so yes, no, on and off stay strings."""


_Loader.yaml_implicit_resolvers = {
    k: [(tag, rx) for tag, rx in v if tag != 'tag:yaml.org,2002:bool'] for k, v in yaml.SafeLoader.yaml_implicit_resolvers.items()
}
_Loader.add_implicit_resolver('tag:yaml.org,2002:bool', re.compile(r'^(?:true|True|TRUE|false|False|FALSE)$'), list('tTfF'))


def load_settings(root):
    cfg = {'model': 'model/workspace.dsl', 'chainHops': 4}
    try:
        with open(os.path.join(root, 'designc.json'), encoding='utf-8') as f: cfg.update(json.load(f))
    except FileNotFoundError: pass
    return cfg


def _list(root, d, exts):
    try: names = sorted(os.listdir(os.path.join(root, d)))
    except OSError: return []
    out = []
    for n in names:
        if not any(n.endswith(x) for x in exts): continue
        try:
            with open(os.path.join(root, d, n), encoding='utf-8') as f: out.append((f'{d}/{n}', f.read()))
        except OSError: pass
    return out


def load_yaml_dir(root, d, errors, keep_text=False):
    out = []
    for path, text in _list(root, d, ['.yaml', '.yml']):
        try:
            o = yaml.load(text, _Loader) or {}
            if not isinstance(o, dict): raise ValueError('expected a mapping at the top level')
            for k in ('binds', 'resolves', 'checks', 'elements'):
                if o.get(k) is not None and not isinstance(o[k], list): o[k] = [o[k]]
            o['id'] = o.get('id') or re.sub(r'\.ya?ml$', '', path.split('/')[-1])
            o['id'] = _s(o['id'])
            o['_path'] = path
            if keep_text: o['_text'] = text
            out.append(o)
        except (yaml.YAMLError, ValueError) as e:
            errors.append({'path': path, 'msg': str(e).split('\n')[0]})
    return sorted(out, key=lambda x: _collate(x['id']))


def _collate(s):
    return (s.casefold(), s.swapcase())


def read_tokens(root):
    """design-tokens/tokens.json as text, or None when the registry has none."""
    try:
        with open(os.path.join(root, 'design-tokens', 'tokens.json'), encoding='utf-8') as f: return f.read()
    except OSError:
        return None


def load_registry(root):
    errors = []
    decisions, requirements, _, _, scenarios, evals, acceptance = (load_yaml_dir(root, d, errors, d == 'evals') for d in REG_DIRS)
    hv = os.path.join(root, 'handovers')
    if os.path.isdir(hv):
        for n in sorted(os.listdir(hv)):
            if os.path.isdir(os.path.join(hv, n)): load_yaml_dir(root, f'handovers/{n}', errors)
    for d in decisions:
        d['status'] = d.get('status') or 'minted'
        d['effect'] = d.get('effect') or 'fix'
    return {'decisions': decisions, 'requirements': requirements, 'scenarios': scenarios, 'evals': evals, 'acceptance': acceptance, 'tokens': read_tokens(root), 'errors': errors}


def load_handover_evals(root):
    """{handover id: {eval id: eval_hash}} from each handover.yaml that records the evals it froze."""
    errors, found = [], []
    hv = os.path.join(root, 'handovers')
    if os.path.isdir(hv):
        for n in sorted(os.listdir(hv)):
            if os.path.isdir(os.path.join(hv, n)): found += load_yaml_dir(root, f'handovers/{n}', errors)
    return {h['id']: {str(k): v for k, v in h['evals'].items()} for h in found if isinstance(h.get('evals'), dict)}


def load_handover_ids(root):
    """Ids of the handovers on disk: handovers/<id>/handover.yaml folders beside the older flat files."""
    errors = []
    found = load_yaml_dir(root, 'handovers', errors)
    hv = os.path.join(root, 'handovers')
    if os.path.isdir(hv):
        for n in sorted(os.listdir(hv)):
            if os.path.isdir(os.path.join(hv, n)): found += load_yaml_dir(root, f'handovers/{n}', errors)
    return [h['id'] for h in found]


def _is_num(v): return isinstance(v, (int, float)) and not isinstance(v, bool)


def _eval_types_ok(ev):
    return (all(isinstance(ev[k], str) for k in ('eval', 'agent', 'fingerprint', 'eval_hash'))
            and isinstance(ev['metrics'], dict) and _is_num(ev['cases']))


def _valid(ev):
    """Ledger.validate for the kinds the gate reads; other kinds do not affect the gate and pass through."""
    if not isinstance(ev.get('by'), str) or not ev['by']: return False
    if ev.get('ts') is not None and not _is_num(ev['ts']): return False
    if any(k.startswith('_') for k in ev) or ev.get('envelope_version') is not None: return False
    if 'payload' in ev and ev['payload'] is not None and not isinstance(ev['payload'], dict): return False
    spec = GATE_KINDS.get(ev.get('kind'))
    if not spec: return True
    required, optional, enums = spec
    known = {'schema_version', 'event_id', 'ts', 'kind', 'by', *ENVELOPE_OPTIONAL, *required, *optional}
    if any(k not in known for k in ev): return False
    if any(r not in ev for r in required): return False
    if any(f in ev and ev[f] not in vals for f, vals in enums.items()): return False
    if ev['kind'] == 'eval' and not _eval_types_ok(ev): return False
    if ev['kind'] in ('check', 'fitness', 'eval') and ev.get('outcome') == 'fail' and 'exit_code' not in ev and not ev.get('reason'): return False
    return True


def parse_ledger(text, path):
    base = path.split('/')[-1]
    events = []
    for i, raw in enumerate(text.split('\n')):
        if not raw.strip(): continue
        try: obj = json.loads(raw)
        except ValueError: continue
        if not isinstance(obj, dict): continue
        if 'schema_version' in obj and 'envelope_version' in obj: continue
        if 'envelope_version' in obj: continue  # harness_v1 kinds are not read by the gate
        if 'schema_version' not in obj:
            events.append({**obj, 'schema_version': 1, 'event_id': f'legacy:{base}:{i + 1}', '_ts': obj['ts'] if _is_num(obj.get('ts')) else 0})
            continue
        if obj['schema_version'] != 1 or not _valid(obj): continue
        events.append({**obj, '_ts': obj['ts'] if _is_num(obj.get('ts')) else 0})
    return events


def load_ledger(root):
    raw = []
    for path, text in _list(root, 'ledger', ['.jsonl']): raw += parse_ledger(text, path)
    seen, ordered = set(), []
    for e in raw:
        if e['event_id'] in seen: continue
        seen.add(e['event_id']); ordered.append(e)
    ordered.sort(key=lambda e: e['_ts'])
    resolved = {e['id'] for e in ordered if e.get('kind') == 'needs_decision_resolved'}
    out = []
    for e in ordered:
        if e.get('kind') in ('escape_classified', 'needs_decision_resolved'): continue
        out.append({**e, 'status': 'resolved'} if e.get('kind') == 'needs_decision' and e.get('id') in resolved else e)
    return out
