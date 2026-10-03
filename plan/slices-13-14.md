# Slices 13 and 14: gate trail, verify-ledger, scoped deployment views

Planned 2026-10-03 from two /grill-me sessions. Status: **interface awaiting sign-off** (see "Decisions needed before step 1").

## Goal

**Slice 13.** Leave a deterministic, append-only record of what the definition-of-ready gate said at each meaningful moment, and check that record's integrity, so the red-to-green history of a design (and, later, lint findings at the time of an escape) can be read back.

**Slice 14.** Let the Deployment tab show one declared deployment view (a software system scoped to an environment), with other systems' instances faded into a shared-infrastructure note and blast radius split by system.

Success looks like:
- `designc check` records a `gate` event on a local run (skipped when unchanged, never in CI unless asked).
- A post-commit hook records one for every commit, agent or human.
- The app's freeze refuses on uncommitted gate inputs and writes `gate` then `handover`.
- `designc verify-ledger` and the Improve view's "Ledger integrity" section report V1 to V7 identically.
- The Deployment tab offers a picker over declared views.

## Agreed design (summary)

| Topic | Decision |
| --- | --- |
| Shape | One `gate` event per recording (snapshot), no `finding` kind yet |
| Fields | `source, revision, commit?, dirty?, ready, verdict, clauses[{kind,text}], findings[{code,sev,on,loc,unknown,suppressed}]`; no lines, msg, hint, related |
| `revision` | `r-<hash8>` of the model text, the same string as the handover's |
| `verdict` | Two-pass FNV-1a (as `Core.fingerprint`) over canonical JSON of `{ready, clauses, findings}` |
| Skip-unchanged | Skip when the last `gate` event with the same `source` has the same `revision`, `commit` and `verdict` |
| `by` / `source` | `--by` → `DESIGNC_BY` → OS user; `--source` → `pipeline` if CI detected → `local` |
| Stream | `ledger/checks.jsonl` |
| Who records | `designc check` (default on locally, off in CI, `--record/--no-record`); a post-commit hook (README snippet); the app after its own Source control commit; the app's freeze. App recompiles never record |
| Python append | `python/designc/ledger.py`; invariant becomes "one validated append path per runtime" |
| CLI git | Read-only `rev-parse HEAD` and `status --porcelain`, fixed args, `-c core.hooksPath=/dev/null`; fields omitted on failure |
| Freeze | Human action in the app only (no CLI freeze). Refuses when gate inputs (`model/ decisions/ requirements/ scenarios/ behaviour/ vocabulary/ designc.json`, not `ledger/`) are uncommitted; non-git registry allowed with `commit: null`. Records `gate` then `handover` (`handover` gains `commit?`, `dirty?`) |
| verify-ledger | V1 handover preceded by a green gate at the same revision · V2 handover not dirty · V3 technical `decision_promoted` preceded by a passing `check` · V4 every line validates · V5 no repeated `event_id` with different content · V6 open `unapproved_change` listed (warning) · V7 handover folders/flat files ↔ `handover` events. V1/V2 apply only after the first `gate` event (earlier: warning). `sample: true` skipped. In both the app (Improve) and the CLI, parity-tested |
| Deployment picker | Lists declared views (`key · scope · environment`) plus "All of <env>" per environment. Default: `designc.json` `deployment` read as a view key first, else an environment name. Last pick remembered per registry, user-level |
| Scoped display | Nodes with no in-scope instance hidden; other systems' instances in shown nodes collapsed to "+ N from <system>"; Links table keeps rels with at least one shown end; infrastructure nodes shown when inside a shown node or linked to a shown instance |
| Scoped blast radius | Whole environment, result grouped "this view" vs "also affected (other systems)" |
| Scope validation | `*` or a declared `softwareSystem`, else a parse error with a line; mirrored in `python/designc/dsl.py` |

