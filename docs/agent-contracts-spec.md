# Agent contracts: tech spec

Status: proposed. Stage 1 is built (designc commit `4b18f61`): `agents.json`, the `contracts` command, `result.json`, the sidebar section. This spec covers the rest: copying compiled contracts into a handover, S2 enforcing them, and the bridge to M.

Principle kept: probabilistic components propose; deterministic components and humans decide. A contract is deterministic input; a person freezes it; S2 refuses to run without it.

## The whole picture

```mermaid
flowchart LR
  M[model: agents with d.agent.*] -->|Core.handoverAgents| A[contracts/agents.json]
  A -->|designc.json contracts command| B[bridge script]
  B -->|.m files + mlang compile| O[contracts/out/*]
  B --> R[contracts/out/result.json]
  R --> S[Agent contracts section]
  O -->|Freeze, human| H[handovers/id/contracts/*]
  H -->|DesigncHandoverReader| S2[S2 run]
  S2 -->|AGT policy per agent| G[governed agent runtime]
```

## 1. Result contract v2 (additive)

`result.json` gains, all required for freeze (optional for display today):

| Field | Meaning |
| --- | --- |
| `agents_hash` | `hash16` of the exact `contracts/agents.json` text the command was given. Proves the output is for the current design |
| `compiler` | `{name, version}`, free text, shown and recorded |
| per agent `policy` | Registry-relative path of the AGT policy file for that agent (required when `compiled`) |
| per agent `files` | Every file belonging to the contract (policy, agis, sdk, invariants, jacket) |

Schema id becomes `designc.contracts.result/2`; `/1` stays readable (display only, never freezable).

## 2. Freeze copies the contracts (designc)

`freezeHandover` (human action, unchanged entry points) gains a step, only when `designc.json` `contracts` is set and the design has agents:

