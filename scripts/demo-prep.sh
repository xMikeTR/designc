#!/usr/bin/env bash
# Prepares a scratch copy of the sample registry and a rejected plan for the live demo.
# Nothing here calls a model or the network. Usage: scripts/demo-prep.sh [factory-s2 folder]
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
s2="${1:-$HOME/Desktop/Coding/System2/factory-s2-workbook}"
out="${DEMO_DIR:-/tmp/designc-demo}"
rm -rf "$out"; mkdir -p "$out"
cp -r "$here/sample-registry" "$out/registry"
python3 - "$s2/examples/pricing-v3/plan.json" "$out/bad-plan.json" <<'PY'
import json, sys
p = json.load(open(sys.argv[1]))
p['tasks'][1]['writes'] = ['src/Quotes.Data/**']  # leaves its own element's code areas
json.dump(p, open(sys.argv[2], 'w'), indent=2)
PY
(cd "$s2" && dotnet build -v q src/Factory.S2 >/dev/null)
echo "Demo folder: $out"
echo "Designc:   cd $here && npm start -- $out/registry"
echo "factory-s2: cd $s2"
