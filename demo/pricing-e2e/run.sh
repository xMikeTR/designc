#!/usr/bin/env bash
# designc + factory-s2 end-to-end showcase: Pricing sample, one slice (HRE-1234 / D-0001 optimistic concurrency).
# Usage: ./run.sh prepare | check | app | build | inspect | all-but-human
# Everything happens in a scratch copy (default /tmp/designc-e2e); this folder is never modified.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
APP="$(cd "$HERE/../.." && pwd)"
S2_DIR="${S2_DIR:-$HOME/Desktop/Coding/System2/factory-s2-workbook}"
WORK="${WORK:-/tmp/designc-e2e}"
REG="$WORK/registry"; CODE="$WORK/codebase"
export DOTNET_ROLL_FORWARD="${DOTNET_ROLL_FORWARD:-Major}"   # p needs .NET 8; roll forward on a .NET 9 host
s2() { dotnet run --project "$S2_DIR/src/Factory.S2" -- "$@"; }

stage="${1:-}"
case "$stage" in
  prepare)
    rm -rf "$WORK"; mkdir -p "$WORK"
    cp -a "$HERE/registry" "$REG"; cp -a "$HERE/codebase" "$CODE"
    git -C "$CODE" init -q -b main
    git -C "$CODE" -c user.name=demo -c user.email=demo@example.invalid add -A
    git -C "$CODE" -c user.name=demo -c user.email=demo@example.invalid commit -qm "Pricing sample baseline"
    echo "Scratch copy ready in $WORK"
    ;;
  check)
    (cd "$APP/python" && python3 -m designc check "$REG") || true
    ;;
  app)
    echo "Human step. In the app: Design view, Bind D-0001 (runs its check), then Freeze handover."
    echo "A handover folder appears under $REG/handovers/."
    cd "$APP" && npx electron . "$REG"
    ;;
  build)
    [ -n "${ANTHROPIC_API_KEY:-}" ] || { echo "Set ANTHROPIC_API_KEY first (paid run)."; exit 1; }
    H="$(ls -d "$REG"/handovers/*/ 2>/dev/null | tail -1)"
    [ -n "$H" ] || { echo "No handover yet: run the app stage and freeze one."; exit 1; }
    export FACTORY_PROVIDER=anthropic FACTORY_REVIEWER_SAME_FAMILY=allow
    s2 run --handover "$H" --repo "$CODE" --registry "$REG" --base main
    ;;
  inspect)
    s2 digest --registry "$REG"
    s2 metrics --registry "$REG"
    (cd "$APP/python" && python3 -m designc verify-ledger "$REG") || true
    (cd "$APP/python" && python3 -m designc work "$REG") || true
    echo "Open $REG in designc and look at Work, Build and Improve."
    ;;
  *) sed -n 2,4p "$0"; exit 2 ;;
esac