1. Read `contracts/out/result.json`. Refuse with a plain message if: missing, schema `/1`, `agents_hash` differs from `hash16` of a fresh `Core.handoverAgents` text (the design moved: "Compile contracts again"), any file listed is missing or outside `contracts/out/`.
2. Every agent must be `compiled`, except agents with `d.agent.autonomy "suggest"` (they may be `needs_input` or absent; recorded as `uncontracted`). `needs_input` or `failed` on any other agent refuses the freeze and names the reasons.
3. `Core.handoverPlan({contracts: [{path, text}], contractsResult})` copies each file verbatim to `contracts/<path-under-out>` in the handover and lists path and hash in `handover.yaml` like every frozen file. `handover.yaml` gets `contracts: {result: contracts/result.json, agents: {<agentId>: <policy path>}, uncontracted: [ids], compiler: {...}}`.
4. These files are inside the id hash. A different policy is a different handover; the same design recompiled by a changed compiler gives a new id, which is correct (different enforcement).
5. `agents.json` stays outside the id (derived from the model); `result.json` is inside (it is the compiler's claim about it).

Also: a gate clause of kind `contracts` (about the agent) when `contracts` is configured and a bound `approve-writes` or `autonomous` agent has no compiled contract for the current design. Non-blocking until the team opts in with `contracts.require: true` in `designc.json`. JS only: Python CLI does not cover it, like handover planning.

Tests: `handoverPlan` with and without contracts (id changes when a policy file changes; unchanged when `agents.json` alone differs), freeze refusals (stale hash, needs_input, missing file, path escape), example pinned like `handover-agents.example.json`.

e2e: one new journey, not `@critical`: sample registry + `dev/mock-contracts.js` (extended to emit v2) compile, freeze, handover lists `contracts/`.

## 3. S2 loads and enforces the policy

`DesigncHandoverReader` already verifies every listed file hash, so tampering after freeze is caught with no change. New:

1. Parse `contracts:` from `handover.yaml` into `Handover.Contracts : Map<agentElementId, ContractRef>` with the policy text. A manifest without `contracts:` yields an empty map (old handovers keep working).
2. Config `FACTORY_CONTRACTS = off | warn | require` (default `warn`; the wizard asks). `require`: S2 refuses to start a run, with a message naming the agent, when the handover's `elements.json`/`agents.json` lists an agent that has no compiled contract and is not `uncontracted` by design (`suggest`).
3. Enforcement point: wherever S2 invokes an agent role (implementer, reviewer, planner), the agent's AGT policy is loaded before the call and every tool call or file write the role attempts is checked against it. Deny wins; a denial is a ledger event (`policy_denied`, agent id, rule, policy hash), not an exception swallowed by the model. Policy hash is stamped on the run's Langfuse span.
4. Mapping S2 roles to design agents: S2's own roles are not elements in the design. The design's agents (things the built system contains) get contracts for the system under test; S2's roles are governed by a separate `policies/s2` set that already exists. Open question 1.
5. Ledger: S2 records the policy hash it ran under on `run_started` so Build in designc shows "ran under contract X".

Tests in S2: reader parses `contracts:`; `require` refuses a missing contract; a denied tool call stops the step and writes the event; old handover loads with `warn`.

## 4. The bridge script

Lives with M (`m-lang/tools/designc_bridge.py`), not in designc. It is the only thing that knows both formats. Interface is exactly the designc contract:

```
designc_bridge.py --agents <agents.json> --out <dir> [--overrides <dir>]
```

Steps:

1. Read `agents.json` (`designc.handover.agents/1`). Compute `agents_hash = hash16(file text)` with the same FNV-1a two-pass algorithm as `Core._shared.hash16` (spec and test vectors in `docs/handover-agents.example.json`'s neighbouring test), so both sides agree.
2. For each agent, load a hand-written `.m` from `--overrides/<slug>.m` if present. Otherwise generate a skeleton from the design:
   - `authority`: tools with `effect` reversible and `approval` none become `use`; irreversible tools without approval are not granted; tools with `approval` become `use ... with approval`.
   - `never`: derived from `d.agent.untrustedInput`, `privateData`, `externalComms`, `codeExec` (the lethal-trifecta combinations) and any tool design marks irreversible without approval.
   - `context`: `d.agent.memory`, `identity`.
   - `when`: `d.agent.budget` and `maxSteps` become limits; `fallback` becomes an escalation.
   - `goal` and `emit`: the design cannot know these. A skeleton is `needs_input` with the reason "no goal stated", until a person writes the override `.m`. This is deliberate: M's goal is a human statement, never invented.
3. Run `uv run mlang compile <file> --emit agt,agis,sdk,invariant,jacket` per agent into `<out>/<slug>/`.
4. Write `result.json` v2: `compiled` when mlang exits 0, `needs_input` for skeletons, `failed` with mlang's message otherwise. Never print or store secrets; reasons only.
5. Exit 0 whenever `result.json` was written, even with failures (the file is the verdict); non-zero only when it could not be written.

On the work VM the bridge is the single file to adapt to the newer mlang; designc and S2 do not change.

Tests (in m-lang): skeleton for a design agent compiles to `needs_input`; override `.m` compiles; hash matches the JS vectors; failed compile is reported not raised.

## 5. Build order

| Step | Where | Size |
| --- | --- | --- |
| a. Result v2 in `Contracts.readResult`, schema, mock to v2 | designc | small |
| b. Freeze copy + refusals + `handoverPlan` + tests | designc | medium |
| c. Gate clause + `contracts.require` | designc | small |
| d. Bridge script + tests | m-lang | medium |
| e. S2 reader + `FACTORY_CONTRACTS` + wizard question | S2 | medium |
| f. S2 enforcement through AGT + `policy_denied` event | S2 | large, needs open question 2 |

Each step is independently shippable; a to c need no M, d no S2.

## Open questions

1. Which agents does a contract govern: the agents inside the system being designed, S2's own roles, or both? This spec assumes the first, with S2's roles staying under `policies/s2`. Say if M should govern S2's roles too.
2. AGT runtime from .NET: is there a .NET SDK or must S2 call a Python sidecar (`agt check --policy X --action Y`)? Step f depends on this; on the work VM the answer may differ.
3. Should `goal` ever come from the design (a `d.agent.goal` property), so skeletons compile without an override? Convenient, but it moves a human statement into the model.
