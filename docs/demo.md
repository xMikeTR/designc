# Live demo: designc and factory-s2

About 15 minutes. No model, key or cost: everything shown is deterministic.
The point to land: **models propose; deterministic checks and people decide.**

## Before you start
```
scripts/demo-prep.sh          # scratch registry in /tmp/designc-demo, builds factory-s2
```
Two terminals: A in this repo (designc), B in `factory-s2-workbook`. Dark theme and a big font help the room.

## Run of show

| Min | Where | Do | Say |
| --- | --- | --- | --- |
| 0 | slides/none | Show the diagram in `docs/guide.html` ("The idea") | designc is where you design; factory-s2 builds from a frozen design. They share files and a ledger, not a server. |
| 2 | A | `npm start -- /tmp/designc-demo/registry` | A registry is a plain folder in git. |
| 3 | designc | Point at the status bar gate: not ready. Read the first clause marked *next* in the Design sidebar | The design is checked like code. The gate lists exactly what blocks a build. |
| 5 | designc | Open `model/workspace.dsl`; click a finding in Problems | Findings come from rules written after real incidents, same results in CI (`python -m designc check`). |
| 7 | designc | **Record decision** on a finding (leave it unbound). Optional, only if an agent is configured: **Ask the tutor** | An agent can propose, but it cannot bind a decision or freeze a handover. Only you can. |
| 9 | designc | Open **Build**: the needs-decision about duplicate handling | The pipeline asks a human through the ledger instead of guessing. |
| 10 | B | `dotnet run --project src/Factory.S2 -- validate --handover examples/pricing-v3/handover.json --plan examples/pricing-v3/plan.json` | The plan is checked deterministically before any agent runs. |
| 11 | B | Same command with `--plan /tmp/designc-demo/bad-plan.json` | A task writing outside its element's code areas is refused, with the reason. |
| 12 | B | `dotnet run --project src/Factory.S2 -- dispatch --handover examples/pricing-v3/handover.json --plan examples/pricing-v3/plan.json` | Tasks that don't touch the same files can run in parallel waves. |
| 13 | B | `... -- digest --registry /tmp/designc-demo/registry` | What needs you, what failed, what finished. Same ledger designc shows. |
| 14 | designc | **Improve** tab | Escapes are counted by the stage that should have caught them, so the loop improves. |
| 15 | any | Questions. Close with `docs/guide.html` ("The whole loop") | |

## What this demo does not show
A real `run` (planner, implementer, independent reviewer, merge) calls a paid model and needs a second model family for review. Describe it from `docs/guide.html` ("A real run"); don't run it live.

## If something goes wrong
- App won't start: `npm install`, Node 20 or later.
- factory-s2 slow on first run (about 15 s): that is the build; `demo-prep.sh` does it ahead of time.
- Reset: run `scripts/demo-prep.sh` again; it recreates the scratch folder.
