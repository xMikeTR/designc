# Pilot budget (set 2026-10-18, before any build)

designc never sets or enforces a spend limit (`docs/pipeline-contract.md`). This is the cap the person dispatching
the trial agrees to, and the pipeline is expected to stop at it and report `item_budget`.

Basis: about 200k input tokens per agent turn (first real run: 1.43M in over 8 turns).

| | Turns | Input tokens | Output tokens |
| --- | --- | --- | --- |
| Pilot expected (4 tasks, about 30 turns) | 30 | 6M | 0.3M |
| Pilot hard cap (stop and report) | 45 | 9M | 0.5M |
| Per task cap | 15 | 3M | 0.15M |

- A task that reaches its cap is reported `exceeded` and parked, not retried.
- The pilot runs once. Nothing is re-run to chase a better result.
- The full trial's cap is not set here: it comes from what the pilot costs per turn and per passing task.
