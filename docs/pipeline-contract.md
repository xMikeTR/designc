# What a coding pipeline may write to the ledger

This guide is for whoever builds a pipeline (any coding agent, in-house or not) that consumes a frozen handover and reports back. The feedback is optional. designc behaves the same with no pipeline writes: the design, lint, decisions, freeze and gate work from the registry alone, and the Build view shows "No pipeline events yet".

The machine contract is `python/designc/ledger_schema.json` (generated from `renderer/ledger.js`; `designc verify` checks a ledger against it). This page says what each kind means to designc and who may write it.

## What the handover holds

A frozen handover (`handovers/<id>/`, listed and hashed in `handover.yaml`) is everything the pipeline needs: `elements.json` (`docs/handover-elements.schema.json`), the model, requirements, bound decisions, `evals/*.yaml`, `behaviour/*.p`, `vocabulary/*.yaml`, and `scenarios/*.yaml` with their ids under `scenarios:`. A scenario's `fitness:` entries may be `TODO ...`: the architect has stated what done means but the fitness function is not written yet, so writing it is part of the build. Verify each file's hash before use; a file changed after the freeze is not the handover.

## Kinds a pipeline writes

Append one JSON object per line to `ledger/pipeline.jsonl` (or, for `check` and `handover_closed`, their usual stream: `checks.jsonl`, `designc.jsonl`). Every line carries `schema_version`, `by` and `kind`; `event_id` and `ts` are stamped if missing.

| Kind | Required | What designc does with it |
| --- | --- | --- |
| `task` | `task`, `status` | Build view: tasks, reruns, tokens; spend history for the cost forecast (see `docs/cost-forecast-contract.md`) |
| `check` | `decision`, `check`, `outcome`, `source` | Latest result per decision check; `source: "pipeline"` marks it as the pipeline's own run |
| `needs_decision` | `id`, `question`, `status` | Listed under "Waiting on a decision"; an **open** one blocks the ready gate until a person resolves it in designc |
| `asbuilt_edge` | `from`, `to` | Drift: a dependency the code has that the model does not declare (DC100) |
| `escape` | `id`, `description` | A defect that got past the design; a person classifies it later |
| `false_positive` | `code` | A lint finding the pipeline judged wrong; counts against the rule |
| `handover_closed` | `handover`, `outcome` | Ends spend counting for that handover (`delivered` or `abandoned`) |

`ledger verify` rule V9: `pipeline.jsonl` may hold only these kinds. Other files are not judged, so a pipeline kind may also sit in its home stream.

## Elements are ids

Every element a pipeline names (`task.element`, `needs_decision.element`, `asbuilt_edge.from` and `to`) is an `id` from the handover's `elements.json` (`System/Container/Component`). designc resolves the id first, then falls back to a name or `d.aka` that exactly one element carries; an ambiguous or unknown reference is shown as written and never guessed. The cost forecast keys history the same way.

## Kinds only a person writes

These record a human judgement made in designc. A pipeline must not write them, and designc does not accept them as pipeline input: `needs_decision_resolved`, `escape_classified`, `decision_promoted`, `handover` (the freeze), `extraction`. The envelope cannot prove who wrote a line, so this is a rule for writers, enforced for `pipeline.jsonl` by V9.

`caught_by` on an escape names a stage: `S1-lint`, `S1-p`, `S1-grill` (designc's own) or `pipeline` (anything downstream of the handover). It is set by a person with `escape_classified`.

## Telemetry

Runs reported through telemetry are priced and counted as pipeline runs unless their `system` tag is one of designc's own agents (`S1`, `S4`). Untagged runs are the pipeline's.

## Not in this contract

Spend limits and budgets belong to the pipeline. designc never sets or enforces them.
