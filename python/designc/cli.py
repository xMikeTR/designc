"""designc, the commands that still run in Python.

`check` and `eval` are shims: they run the Node core (scripts/designc-core.js) and pass stdout, stderr and the exit code
through (0 ready/passing, 1 not ready/failing, 2 cannot run, which includes no Node). The language is compiled only in
Node. What stays here does not compile the model: `record` (ledger append), `work` and `verify-ledger`."""
import argparse
import getpass
import json
import os
import subprocess
import sys
from shutil import which


def node_cli(args):
    """Run `designc-core <args>` and pass stdout, stderr and the exit code through. No Node, or no script: exit 2 (could not run)."""
    script = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'scripts', 'designc-core.js'))
    node = os.environ.get('DESIGNC_NODE') or which('node')
    if not node:
        print('designc: could not run: Node is not installed or not on PATH. designc check runs on the Node core (scripts/designc-core.js).', file=sys.stderr); return 2
    if not os.path.isfile(script):
        print(f'designc: could not run: {script} is missing. designc check runs on the Node core.', file=sys.stderr); return 2
    sys.stdout.flush(); sys.stderr.flush()
    try: return subprocess.run([node, script, *args]).returncode
    except OSError as e:
        print(f'designc: could not run {node}: {e}', file=sys.stderr); return 2


def main(argv):
    if argv and argv[0] in ('check', 'eval'): return node_cli(argv)  # a shim: the Node core compiles the model
    ap = argparse.ArgumentParser(prog='designc', description='designc: design compiler and definition-of-ready gate for a registry folder.')
    sub = ap.add_subparsers(dest='cmd', required=True)
    c = sub.add_parser('check', help='lint the model and run the gate')
    c.add_argument('registry', nargs='?', default='.', help='registry folder (default: current directory)')
    c.add_argument('--json', action='store_true', help='print the report as JSON')
    c.add_argument('--record', action='store_true', help='record a gate event even where CI is detected')
    c.add_argument('--no-record', action='store_true', help='never record a gate event')
    c.add_argument('--by', help='who ran this (default: DESIGNC_BY, then the OS user)')
    c.add_argument('--source', help='local or pipeline (default: pipeline when CI is detected, else local)')
    c.add_argument('--item', help='judge the gate for one work item (work/<id>.yaml): only clauses that touch its elements. Records nothing')
    v = sub.add_parser('verify-ledger', help='check the ledger trail: gates before handovers, checks before promotions, valid lines')
    v.add_argument('registry', nargs='?', default='.', help='registry folder (default: current directory)')
    v.add_argument('--json', action='store_true', help='print the result as JSON')
    e = sub.add_parser('eval', help='run the evals that agents name, score the results and record them in the ledger')
    e.add_argument('registry', nargs='?', default='.', help='registry folder (default: current directory)')
    e.add_argument('--id', help='run only this eval')
    e.add_argument('--source', help='local or pipeline (default: pipeline when CI is detected, else local)')
    e.add_argument('--by', help='who ran this (default: DESIGNC_BY, then the OS user)')
    r = sub.add_parser('record', help='append factory eval events (suite_run, grader, suite_run_finished) read as JSON lines from stdin')
    r.add_argument('registry', nargs='?', default='.', help='registry folder (default: current directory)')
    r.add_argument('--by', help='who recorded this, for events that name nobody (default: DESIGNC_BY, then the OS user)')
    r.add_argument('--json', action='store_true', help='print the result as JSON')
    w = sub.add_parser('work', help='list work items in work/: state, file problems and clashes with active items')
    w.add_argument('registry', nargs='?', default='.', help='registry folder (default: current directory)')
    w.add_argument('--json', action='store_true', help='print the result as JSON')
    args = ap.parse_args(argv)
    if args.cmd == 'work': return work_cmd(os.path.abspath(args.registry), args.json)
    if args.cmd == 'record': return record_cmd(os.path.abspath(args.registry), args.by, args.json)
    return verify_ledger(os.path.abspath(args.registry), args.json)


def record_cmd(root, by, as_json):
    """Exit codes: 0 every line recorded, 1 a line was refused and nothing was written, 2 the folder cannot be read."""
    if not os.path.isdir(root):
        print(f'designc: {root} is not a folder. Open a registry folder.', file=sys.stderr); return 2
    from . import factory  # imported here so check and eval need nothing but the standard library
    r = factory.record(root, sys.stdin.read(), who(by))
    if as_json: print(json.dumps(r, ensure_ascii=False, indent=2))
    elif r['ok']: print(f"recorded {r['recorded']} event{'' if r['recorded'] == 1 else 's'} in ledger/")
    else:
        for e in r['errors']: print(f"line {e['line']}: {e['msg']}", file=sys.stderr)
        print('designc: nothing was recorded. Fix the lines above and send the whole batch again.', file=sys.stderr)
    return 0 if r['ok'] else 1