Out of scope: a CLI freeze; a `finding` kind (waits for P counterexamples); CI or pipeline changes; `designc hooks install`; drawing per declared view beyond the scope filter; federation into a BU-wide estate workspace (future direction, noted).

## Module impact

| Module | Change | Centrality |
| --- | --- | --- |
| `renderer/ledger.js` | `gate` kind, `handover` optional fields, `Ledger.gateUnchanged`, `Ledger.verify` | **High** (ledger-store, app, agent + tests) |
| `renderer/core.js` | `modelRevision`, `verdictHash`, `gateRecord`, `dirtyInputs`, `GATE_INPUTS`; deployment scope validation, `deploymentScope`, `deploymentView` view-key resolution, `bySystem` | **High** (Python parity) |
| `renderer/app.js` | `freezeHandover` hardening and recording; Improve "Ledger integrity"; Deployment picker, fading, grouped impact | **High** (agent.js shares scope) |
| `renderer/gitview.js` | Record a `gate` event after a successful commit | Low |
| `ledger-store.js` | None (picks up the new kind from `ledger.js`) | — |
| `python/designc/` | New `ledger.py`, `record.py`, `verify.py`, generated `ledger_schema.json`; `cli.py` gains `--record/--no-record/--by/--source` and `verify-ledger`; `dsl.py` scope validation | Parity-bound |
| Tests | `ledger.schema`, `ledger-guard` (scan `python/`), `designc-cli` (parity: event, verdict, verify, scope errors), new `gate-record`, `ledger-verify`, `deployment-scope` | — |
| Docs | AGENTS.md (gate kind, invariants: per-runtime append path, freezing is human, CLI-only precedent removed), README (hook snippet, `check --record`, `verify-ledger`, picker), ARCHITECTURE.md (Last updated, centrality counts), factory plan (divergences) | — |

No change to `main.js` or `preload.js` if decision 2 below is "localStorage". No IPC change.

## Interface changes

### JS: `renderer/core.js` (pure)

```js
Core.GATE_INPUTS                     // ['model/', 'decisions/', 'requirements/', 'scenarios/', 'behaviour/', 'vocabulary/', 'designc.json']
Core.modelRevision(text)             // 'r-' + hash8, shared with handoverPlan (refactor, no behaviour change)
Core.verdictHash({ready, clauses, findings})  // 16 hex
Core.gateRecord({modelText, diags, gate, source, git})
  // -> {kind:'gate', source, revision, commit?, dirty?, ready, verdict, clauses, findings}
  // git: {commit, dirty} | null
Core.dirtyInputs(statusFiles)        // paths of uncommitted gate inputs (ledger/ excluded)
Core.deploymentView(model, wanted)   // now {env, view|null}; view key resolved before environment name
Core.deploymentScope(model, envName, scope)
  // -> {env: filtered copy, shared: {nodePath: [{system, count}]}, rels: filtered env.rels}
Core.bySystem(model, entries)        // [{system, entries}] for grouping blast-radius results
```

### JS: `renderer/ledger.js`

```js
STREAM.gate = 'checks.jsonl'
FINAL_KIND_FIELDS.gate = { required: ['source','revision','ready','verdict','clauses','findings'], optional: ['commit','dirty'], enums: {source: ['local','pipeline']} }
FINAL_KIND_FIELDS.handover.optional = ['commit', 'dirty']
Ledger.gateUnchanged(events, ev)     // true when the last same-source gate event matches revision+commit+verdict
Ledger.verify(events, {handovers})   // -> {errors:[{rule, msg, event_id?}], warnings:[...], skipped: n}
                                      // events are raw parsed lines (pre-dedupe) so V4/V5 can see them
```

### Python: `python/designc/`

```python
ledger.validate(event) -> [errors]            # from ledger_schema.json
ledger.append_event(root, event, now=, uuid=) -> {'ok', 'event'|'errors'}
ledger.gate_unchanged(events, ev) -> bool
record.model_revision(text), record.verdict_hash(v), record.gate_record(...), record.git_state(root) -> {'commit','dirty'}|None
verify.verify(events, handovers) -> {'errors','warnings','skipped'}
```

