"""designc check <registry>: compile the model, run the gate, print findings and clauses.

Exit codes: 0 ready, 1 not ready, 2 the folder cannot be read."""
import argparse
import json
import os
import sys

from .dsl import parse
from .gate import gate
from .registry import load_ledger, load_registry, load_settings
from .rules import check


def report(root):
    cfg = load_settings(root)
    path = os.path.join(root, cfg.get('model') or 'model/workspace.dsl')
    try:
        with open(path, encoding='utf-8') as f: src = f.read()
    except OSError:
        raise SystemExit(f'designc: cannot read {cfg.get("model") or "model/workspace.dsl"} in {root}. Open a registry folder, or set "model" in designc.json.') from None
    model = parse(src)
    diags = check(model, cfg.get('chainHops') or 4)
    reg = load_registry(root)
    g = gate(model, diags, reg['decisions'], reg['requirements'], load_ledger(root), reg['errors'], cfg.get('evidenceHosts') or [], reg['scenarios'])
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
    args = ap.parse_args(argv)
    try: r = report(os.path.abspath(args.registry))
    except SystemExit as e:
        print(e, file=sys.stderr); return 2
    print(json.dumps(r, ensure_ascii=False, indent=2) if args.json else render(r))
    return 0 if r['gate']['ready'] else 1


def main_entry():
    sys.exit(main(sys.argv[1:]))