def parity_scenarios(root, errors):
    """The ids in parity/scenarios/ (renderer/parityview.js loadParityScenarios). A file with no id is a problem, not
    named after its file: a scenario is recorded and judged by its id."""
    from .registry import yaml_load
    ids = []
    sdir = os.path.join(root, 'parity', 'scenarios')
    for n in sorted(os.listdir(sdir)) if os.path.isdir(sdir) else []:
        if not n.endswith(('.yaml', '.yml')): continue
        rel = f'parity/scenarios/{n}'
        try:
            with open(os.path.join(sdir, n), encoding='utf-8') as f: o = yaml_load(f.read())
        except Exception as e:  # unreadable or not YAML: named, never skipped
            errors.append({'path': rel, 'msg': str(e).split('\n')[0]}); continue
        if isinstance(o, dict) and isinstance(o.get('id'), str) and o['id'].strip(): ids.append(o['id'].strip())
        else: errors.append({'path': rel, 'msg': f'{rel} has no id; a parity scenario is recorded and judged by its id.'})
    return ids


def ui_screens(root):
    """The screens that have a spec: names of ui/specs/*.json."""
    d = os.path.join(root, 'ui', 'specs')
    return sorted(n[:-5] for n in os.listdir(d) if n.endswith('.json')) if os.path.isdir(d) else []


def feature_ids(root):
    """The feature ids: base names of features/*.yaml|yml (FM001 makes the id equal the file name)."""
    d = os.path.join(root, 'features')
    return sorted(n.rsplit('.', 1)[0] for n in os.listdir(d) if n.endswith(('.yaml', '.yml'))) if os.path.isdir(d) else []


def work_cmd(root, as_json):
    """Exit 0 when every work item file is sound, 1 when one has a problem, 2 when the folder cannot be read."""
    if not os.path.isdir(root):
        print(f'designc: {root} is not a folder. Open a registry folder.', file=sys.stderr); return 2
    from . import work
    from .registry import load_ledger, load_registry, load_yaml_dir, yaml_load
    errors = []
    items = load_yaml_dir(root, 'work', errors)
    reg = load_registry(root)
    r = work.report(items, reg['requirements'], load_ledger(root), errors, parity_scenarios(root, errors), ui_screens(root), feature_ids(root))
    if as_json: print(json.dumps(r, ensure_ascii=False, indent=2))
    else:
        for row in r['items']:
            print(f"{row['id']}  {row['state']}")
            for m in row['problems']: print(f'  error    {m}')
            for c in row['conflicts']: print(f"  conflict {c['with']}: {c['detail']}")
        for u in r['uncovered']: print(f"warning  requirement {u['requirement']} lists {u['element']} but no work item covers it. Add it to an item or make a new item.")
        for e in r['errors']: print(f"{e['path']}  error    {e['msg']}")
        n = sum(len(x['problems']) for x in r['items']) + len(r['errors'])
        print('No work items.' if not r['items'] and not r['errors'] else (f'{len(r["items"])} work item{"" if len(r["items"]) == 1 else "s"}' + (f', {n} problem{"" if n == 1 else "s"}.' if n else ', no problems.')))
    return 1 if any(x['problems'] for x in r['items']) or r['errors'] else 0


def verify_ledger(root, as_json):
    if not os.path.isdir(root):
        print(f'designc: {root} is not a folder. Open a registry folder.', file=sys.stderr); return 2
    from .registry import load_handover_evals, load_handover_ids, load_registry
    from .verify import read_ledger_files, verify
    reg = load_registry(root)
    r = verify(read_ledger_files(root), load_handover_ids(root), [{'id': d['id'], 'kind': d.get('kind'), 'effect': d.get('effect'), 'checks': d.get('checks')} for d in reg['decisions']], load_handover_evals(root))
    if as_json: print(json.dumps(r, ensure_ascii=False, indent=2))
    else:
        for x in r['errors']: print(f"{x['rule']}  error    {x['msg']}")
        for x in r['warnings']: print(f"{x['rule']}  warning  {x['msg']}")
        n, w = len(r['errors']), len(r['warnings'])
        print(('Ledger is consistent.' if not n else f'{n} error{"" if n == 1 else "s"} in the ledger.') + (f' {w} warning{"" if w == 1 else "s"}.' if w else '') + (f' {r["skipped"]} sample event{"" if r["skipped"] == 1 else "s"} skipped.' if r['skipped'] else ''))
    return 1 if r['errors'] else 0


def who(by):
    if by: return by
    if os.environ.get('DESIGNC_BY'): return os.environ['DESIGNC_BY']
    try: return getpass.getuser()
    except Exception: return 'unknown'


def main_entry():
    sys.exit(main(sys.argv[1:]))
