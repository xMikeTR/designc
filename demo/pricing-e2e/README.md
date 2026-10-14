# End-to-end showcase: designc (S1) to factory-s2 (S2)

One slice of the Pricing sample, start to finish: **HRE-1234 / D-0001, Quote writes use optimistic
concurrency on Quotes DB.** A person binds the decision and freezes a handover in designc; factory-s2
plans, builds, verifies and reviews it in a dry-run PR; designc then shows the result.

Principle on show: agents propose, deterministic checks and people decide. Binding and freezing are
human actions in the app; the build never merges to main.

## What is here

| Path | What |
| --- | --- |
| `registry/` | Design registry: model, requirement HRE-1234, D-0001 (`minted`), P model `behaviour/quotes-writes.p` and its `Quotes.pproj`. No ledger, no handovers. |
| `codebase/` | The Pricing sample (`Pricing.Data` and its test), no concurrency token yet. |
| `run.sh` | Stages. Works in a scratch copy (`WORK`, default `/tmp/designc-e2e`); this folder is never changed. |

## Needs

Node 20+, Python 3 with PyYAML, .NET SDK (9 is fine; `DOTNET_ROLL_FORWARD=Major` is set for the P tool),
`p` on PATH, Docker with the `factory-s2-runner` image, and for `build` an `ANTHROPIC_API_KEY`
(paid; you supply it). `S2_DIR` points at `factory-s2-workbook` (default `~/Desktop/Coding/System2/factory-s2-workbook`).

## Steps

```
./run.sh prepare   # scratch copy; the codebase becomes a git repo on main
./run.sh check     # gate is not ready: "D-0001 is minted, not bound"
./run.sh app       # human step, see below
export ANTHROPIC_API_KEY=...   # yours, never committed
./run.sh build     # factory-s2 run, dry-run PR under codebase/.factory/runs/<id>/
./run.sh inspect   # S2 digest and metrics, designc verify-ledger and work
```

**Human step in the app** (Design view): run D-0001's check (it compiles `Quotes.pproj` and runs
`tcOptimistic`; about 10 seconds), press Bind on D-0001, then Freeze handover. The gate turns ready and
`handovers/<id>/` appears with `handover.yaml`, `elements.json`, the decision, requirement, model and P model.

Then `build`. With one provider the reviewer is the same model family, so the script sets
`FACTORY_REVIEWER_SAME_FAMILY=allow`; that is only valid for dry-run merges, never `--github`.

## What to look at afterwards

- Open the scratch registry in designc: Build (agent runs and ledger events), Work, Improve (escapes, rule health).
- `codebase/.factory/runs/<id>/`: plan, per-task results, the PR body, review.
- The design never changed during the build. If the codebase drifts from `d.code`, designc shows it on the Code map.

## Verified without the key

`prepare`, `check`, and a headless bind + freeze on the demo registry (check passes, handover with
`elements.json` written). Not verified here: `build` (needs your key) and the Docker sandbox.