CLI:
```
designc check [registry] [--json] [--record | --no-record] [--by NAME] [--source local|pipeline]
designc verify-ledger [registry] [--json]      # exit 0 clean, 1 errors, 2 unreadable
```

## Decisions needed before step 1

1. **How Python gets the full ledger schema (V4 parity).** Python today validates only the kinds the gate reads. V4 needs every kind.
   **Recommended:** the schema tables in `ledger.js` stay the source; a test-time script writes `python/designc/ledger_schema.json` (checked in), and `ledger.schema.test.js` fails if it is stale. One source of truth, and Python reads JSON. Alternative: hand-mirror `FINAL_KIND_FIELDS` in Python.
2. **Where the picker's last choice is stored.** Agreed "state.json, user level"; that needs a new IPC pair in `main.js` and `preload.js` (both high-centrality).
   **Recommended:** renderer `localStorage` keyed by registry path. It also lives in the user data folder, is per user and never in the repo, and needs no IPC change.
3. **Freeze in a git repo that isn't trusted yet.** The app can only see dirty state through trusted git.
   **Recommended:** freeze asks for trust (same `ensureTrusted` dialog) and refuses if declined, with "Freezing needs to check for uncommitted changes. Trust this folder to continue."

## Test strategy

Testable units are the pure interfaces above, required from Node and run from Python.
1. **Parity:** the same registry gives byte-identical `gate` events (minus envelope), the same verdict hash, the same `verify` output and the same scope parse errors in JS and Python (`designc-cli.test.js`).
2. **Skip-unchanged and recording:** a second `check` on the same state writes nothing; a change to a decision that flips the verdict writes; `CI=true` writes nothing; `--record` overrides.
3. **verify-ledger:** one failing fixture per rule V1 to V7, plus cutoff (handover before the first gate event is a warning) and sample skipping.
4. **Deployment:** `deploymentScope` on a three-system environment (hidden node, shared note counts, infrastructure node rules, filtered links); `bySystem` grouping; view-key-first resolution.

No mocks needed: git state is passed in as data (`git` argument, `statusFiles`). The only git-calling code is `record.git_state`, tested against a temporary repo like `test/git.test.js`. UI steps are verified with the headless snapshot harness on a copy of `sample-registry`.

Most important failure case: freeze with an uncommitted `decisions/*.yaml` refuses and writes nothing (no files, no events).

## Step sequence

TDD per step: failing test → minimal code → refactor. **⚠** marks steps touching more than one module.

**Slice 13a: the `gate` event, recorded from the CLI**
1. `ledger.js`: `gate` kind and `handover` optional fields. Test: `ledger.schema.test.js` accepts a valid gate event, rejects a missing `verdict` and an unknown `source`.
2. `core.js`: `modelRevision` (extracted from `handoverPlan`, handover tests unchanged), `verdictHash`, `gateRecord`. Test: new `gate-record.test.js` on the sample registry (no lines, labels as `on`, hash stable under reformatting).
3. `ledger.js`: `gateUnchanged`. Test: same source/revision/commit/verdict → true; a different source or commit → false.
4. ⚠ Python: generated `ledger_schema.json` + staleness test; `ledger.py` (`validate`, `append_event`, `gate_unchanged`); `record.py`. Test: `designc-cli.test.js` checks that a Python-built event equals JS `Core.gateRecord` for the same registry and passes JS `Ledger.validate`. `ledger-guard.test.js` scans `python/` for raw ledger writes outside `ledger.py`.
5. Python CLI: `check --record/--no-record/--by/--source`, CI detection (`CI`, `TF_BUILD`, `GITLAB_CI`, `GITHUB_ACTIONS`), `record.git_state`, output lines. Test: on a temp copy, the first run writes one line, the second writes none, `CI=true` writes none, `--source pipeline` labels correctly; temp git repo for `commit`/`dirty`.
6. Docs: README (`check` recording, post-commit hook snippet including the registry-in-a-larger-repo form), AGENTS.md (gate kind row, per-runtime append-path invariant).

