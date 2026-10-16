# What a coding pipeline may write to the ledger

This guide is for whoever builds a pipeline (any coding agent, in-house or not) that consumes a frozen handover and reports back. The feedback is optional. designc behaves the same with no pipeline writes: the design, lint, decisions, freeze and gate work from the registry alone, and the Build view shows "No pipeline events yet".

The machine contract is `python/designc/ledger_schema.json` (generated from `renderer/ledger.js`; `designc verify` checks a ledger against it). This page says what each kind means to designc and who may write it.

## What the handover holds

A frozen handover (`handovers/<id>/`, listed and hashed in `handover.yaml`) is everything the pipeline needs: `elements.json` (`docs/handover-elements.schema.json`), the model, requirements, bound decisions, `evals/*.yaml`, `behaviour/*.p`, `vocabulary/*.yaml`, and `scenarios/*.yaml` with their ids under `scenarios:`. A scenario's `fitness:` entries may be `TODO ...`: the architect has stated what done means but the fitness function is not written yet, so writing it is part of the build. Verify each file's hash before use; a file changed after the freeze is not the handover.

## Kinds a pipeline writes

Append one JSON object per line to `ledger/pipeline.jsonl` (or, for `check` and `handover_closed`, their usual stream: `checks.jsonl`, `designc.jsonl`). Every line carries `schema_version`, `by` and `kind`; `event_id` and `ts` are stamped if missing.

| Kind | Required | What designc does with it |
| --- | --- | --- |
| `run_started` | `run`, `handover` | Build view, Runs: the run is shown as running from now, with the latest status of each `task` row for that handover written after it |
| `run_ended` | `run`, `handover`, `status`; `reason` unless `succeeded` | Ends the run in Runs. `status` is `succeeded`, `failed`, `parked` (stopped for a person) or `cancelled`; map your own outcomes onto these and put the detail in `reason`. A `parked` run is listed in the Work digest under Needs a decision, with its `reason`, until the run starts again or ends another way, so say in `reason` what the person must do. Write it on every exit path you can, a crash included: a run with no end stays "running" |
| `task` | `task`, `status` | Build view: tasks, reruns, tokens; spend history for the cost forecast (see `docs/cost-forecast-contract.md`) |
| `check` | `decision`, `check`, `outcome`, `source` | Latest result per decision check; `source: "pipeline"` marks it as the pipeline's own run |
| `needs_decision` | `id`, `question`, `status` | Listed under "Waiting on a decision"; an **open** one blocks the ready gate until a person resolves it in designc. Optional `payload.options` (`[{id, summary, consequence?}]`) and `payload.recommended` (one of the option ids) are shown with a Choose button each |
| `asbuilt_edge` | `from`, `to` | Drift: a dependency the code has that the model does not declare (DC100) |
| `escape` | `id`, `description` | A defect that got past the design; a person classifies it later |
| `false_positive` | `code` | A lint finding the pipeline judged wrong; counts against the rule |
| `handover_closed` | `handover`, `outcome` | Ends spend counting for that handover (`delivered` or `abandoned`) |
| `item_gate` | `item`, `gate`, `outcome`, `source`, `commit` (`dirty` false) | Evidence for a work item's `gate` entry in `done_when`. Counts only when `outcome` is pass, the tree was clean, and `commit` is the commit the item is declared done at |

`ledger verify` rule V9: `pipeline.jsonl` may hold only these kinds. Other files are not judged, so a pipeline kind may also sit in its home stream.

## Live progress

Write `run_started` when a run begins and `task` rows (with `handover`) as each task changes status, not only at the end, so a person watching Build sees the run move. `run` is your own id for the attempt; a retry of the same handover is a new `run`. A run that stopped for a person (`parked`) and carries on under the same `run` writes `run_started` again: a start after the end reopens the run, and the latest `run_ended` wins. designc reads only these lines and never looks inside the pipeline's own files.

