# Shared by the selfcheck acceptance tests. Each test makes a throwaway git repo that holds a copy of the script,
# and swaps the stage commands through the SELFCHECK_CMD_* seam so no npm run is needed.
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../scripts" && pwd)

fail() { echo "FAIL: $*" >&2; exit 1; }

# fixture_repo <dir>: a repo with one commit; `flag` holds "ok".
fixture_repo() {
  mkdir -p "$1/scripts" && cp "$SCRIPT_DIR/selfcheck.sh" "$1/scripts/"
  git -C "$1" init -q && git -C "$1" config user.email t@t && git -C "$1" config user.name t
  echo ok > "$1/flag"; git -C "$1" add -A && git -C "$1" commit -qm base
}

# Stage commands for the fixture: each passes while `flag` says ok and `broken-<stage>` does not exist.
use_fixture_stages() {
  export SELFCHECK_CMD_TESTS='grep -q ok flag && test ! -e broken-tests'
  export SELFCHECK_CMD_PARITY_OF_RULES='grep -q ok flag && test ! -e broken-parity-of-rules'
}

# json <file> <python expr over d>
json() { python3 -c "import json,sys; d=json.load(open('$1')); print($2)"; }

# No selfcheck worktree may outlive a run (AC-7 in the spec, cheap to hold from slice 1).
no_leftovers() { [ -z "$(git -C "$1" worktree list | grep -v "^$1 ")" ] || fail "a worktree was left behind in $1"; }

# Container tests need the engine and the runner image; without them they report SKIP (exit 0), never a false pass.
ENGINE="${DESIGNC_CONTAINER_ENGINE:-podman}"; IMAGE="${DESIGNC_RUNNER_IMAGE:-designc-runner:latest}"
need_container() {
  command -v "$ENGINE" >/dev/null && "$ENGINE" image inspect "$IMAGE" >/dev/null 2>&1 || { echo "SKIP $1: no '$ENGINE' or no image $IMAGE"; exit 0; }
}
no_containers() { [ -z "$("$ENGINE" ps -aq --filter name=selfcheck-)" ] || fail "a selfcheck container was left behind"; }