**Slice 13b: freeze hardening and app recording**
7. `core.js`: `GATE_INPUTS`, `dirtyInputs`. Test: `ledger/` changes ignored, `decisions/x.yaml` reported, renamed and untracked files counted.
8. ⚠ `app.js` `freezeHandover`: trust (decision 3), refuse on `dirtyInputs`, record `gate` (via `gateUnchanged`) then `handover` with `commit`/`dirty`. Headless test: dirty decision refuses and leaves no new files or events; clean freeze writes both events in order.
9. `gitview.js`: after a successful commit, record a `gate` event (fresh git status, `source: local`). Headless test: commit → one gate event with the new hash.
10. Docs: AGENTS.md invariant "Freezing a handover is a human action in the app"; freeze section updated.

**Slice 13c: verify-ledger**
11. `ledger.js`: `Ledger.verify`, rules V1 to V7, cutoff, sample skip. Test: new `ledger-verify.test.js`, one fixture per rule.
12. ⚠ Python: `verify.py` + `designc verify-ledger`. Test: `designc-cli.test.js` parity on the same fixtures, plus exit codes.
13. `app.js` Improve view: "Ledger integrity" section (errors, warnings, skipped count, all through `esc()`). Headless test on the sample registry copy (expect cutoff warnings only).

**Slice 14: scoped deployment views**
14. ⚠ `core.js` + `dsl.py`: scope validation errors. Test: `deployment-links.test.js` cases + a `designc-cli.test.js` parity case.
15. `core.js`: `deploymentView` view-key-first (returning `{env, view}`; update the one app caller), `deploymentScope`. Test: new `deployment-scope.test.js` with a three-system environment.
16. `core.js`: `bySystem`. Test: blast radius on a shared node groups lost/down per system.
17. `app.js`: picker (shown only with ≥1 declared view or >1 environment), faded "+ N from <system>" lines, filtered Links table, grouped impact, remembered choice (decision 2). Headless test on a fixture with two systems in one environment.

**Close-out**
18. ARCHITECTURE.md (Last updated, centrality counts for `core.js`/`ledger.js`, new Python modules), factory plan divergences (gate carries findings; no CLI freeze; freeze is human), README picker section. Delete `.claude/current-plan-scope.json`. Write a session handoff.

Suggested commits: one per slice (13a, 13b, 13c, 14), each with `npm test` green.

## Risks

- **Biggest assumption:** canonical JSON is identical in JS and Python (key order, Unicode escaping, `→` in relationship labels, booleans). Step 2 and step 4 pin it with a parity test before anything records.
- **Most likely to blow up:** V4/V5 in Python, if schema generation (decision 1) turns out awkward for the conditional rules (for example "`exit_code` or `reason` required on fail"). Those rules are code, not table data. Mitigation: encode them as named rule ids in the JSON and implement each id once per runtime, parity-tested.
- **Skip-unchanged across branches:** after a union merge, "the last same-source gate event" is by `_ts`, so a branch merged later can make an unchanged state record once more. Harmless (one extra line), accepted.
- **Silent gaps:** if the hook's `designc` is missing, commits leave no trail and nothing says so. Accepted for now; README tells you how to check (`designc verify-ledger` doesn't detect this by design).
- **Behaviour change:** existing app users can no longer freeze from a dirty tree. Called out in the README and the commit message.
- **Sample registry:** its ledger has `handover` events and no `gate` events, so verify-ledger shows cutoff warnings there. Expected, and asserted in tests so the sample findings (2 errors, 4 warnings, 1 suppressed) stay as they are.
- **No data migration:** new kinds and optional fields only; old lines read unchanged.
