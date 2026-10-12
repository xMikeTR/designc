#!/usr/bin/env bash
# Claude Code Stop hook: an agent cannot finish its turn while designc's @critical
# end-to-end journeys (e2e/) fail. Skips when no app file changed since the last pass.
# Exit 2 blocks the stop and hands stderr to the agent. If the agent stops again with
# nothing changed since the failure, the stop is let through with a warning the person sees.
set -u
cd "${CLAUDE_PROJECT_DIR:-$(dirname "$0")/..}" || exit 0
input=$(cat)
again=$(printf '%s' "$input" | grep -q '"stop_hook_active": *true' && echo 1 || echo 0)

paths=(main.js preload.js paths.js acp.js git.js terminal.js llm-net.js ledger-store.js extract.js
       extract renderer e2e playwright.config.js package.json)
stamp() {
  { git rev-parse HEAD 2>/dev/null
    git diff HEAD -- "${paths[@]}" 2>/dev/null
    git ls-files --others --exclude-standard -- "${paths[@]}" 2>/dev/null | sort | while read -r f; do echo "$f"; cat "$f"; done
  } | sha256sum | cut -d' ' -f1
}
now=$(stamp)
pass_file=.claude/e2e-pass
fail_file=.claude/e2e-fail
[ -f "$pass_file" ] && [ "$(cat "$pass_file")" = "$now" ] && exit 0
if [ "$again" = 1 ] && [ -f "$fail_file" ] && [ "$(cat "$fail_file")" = "$now" ]; then
  echo '{"systemMessage": "designc e2e journeys are still failing and nothing changed since. Run npm run e2e to see them; do not trust a claim that the work is done."}'
  exit 0
fi

run=(npx playwright test --grep @critical --reporter=line)
command -v xvfb-run >/dev/null && [ "$(uname)" = Linux ] && run=(xvfb-run -a "${run[@]}")
out=$("${run[@]}" 2>&1); code=$?
if [ $code -eq 0 ]; then
  mkdir -p .claude && echo "$now" > "$pass_file" && rm -f "$fail_file"
  exit 0
fi
mkdir -p .claude && echo "$now" > "$fail_file"
{ echo "designc's @critical end-to-end journeys fail (npm run e2e). Fix the app, not the tests: never skip, delete or loosen them."
  printf '%s\n' "$out" | tail -n 40; } >&2
exit 2
