# Pilot budget (set 2026-10-18, before any build)

designc never sets or enforces a spend limit (`docs/pipeline-contract.md`). This is the cap the person dispatching
the trial agrees to, and the pipeline is expected to stop at it and report `item_budget`.

Basis: about 200k input tokens per agent turn (first real run: 1.43M in over 8 turns).

| | Turns | Input tokens | Output tokens |
| --- | --- | --- | --- |
| Pilot expected (4 tasks, about 30 turns) | 30 | 6M | 0.3M |
| Pilot hard cap (stop and report) | 45 | 9M | 0.5M |
| Per task cap | 15 | 3M | 0.15M |

- S2 checks the item cap only when a new run starts: an item over its cap is refused (exit 4). A run in progress is not stopped by it; per-turn caps bound spend within a run.
- The pilot runs once. Nothing is re-run to chase a better result.
- The full trial's cap is not set here: it comes from what the pilot costs per turn and per passing task.

## Pilot status (2026-10-19): stopped at the credit limit

Only P1 was attempted, twice. No budget remains, so the pilot and the full trial are not being run.

| Attempt | Result | Task-row tokens (in / out) |
| --- | --- | --- |
| 1 | T-001 passed in 3 turns; the run failed at integration because the whole suite includes P2-P4's red tests (fixed by `integration.testCommand` in `.factory/policy.yaml`) | 80k / 12k |
| 2 | Credit balance too low after 6 turns; T-001 unfinished | 362k / 34k |

Findings that stand without the rest of the pilot:
- The same task cost 80k and 362k+ tokens across two runs. In attempt 2 the target is Node. S2's runner image already had Node 22 and an `npm ci` restore step, but its sandbox prompt still said the sandbox was .NET only, so the test author wrote a Jint harness in C# and looped on a refused `Directory.Build.props`. The stale prompt was the cause, now fixed in S2 (`prompts/sandbox.md`).
- Input tokens are cumulative per model call: every call resends the whole conversation, and agents re-read files they had already read. About 70% of input was cache reads.
- The task rows probably omit plan-stage tokens (not confirmed).
- Cost per task is therefore dominated by S2's stack and read behaviour, not by the fixture's size.

A full trial (8-12 tasks, 3 runs) is not affordable on a pay-as-you-go key. S2 has since changed: the sandbox prompt names Node, tool results are held while they fit 80k characters (fewer planner re-reads), and the planner's tokens are counted in the task rows. Revisit after one more small pilot run is affordable.
