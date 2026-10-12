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
| `item_gate` | `item`, `gate`, `outcome`, `source`, `commit` (`dirty` false) | Evidence for a work item's `gate` entry in `done_when`. Counts only when `outcome` is pass, the tree was clean, and `commit` is the commit the item is declared done at |

`ledger verify` rule V9: `pipeline.jsonl` may hold only these kinds. Other files are not judged, so a pipeline kind may also sit in its home stream.

## Item scope

A work item names the elements it changes (`in_scope`). A pipeline works only those elements. Before touching any other element, ask: write a `needs_decision` with `element` set to the element and wait for a person. A change outside the item's elements that was not asked about is an escape with origin `translation_error` (the origin field arrives with ROADMAP slice 33). designc flags an item that names an element its requirement does not list, and a requirement element no item covers, so scope is settled before work starts.

## Queue state a dispatcher may write

`item_awaiting_human {item, reason?}` says an item waits for a person (open until the item is pulled, gated or done again). `item_conflict_deferred {item, reason?, with?}` says a backlog item was held back for a conflict. `wip_limit_changed {limit}` sets the WIP limit shown in the digest. designc folds these into the Work view's Digest; it never schedules. The ledger is the queue's source of truth; Jira is a one-way mirror.

## Item handover

A handover frozen for a work item carries `work_item`, `design_version` and `in_scope` in `handover.yaml`, and its `elements.json` uses schema `designc.handover.elements/2`: every element is present, those the item may change have `in_scope: true`. Treat the rest as context. Its `handover` ledger event carries `item`. A pipeline works the item's `in_scope` elements only (see Item scope).

## Elements are ids

Every element a pipeline names (`task.element`, `needs_decision.element`, `asbuilt_edge.from` and `to`) is an `id` from the handover's `elements.json` (`System/Container/Component`). designc resolves the id first, then falls back to a name or `d.aka` that exactly one element carries; an ambiguous or unknown reference is shown as written and never guessed. The cost forecast keys history the same way.

## Kinds only a person writes

These record a human judgement made in designc. A pipeline must not write them, and designc does not accept them as pipeline input: `needs_decision_resolved`, `escape_classified`, `decision_promoted`, `handover` (the freeze), `extraction`, `item_pulled`, `item_done` and `item_recheck` (a person starts and finishes a work item; an agent's claim that it is done is never evidence, and designc checks the commit is reachable from the main branch). The envelope cannot prove who wrote a line, so this is a rule for writers, enforced for `pipeline.jsonl` by V9.

`caught_by` on an escape names a stage: `S1-lint`, `S1-p`, `S1-grill` (designc's own) or `pipeline` (anything downstream of the handover). It is set by a person with `escape_classified`.

## Telemetry

Runs reported through telemetry are priced and counted as pipeline runs unless their `system` tag is one of designc's own agents (`S1`, `S4`). Untagged runs are the pipeline's.

## Not in this contract

Spend limits and budgets belong to the pipeline. designc never sets or enforces them.

## Acceptance criteria

A handover holds `acceptance/<id>.yaml` copies (listed as `acceptance:` in `handover.yaml`) for the criteria it touches. Each names an element by its `elements.json` id, the states it covers and a case per state. They are written by a person; a pipeline reads them and never edits them.

Specs are generated at freeze under `tests/acceptance/<element>/<id>.spec.ts` and are never edited by the coding agent: `elements.json` (item handover, schema /2) names the paths in `reserved`, and designc's DC009 refuses a `d.code` that may claim them. `loop_specs` in `handover.yaml` lists the specs the agent's loop runs; the full suite runs at merge. A pipeline records the acceptance result per criterion with the `commit` it ran at, and a new spec must fail on the base branch before it passes on the item's branch ("red on base"). Failures are reported with `ui_acceptance_failed` (`pipeline.jsonl`).

A handover also holds `design-tokens/tokens.json` when the registry has one (`tokens:` in `handover.yaml`). The build uses those tokens for sizes and colours, and runs Stylelint with them as its gate; designc itself only checks that no text size token is below `ux.minTextSize`. A criterion's `ux` block becomes tests in the generated spec: an axe scan, keyboard reachability, focus order and focus return through the declared locators, and no horizontal scroll at each declared breakpoint. The pipeline's test project provides `@axe-core/playwright`.

`ui_acceptance_failed {ac, element, task, commit, trace_id?}` (`pipeline.jsonl`) reports a failed acceptance spec. `task` is the work item id; designc shows it in the digest until that task passes a gate or is done.
