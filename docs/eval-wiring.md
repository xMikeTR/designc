# Wiring an eval suite into designc

This guide is for a coding agent. The goal: an agent in the design gets a passing eval that the ready gate trusts.

## What you produce

1. A small script that runs the real eval suite and writes a results file.
2. `evals/<id>.yaml` in the registry folder.
3. `d.agent.autonomy` and `d.agent.eval` on the agent's element in `model/workspace.dsl`.

Do not edit the ledger, `designc.json` or anything under `handovers/`. Do not write the pass or fail yourself: designc scores the results file against the thresholds.

## 1. The results file

Write JSON to a path inside the registry (no absolute path, no `..`), conventionally `evals/results/<id>.json`:

```json
{ "metrics": { "task_success": 0.91, "p95_latency_ms": 840 }, "cases": 40 }
```

`metrics` holds numbers only. `cases` is the number of cases scored. Schema: `docs/eval-results.schema.json`.

Map the suite's own output onto metrics. Pick a few that matter and keep their names stable, because the Improve view trends them by name. Rates are fractions (0.91, not 91). If the suite fails to run, exit non-zero and write no file: designc records a failure with the reason.

## 2. The eval definition

```yaml
id: EV-triage
agent: Triage agent              # exactly the element name in the model
command: python3 tools/run_evals.py evals/results/EV-triage.json
results: evals/results/EV-triage.json
thresholds:
  - task_success >= 0.85         # <metric> <op> <number>; ops are >= <= > < ==
  - p95_latency_ms <= 1200
maxAge: 7d                       # optional: 30m, 12h, 7d
```

`command` runs through the shell with the registry folder as its working directory, . In the app, secret-looking environment variables are removed unless listed in `designc.json` `inheritEnv`; `designc eval` passes its own environment through. Decide `maxAge` from how often the agent's behaviour can drift (model or prompt changes); leave it out if the fingerprint check is enough.

## 3. The model

```
agent = container "Triage agent" "Routes claims" "MAF agent" {
  properties {
    "d.agent.autonomy" "approve-writes"   # suggest | approve-writes | autonomous
    "d.agent.eval" "EV-triage"
  }
}
```

`suggest` agents never block the gate. The other two do, until the latest result for their eval passes and is current.

## 4. Check it

```
cd python
python3 -m designc eval /path/to/registry       # runs, scores, records
python3 -m designc check /path/to/registry      # the gate should no longer name the agent
```

`designc eval` exits 0 when all evals pass, 1 when any fails, 2 when the registry cannot be read. Add `--id EV-triage` for one eval and `--source pipeline` when running in CI (the default in CI).

## When a result goes stale

A recorded result stops counting when: the eval file changed, the agent's design (its properties or relationships) changed, or it is older than `maxAge`. The gate then says which. Run the eval again; do not loosen a threshold to make a failing result pass without a human deciding that.

## Try it

`fixtures/agent-registry/` is a worked registry, and `dev/mock-eval.js` is a scripted runner (`MOCK_EVAL_SCORE=0.5` fails it, `MOCK_EVAL_BROKEN=1` writes invalid JSON).
