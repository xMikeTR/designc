# Session handoff (2026-10-03)

## State
- Slices 13 to 21 are done and committed. `node --test test/*.test.js` passes 377 of 377. No plan scope file is open.
- The user will try designc on real work and report back; they will wire their own eval suite (slice 15) there.

## Built since slice 14
- 15 agent evals as a gate; 16 timing and retry lint (DC007, DC008); 17 handover cost forecast.
- 18 `d.agent.pattern` / `d.agent.patternWhy`, rule AG011 (canvas rule, not in Python).
- 19 scenario `importance` / `difficulty`, `Core.utilityTree`, grouped Scenarios section.
- 20 decision `assumptions` with `review_by`; overdue blocks the gate (mirrored in `gate.py`); Mark reviewed (human only); Analyst rubric.
- 21 agent topology view (`Core.agentTopology`, `special:topology`).
- Review of 15 to 21 found and fixed: DC008 path explosion, numeric eval ids, same-name forecast merge, sample events in spend, assumption text slicing (code points, to match Python), dangling topology edges, AG011 and topology disagreeing on what an agent is.

## Out of scope, not started
- Go and F# extraction (the user said to ignore it for now).
- Wiring a real eval suite and trying the new UI on a real registry: the user does these in their own work.
- The `finding` ledger kind and `designc hooks install`.

## Notes
- Test command: `node --test test/*.test.js`. Afterwards run `git checkout -- fixtures/fullstack/ledger/checks.jsonl sample-registry/ledger/checks.jsonl`.
- Canvas property changes need `node test/helpers/canvas-specs.js --write`.
