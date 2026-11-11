#!/usr/bin/env bash
# AC-3: with a committed failing check, the run exits 1, the record names the stage, and later stages still ran.
. "$(dirname "$0")/lib.sh"
d=$(mktemp -d); trap 'rm -rf "$d"' EXIT
fixture_repo "$d"; use_fixture_stages
touch "$d/broken-tests"; git -C "$d" add -A; git -C "$d" commit -qm "break tests"
cd "$d" && bash scripts/selfcheck.sh --local > out.json 2> err.txt; rc=$?
[ $rc -eq 1 ] || fail "expected exit 1, got $rc"
[ "$(json out.json "d['outcome']")" = fail ] || fail "record outcome is not fail"
[ "$(json out.json "[s['name'] for s in d['stages'] if s['outcome']=='fail']")" = "['tests']" ] || fail "record does not name tests as the failed stage"
[ "$(json out.json "[s['outcome'] for s in d['stages'] if s['name']=='parity-of-rules']")" = "['pass']" ] || fail "parity-of-rules did not run after the failure"
no_leftovers "$d"
echo "ok AC-3"
