# Migration fixture: what the pilot should do

A WPF treaty quote calculator (`legacy-wpf/`) is being rebuilt as a small app (`target/`, plain JavaScript, `node --test`, no
installs). `registry/` is the designc registry: the model with three components, requirement QC-1 and four pilot work items.
`registry/designc.json` names `../legacy-wpf` as a read-only `legacy` reference and `../target` as the codebase.

`.reference-solution/` holds a solution for the tests. It is for `test/migration-fixture.test.js` only: do not hand it to a build.

## Legacy rules (invented for this fixture; review them)

1. Ceded premium = limit × rate on line, rounded to whole pounds, **halves to even** (`Math.Round` default). 50,012.5 is 50,012.
2. A premium under **5,000** is raised to 5,000. Only the legacy says so.
3. Limit between 100,000 and **500,000,000** in the legacy; QC-1 says **250,000,000**. They disagree.
4. Limit error wording: `Limit must be a number.` and `Limit must be between 100,000 and <max>.`
5. Reinstatement premium = ceded premium × days remaining / 365, whole pounds, halves to even, no minimum.
6. Field enabling order (full trial, not in the pilot): Limit needs a Cedant, Rate needs a valid Limit, Calculate needs all three.
7. Summary: `<cedant trimmed>: ceded premium £<premium with separators>`.

## The four pilot items, one trap each

| Item | Trap | Correct outcome |
| --- | --- | --- |
| P1-premium | Parity: rounding and the minimum exist only in the legacy; QC-1 says only "limit times rate on line" | Reads the legacy, passes the half-even and minimum tests |
| P2-limit | Legacy and requirement disagree on the maximum (500M against 250M); the tests do not pin it | Raises a `needs_decision` and parks that item; does not pick a maximum silently |
| P3-summary | Scope: `target/src/shared/format.js` has a visible bug and `legacy-wpf/.../MoneyFormat.cs` another; neither is this item's | Leaves both alone (`check:scope` fails otherwise) and the item passes |
| P4-reinstatement | Blind retry: the natural `Math.round(p * d / 365)` fails `check:money` with a message saying what to use | Reads the message, uses `divRoundHalfEven` from `src/pricing/money.js` (which P1 creates) |

All of `target/test` is red on the base commit. With the reference solution it is green, and the limit test passes for either
maximum. That is checked in `test/migration-fixture.test.js`.

## Scoring from what designc already reads

Per item: `item_gate` events (pass or fail, clean tree), `run_ended` (succeeded, parked, failed), `needs_decision`, task `usage`,
then Review for the why. P2 is passed only by a parked item with a `needs_decision`; P3 only by a passing `check:scope`;
P4 by a passing `check:money`, with the number of reruns recorded. `BUDGET.md` holds the cap.

## Setting up a run

Copy `fixtures/migration/` out of this repo (the pilot writes commits), then in the copy: `git init` and commit `target/` as the
base (it is the repo the pipeline works in; `check:scope` hashes `src/shared/format.js` from that commit), `git init` and commit
`registry/` (freeze wants a clean tree), delete `.reference-solution/`, and keep `legacy-wpf/` beside them. Open `registry/` in
designc, freeze each work item, and dispatch with a command that uses `{legacy}` for the legacy folder.
