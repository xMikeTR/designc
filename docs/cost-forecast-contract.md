# Recording spend so designc can forecast handovers

This guide is for whoever builds Build (the coding pipeline) or any other writer of `ledger/*.jsonl`. designc prices a handover from what past handovers cost, so the pipeline must record spend in a form it can read. designc never sets or enforces limits; budgets per agent and sub-agent belong to the pipeline.

## What to write

One `task` event per attempt, through the ledger append path, with these fields beyond the required `task` and `status`:

| Field | Meaning |
| --- | --- |
| `handover` | The id of the frozen handover being built (`20261003-ab12cd34`). Without it the spend is invisible to the forecast |
| `element` | The design element name the work was for, exactly as in the model. History is keyed by name |
| `tokens_in`, `tokens_out` | Tokens used (or `tokens` as one figure) |
| `cost` | Cost of the attempt in the project currency, as you recorded it. designc adds it up and does not convert or price tokens |

Write an event for every attempt, including failed ones and reruns: the forecast is meant to include what rework really costs.

## Currency

All `cost` values must be in one currency. Set it in `designc.json` as `"currency": "GBP"` (the default). designc only prints this label.

## Closing a handover

When the work is delivered or given up, append a `handover_closed` event with `handover` and `outcome` (`delivered` or `abandoned`). The human "Close as delivered" and "Abandon" buttons in Build write the same event. After it the actual is final: later `task` events for that handover are listed as "after close" and not counted.

## How the forecast reads this

- Changed elements are found by comparing the model being frozen with the newest handover's model; on the first handover everything counts as changed. Only containers and components are priced.
- Per element, designc totals the spend for each past handover and takes the last 10. With at least 3 handovers of history it uses the median as the expected figure and the nearest-rank p90 as the high end. With fewer it says "no basis" and leaves that element out of the total.
- Settings in `designc.json`: `"forecast": { "minSamples": 3, "window": 10 }`.
- The forecast is frozen into `handovers/<id>/handover.yaml` under `forecast:`, and Build compares it with the actual.
