"""designc check <registry>: compile the model, run the gate, print findings and clauses.

Exit codes: 0 ready, 1 not ready, 2 the folder cannot be read."""
import argparse
import getpass
import json
import os
import sys

from . import ledger, record
from .dsl import parse
from .gate import gate
from .registry import load_handover_ids, load_ledger, load_registry, load_settings
from .rules import check
from .verify import read_ledger_files, verify


def state(root):
    """Everything one check run computes: the parsed model, its text, diagnostics and the gate."""
    cfg = load_settings(root)
    path = os.path.join(root, cfg.get('model') or 'model/workspace.dsl')
    try:
        with open(path, encoding='utf-8') as f: src = f.read()
    except OSError:
        raise SystemExit(f'designc: cannot read {cfg.get("model") or "model/workspace.dsl"} in {root}. Open a registry folder, or set "model" in designc.json.') from None
    model = parse(src)
    diags = check(model, cfg.get('chainHops') or 4)
    reg = load_registry(root)
    g = gate(model, diags, reg['decisions'], reg['requirements'], load_ledger(root), reg['errors'], cfg.get('evidenceHosts') or [], reg['scenarios'], reg['evals'])
    return {'cfg': cfg, 'model': model, 'model_text': src, 'diags': diags, 'gate': g}


def report(root): return report_of(state(root))


def report_of(s):
    model, diags, g = s['model'], s['diags'], s['gate']
    return {
        'errors': model.errors,
        'findings': [{'code': d['code'], 'sev': d['sev'], 'msg': d['msg'], 'label': d['loc']['label'], 'line': d['loc']['line'],
                      'unknown': bool(d['unknown']), 'suppressed': d['suppressed'] or None} for d in diags],
        'gate': {'ready': g['ready'], 'clauses': [{'kind': c['kind'], 'text': c['text']} for c in g['clauses']]},
    }


def render(r):
    lines = []
    for e in r['errors']: lines.append(f"model:{e['line']}  error  {e['msg']}")
    for f in r['findings']:
        tag = 'suppressed' if f['suppressed'] else f['sev'] + (' (unknown)' if f['unknown'] else '')
        lines.append(f"{f['code']}  {tag:<18} {f['label']}: {f['msg']}")
    n = len(r['gate']['clauses'])
    lines.append('')
    lines.append('Ready for handover.' if r['gate']['ready'] else f'Not ready: {n} clause{"" if n == 1 else "s"} block the gate.')
    for c in r['gate']['clauses']: lines.append(f"  - {c['text']}")
    return '\n'.join(lines)


def main(argv):
    ap = argparse.ArgumentParser(prog='designc', description='designc: design compiler and definition-of-ready gate for a registry folder.')
    sub = ap.add_subparsers(dest='cmd', required=True)
    c = sub.add_parser('check', help='lint the model and run the gate')
    c.add_argument('registry', nargs='?', default='.', help='registry folder (default: current directory)')
    c.add_argument('--json', action='store_true', help='print the report as JSON')
    c.add_argument('--record', action='store_true', help='record a gate event even where CI is detected')
    c.add_argument('--no-record', action='store_true', help='never record a gate event')
    c.add_argument('--by', help='who ran this (default: DESIGNC_BY, then the OS user)')
    c.add_argument('--source', help='local or pipeline (default: pipeline when CI is detected, else local)')
    v = sub.add_parser('verify-ledger', help='check the ledger trail: gates before handovers, checks before promotions, valid lines')
    v.add_argument('registry', nargs='?', default='.', help='registry folder (default: current directory)')
    v.add_argument('--json', action='store_true', help='print the result as JSON')
    args = ap.parse_args(argv)
    if args.cmd == 'verify-ledger': return verify_ledger(os.path.abspath(args.registry), args.json)
    if args.record and args.no_record: return usage('--record and --no-record cannot be used together.')
    if args.source not in (None, 'local', 'pipeline'): return usage('--source must be local or pipeline.')
    root = os.path.abspath(args.registry)
    try: s = state(root)
    except SystemExit as e:
        print(e, file=sys.stderr); return 2
    r = report_of(s)
    note = sys.stderr if args.json else sys.stdout
    print(json.dumps(r, ensure_ascii=False, indent=2) if args.json else render(r))
    ci = in_ci()
    source = args.source or ('pipeline' if ci else 'local')
    if args.no_record: pass
    elif ci and not args.record: print('CI detected: not recording a gate event. Pass --record to record one.', file=note)
    else: record_gate(root, s, source, args.by, note)
    return 0 if r['gate']['ready'] else 1


def verify_ledger(root, as_json):
    if not os.path.isdir(root):
        print(f'designc: {root} is not a folder. Open a registry folder.', file=sys.stderr); return 2
    reg = load_registry(root)
    r = verify(read_ledger_files(root), load_handover_ids(root), [{'id': d['id'], 'kind': d.get('kind')} for d in reg['decisions']])
    if as_json: print(json.dumps(r, ensure_ascii=False, indent=2))
    else:
        for x in r['errors']: print(f"{x['rule']}  error    {x['msg']}")
        for x in r['warnings']: print(f"{x['rule']}  warning  {x['msg']}")
        n, w = len(r['errors']), len(r['warnings'])
        print(('Ledger is consistent.' if not n else f'{n} error{"" if n == 1 else "s"} in the ledger.') + (f' {w} warning{"" if w == 1 else "s"}.' if w else '') + (f' {r["skipped"]} sample event{"" if r["skipped"] == 1 else "s"} skipped.' if r['skipped'] else ''))
    return 1 if r['errors'] else 0


CI_VARS = ('CI', 'TF_BUILD', 'GITLAB_CI', 'GITHUB_ACTIONS')


def in_ci(): return any(os.environ.get(v) for v in CI_VARS)


def usage(msg):
    print(f'designc: {msg}', file=sys.stderr); return 2


def who(by):
    if by: return by
    if os.environ.get('DESIGNC_BY'): return os.environ['DESIGNC_BY']
    try: return getpass.getuser()
    except Exception: return 'unknown'


def record_gate(root, s, source, by, out):
    """Append one gate event unless the latest one from this source already says the same."""
    ev = record.gate_record(s['model_text'], s['diags'], s['gate'], source, record.git_state(root, s['cfg']))
    if ledger.gate_unchanged(load_ledger(root), ev):
        print('gate unchanged, not recorded', file=out); return
    res = ledger.append_event(root, {**ev, 'by': who(by)})
    if res['ok']: print('recorded gate event in ledger/', file=out)
    else: print('designc: could not record the gate event: ' + '; '.join(res['errors']), file=sys.stderr)


def main_entry():
    sys.exit(main(sys.argv[1:]))