A `task` row that carries `run` is a running total: its `tokens`, `tokens_in`, `tokens_out` and `cost` are what the task has spent in that run so far, and only the latest row per handover, task and run counts toward spend (Build's actuals and the cost forecast). Rows from different runs of the same handover add up. A `task` row with no `run` counts as written, so a pipeline that leaves out `run` must write each task's spend once.

A `task` row may also carry `usage`, the same running total split by model: `[{model, tier?, turns, tokens_in, tokens_out, cost?, cache_read?, cache_write?}]`, one entry per model the task used. `model` is a non-empty string; `turns`, `tokens_in` and `tokens_out` are whole numbers of at least 0; `cache_read` and `cache_write`, whole numbers too, are the part of `tokens_in` read from or written to a prompt cache (so together at most `tokens_in`; report `tokens_in` as all input, cached or not), and Build shows reads, writes and uncached input separately; `tier` is your own word for the model's class (for example `frontier`), shown only. Build's Runs shows each task's split and each run's total per tier (else per model). The row's own `tokens_in`, `tokens_out` and `cost` stay the task's totals and are what spend counts.

## Item scope

A work item names the elements it changes (`in_scope`). A pipeline works only those elements. Before touching any other element, ask: write a `needs_decision` with `element` set to the element and wait for a person. A change outside the item's elements that was not asked about is an escape with origin `translation_error` (the origin field arrives with ROADMAP slice 33). designc flags an item that names an element its requirement does not list, and a requirement element no item covers, so scope is settled before work starts.

## Queue state a dispatcher may write

`item_awaiting_human {item, reason?}` says an item waits for a person (open until the item is pulled, gated or done again). `item_conflict_deferred {item, reason?, with?}` says a backlog item was held back for a conflict. `wip_limit_changed {limit}` sets the WIP limit shown in the digest. designc folds these into the Work view's Digest; it never schedules. The ledger is the queue's source of truth; Jira is a one-way mirror.

`item_budget {item, status, limit_tokens?, spent_tokens?, reason?}` reports an item's token budget; `status` is `within`, `exceeded` or `waiting`, and anything other than `within` needs both numbers (whole numbers, at least 0). The latest row per item wins. `exceeded` and `waiting` show under Waiting as "budget" until a `within` row or a later `item_pulled`; they never enter Needs you or Failed, so write `item_awaiting_human` as well when a person must act. designc never sets or enforces the limit.

`item_judge {item, judge, score, threshold, outcome, commit, judge_version?, rubric_hash?, trace_id?}` reports one judge score for an item. `judge` is the value of the item's `judge` done_when entry, `outcome` is `pass` or `fail`, and `commit` is a string or null. designc shows the latest score on that entry and marks it stale when `commit` differs from the commit the item was declared done at. A judge is a gradient: a fail never enters Failed and never decides Done.

## Item handover

A handover frozen for a work item carries `work_item`, `design_version` and `in_scope` in `handover.yaml`, and its `elements.json` uses schema `designc.handover.elements/2`: every element is present, those the item may change have `in_scope: true`. Treat the rest as context. Its `handover` ledger event carries `item`. A pipeline works the item's `in_scope` elements only (see Item scope).

## Elements are ids

Every element a pipeline names (`task.element`, `needs_decision.element`, `asbuilt_edge.from` and `to`) is an `id` from the handover's `elements.json` (`System/Container/Component`). designc resolves the id first, then falls back to a name or `d.aka` that exactly one element carries; an ambiguous or unknown reference is shown as written and never guessed. The cost forecast keys history the same way.

## Kinds only a person writes

These record a human judgement made in designc. A pipeline must not write them, and designc does not accept them as pipeline input: `needs_decision_resolved`, `escape_classified`, `decision_promoted`, `handover` (the freeze), `extraction`, `item_pulled`, `item_done` and `item_recheck` (a person starts and finishes a work item; an agent's claim that it is done is never evidence, and designc checks the commit is reachable from the main branch). The envelope cannot prove who wrote a line, so this is a rule for writers, enforced for `pipeline.jsonl` by V9.

A person's answer to a `needs_decision` is a `needs_decision_resolved` with `id` and any of: `payload.option` (the id of the option chosen), `payload.note` (free text for the agent that asked) and top-level `decision` (the id of the decision file that answers it). A pipeline resuming a parked run reads the latest one per `id`. With none of the three, the question was closed without an answer.

`caught_by` on an escape names a stage: `S1-lint`, `S1-p`, `S1-grill` (designc's own) or `pipeline` (anything downstream of the handover). It is set by a person with `escape_classified`.

## Telemetry

Runs reported through telemetry are priced and counted as pipeline runs unless their `system` tag is one of designc's own agents (`S1`, `S4`). Untagged runs are the pipeline's.

## Not in this contract

Spend limits and budgets belong to the pipeline. designc never sets or enforces them; it only shows what `item_budget` reports.

## Acceptance criteria

A handover holds `acceptance/<id>.yaml` copies (listed as `acceptance:` in `handover.yaml`) for the criteria it touches. Each names an element by its `elements.json` id, the states it covers and a case per state. They are written by a person; a pipeline reads them and never edits them.

Specs are generated at freeze under `tests/acceptance/<element>/<id>.spec.ts` and are never edited by the coding agent: `elements.json` (item handover, schema /2) names the paths in `reserved`, and designc's DC009 refuses a `d.code` that may claim them. `loop_specs` in `handover.yaml` lists the specs the agent's loop runs; the full suite runs at merge. A pipeline records the acceptance result per criterion with the `commit` it ran at, and a new spec must fail on the base branch before it passes on the item's branch ("red on base"). Failures are reported with `ui_acceptance_failed` (`pipeline.jsonl`).

A handover also holds `design-tokens/tokens.json` when the registry has one (`tokens:` in `handover.yaml`). The build uses those tokens for sizes and colours, and runs Stylelint with them as its gate; designc itself only checks that no text size token is below `ux.minTextSize`. A criterion's `ux` block becomes tests in the generated spec: an axe scan, keyboard reachability, focus order and focus return through the declared locators, and no horizontal scroll at each declared breakpoint. The pipeline's test project provides `@axe-core/playwright`.

`ui_acceptance_failed {ac, element, task, commit, trace_id?}` (`pipeline.jsonl`) reports a failed acceptance spec. `task` is the work item id; designc shows it in the digest until that task passes a gate or is done.
