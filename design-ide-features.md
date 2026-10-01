# System Design IDE: Shift-Left Feature Set

The core idea: the design is a **typed, checkable model**, not a drawing. The canvas is one view of that model; everything else hangs off it.

## 1. Make the design checkable

- **Typed architecture model.** C4 elements with declared ports, contracts and data flows. Apply the mlang principle at the architecture level: a container can't touch a datastore without a declared contract; an unowned flow is a compile error.
- **Quality attribute scenarios as first-class objects.** ATAM-style ("p99 < 200ms under X load", "survives region loss"), linked to the elements that satisfy them. Unaddressed scenarios are flagged before grill-me.
- **Requirement traceability.** Jira/Confluence → design element → decision → generated code. mlang doesn't emit requirement IDs today, so this is a real gap. Without it, "code is disposable" can't prove that regenerated code still meets intent.
- **Decisions bound to elements.** ADRs in the decision registry declare what they affect; a design change resurfaces the affected decisions for re-promotion.

## 2. Verify behaviour before code exists

- **P models generated from interaction flows**, with a standard failure library injected automatically: retries, duplicates, reordering, partitions, concurrent writers. Lost-update bugs are caught at design time.
- **Failure-mode and threat pass.** STRIDE per data flow, FMEA per component, and a blast-radius view that makes process-per-module visible.
- **Cost and capacity sketching.** Back-of-envelope numbers per flow, including token cost for agentic paths, so value and spend are designed in rather than measured afterwards.

## 3. Keep design and reality in sync

- **Fitness functions compiled from the design.** Dependency, layering and contract-conformance rules (NetArchTest/ArchUnit-style), plus CRAP and mutation thresholds, as gates or gradients encoded in mlang and run against System 2 output.
- **Drift detection.** The recovered C4 map of the existing codebase is diffed against the intended design, and the differences are fed to System 4 as findings.
- **Semantic design diffs and impact analysis.** "What breaks if I split this container?" is answered in terms of elements and contracts, not pixels.
- **Definition-of-ready gate** before handing off to the coding system: scenarios covered, P model passing, contracts generated (OpenAPI/AsyncAPI), decisions promoted.

## 4. The canvas: boxes and arrows that edit the model

Avoid the Visio/draw.io trap, where a box is just a shape with a label and nothing stops you drawing an arrow that means nothing. The canvas is a **structured editor over the model**:

- **Dropping a box creates a typed element.** You pick container, datastore or agent, and it gets an owner. This is the moment it enters the model.
- **Drawing an arrow opens a contract.** You are prompted for protocol, sync/async and payload schema. An arrow without a contract stays visibly incomplete, like a red squiggle.
- **Edits round-trip.** Model changes (text or agent) update the canvas, and canvas edits update the model. Layout is stored separately, so coordinate merge conflicts never corrupt the architecture.
- **Views are projections of one model.** C4 levels, blast radius, a data-flow view for STRIDE, and a drift overlay against the recovered codebase.
- **Validation is live.** Unsatisfied scenarios, unbound decisions and failing P checks render on the diagram itself.

Why drawing matters: spatial thinking is how people explore a design before they can articulate it. The canvas is also how grill-me and Braintrust-style reviews happen with humans, and it's the view leadership actually reads.

**Repo boundary:** the separate canvas repo exposes a small interface ("render this model, emit these edits") and stays dumb about semantics. designc owns the model and the rules.

## Suggested build order

1. Typed model + contracts
2. Fitness functions (closes the design↔code loop cheaply and gives System 4 signal)
3. Canvas as structured editor over the model
4. P behavioural models + quality attribute scenarios (both generated from the typed model)
5. Drift detection, semantic diffs, definition-of-ready gate
