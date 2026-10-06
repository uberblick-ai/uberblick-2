# Delivery policy

Which gates a change passes, which reviews it owes and who may merge it.
Product intent, architecture and principles live in the MCP corpus; this file
owns operational authority only. `integration.md` holds how the gates run, and
`review-protocol.md` how findings are settled.

## Decision records

Record a choice only when all three hold:

1. It outlives its task: it still binds work after the issue closes.
2. There was a real alternative, not already dictated by a decision or corpus
   document.
3. Reversing it costs something: it fixes user-facing behavior, a command or
   API, a data shape, a guarantee, a dependency or a process rule. Would a
   fresh agent choosing the opposite next month leave something to undo?

A record is overkill when the choice dies with the task; an existing decision,
corpus document, linter, formatter or established code convention already
decides it (link that source); it is cheap to reverse and binds nothing
downstream (naming, refactors, internal helpers or test structure); it is a bug
fix restoring intended behavior; or it describes current behavior rather than
a choice (update the owning Regular Document). Keep task-local reasoning in
the issue, PR or code comment. When in doubt, mention the choice in the PR
without a new record; a reviewer or person can promote it later.

An agent creates a topic's first record `decided` as its stance, except that a
topic reserved to a human under [human-decisions.md](human-decisions.md) or the
merge policy below starts `open` with the agent's recommendation. Local protocols
own this authority. Discover relevant live decision records and lifecycle guidance
by purpose under [AGENTS.md](../../AGENTS.md#read-for-the-action); use installed MCP
schemas for stance, answer, rejection and topic-resolution calls and refusals.
Missing required guidance does not grant authority; stop the dependent decision.
`create_doc` and `set_status` record a person's answer with
`answer: {who, when, where}`; a first record decided without one is
`agentStance`. Do not invent an answer or reject a stance without a person's
recorded answer. A decided record's title, decision line and blocks refuse
writes with `decision_read_only`; a change needs a successor a person approves.

Implementation and review corrections follow
[`implementer.md`](../roles/implementer.md#decision-records); missing-record
findings follow [`review-protocol.md`](review-protocol.md#findings). These
routes do not change the review or merge tiers below.

## Workflow

1. **Issue first.** Every change starts as a GitHub issue that conforms to
   `.github/ISSUE_SPEC.md`; the `ready` label asserts that it does. No issue,
   no branch.
2. **Branch and pull request.** An implementer run builds it on its own branch
   under `.agents/roles/implementer.md` and opens a pull request against
   `main` that closes the issue (`Closes #N`) and states what changed and how
   it was verified. Nothing is committed to `main` directly.
3. **Gates, all before merge**, each at the exact head that merges. Effort
   follows semantic risk: paths and line counts are inspection signals, not
   extra rounds. Link exact-head evidence instead of repeating it.
   - **CI.** Every tier requires a `signoff` commit status of `success` at the
     merging head, from the integrator's own local CI run (`mise run ci <sha>`,
     `integration.md`).
     A missing or failing status blocks agent merge. If the run cannot
     complete for reasons outside the change, escalate to a maintainer, who
     may merge by hand.
   - **Immutable review.** Local CI runs the isolated review
     (`mise run review <sha>`) at the head, so every change has one. A change
     where the base moved under the PR also passes the merged-tree gate
     (`integration.md`). At stateful boundaries —
     persistence, startup and shutdown, networking, concurrency — passing
     happy-path tests is not enough: run focused failure-path probes and post
     reproducible findings. Worktree tests help while building but are never
     merge evidence.
   - **Acceptance.** Every acceptance criterion of the issue, with evidence.
   - **Independent review**, per "Reviews owed" below, settled under
     `review-protocol.md`.
   - **No unanswered remarks.** Immediately before merging, every review
     comment from a trusted author (`AGENTS.md`), including any that arrived
     after the other gates passed, is fixed or answered.
4. **Merge, then docs.** Merge under the merge policy below, then apply the
   pull request's `Corpus update` through the corpus MCP tools, so the
   product docs describe the new state.

## Reviews owed

Which reviews a change owes depends on what the diff decides, never on where it
landed: paths identify what to inspect and buy no review on their own. A listed
boundary or a named concrete risk is settled before the exemption is
considered, so no diff is waived out of a boundary it crosses.

| Condition | Reviews owed |
| --- | --- |
| `boundary` — the diff changes schema meaning, persistence, synchronization, concurrency, auth, runtime dependencies or decided architecture, or the implementer or integrator names a concrete unresolved risk warranting a second perspective | `agent` |
| `exempt` — a test-only, docs-only or narrowly mechanical diff that preserves production behavior, where focused validation directly proves the contract and it is not an agent-authored process change | none |
| `otherwise` — every other diff, including an agent-authored process change that would otherwise be exempt | `agent` |

The implementer routes by the reviews owed: it finishes `review` when the
`agent` review is owed, or `integrate` with `none owed (<reason>)`. The
integrator may require more agent review with `review`. The `agent` review
always runs on a different runtime from the author and is never started by
the role that owes it. It hunts for counterexamples, missing failure paths, incorrect
assumptions, overengineering and overtesting; gate work never substitutes for
it.

Copilot is optional ([owner decision](https://github.com/uberblick-ai/uberblick-2/issues/1217)).
Reinstating its gate requires an explicit owner decision and a corresponding
policy update. Do not request it automatically; request it only when a person
asks. A missing, pending, stale-head or unavailable Copilot review never by
itself defers, escalates or blocks integration, even if an older handoff calls
it required. An explicit owner instruction to hold a merge still applies;
requesting an optional review does not itself impose that hold.

Record a refusal once using its existing review record, or a PR comment if
none exists; do not retry it without a person's request. Every Copilot remark
posted before merge, including late ones, falls under the no-unanswered-remarks
gate. Independent agent review, required correction rounds, CI and all other
validation and merge gates remain unchanged.

## Merge policy — the rules are the authority, not a session

- **Tier 1 — existing behavior only.** No change to production behavior,
  persisted state, public command or interface surface, dependencies, or
  decided architecture: focused tests, documentation corrections and
  mechanical maintenance that defend or describe an existing contract. Merge
  when the gates and acceptance criteria are green; no merge report is owed
  except for [batch PRs](#batch-merge-reports).
- **Tier 2 — merge with evidence.** Production-behavior changes that are
  neither tier 1 nor tier 3, including feature packages and backward-compatible
  additive schema work: all gates green plus a merge-report comment on the PR —
  acceptance criteria checked off one by one, gate outcomes, and every finding
  answered rather than corrected, with its reason. The integrator audits after
  merging while updating the product docs; audit findings become issues, not
  reverts, unless critical.
- **Tier 3 — a person decides before merge.** Without a person's answer that
  covers the diff, the integrator escalates (`.agents/protocols/human-decisions.md`),
  naming the trigger; with one, it merges as tier 2 and every other gate still
  applies. Triggers: a breaking or destructive schema change, data migration,
  or break in persisted-data compatibility; a change to CRDT or concurrency
  semantics; a change to decided architecture or to guarantees defined by
  their owning corpus documents; a new *runtime* dependency, subject to the
  web UI exception below; auth or token semantics; overruling a major reviewer
  finding; a process change that alters
  authority, eligibility, merge or approval rules, or destructive automation;
  and a diff that adds or changes the user-facing command surface — new
  subcommands, a changed interaction between a person and the product,
  anything relevant to distribution or to new users (owner decision,
  2026-08-24). A logical extension or a bugfix of already-shipped command
  behavior is tier 2. Paths identify what to inspect; they never trigger tier 3
  by themselves.

The new-runtime-dependency trigger does not apply to a dependency added only
to `packages/web` for web UI when the PR records how it meets the live library
selection criteria discovered by purpose in the live corpus under
[AGENTS.md](../../AGENTS.md#read-for-the-action). It still applies when those criteria
are absent, unavailable or unmet, or the PR lacks the evidence; when the
library touches sync, persistence, auth or CRDT semantics; and to any runtime
dependency outside `packages/web`. This exception requires the reviewed
library-selection Corpus update in [PR #1094](https://github.com/uberblick-ai/uberblick-2/pull/1094)
to be applied to the live corpus after merge; a draft in a PR is not sufficient.
It removes only this trigger: every other tier-3 trigger and the Reviews owed
table still apply.

The answer may come early. A person's answer on the issue or the PR that fixes
the PR's intended shape — while shaping, to a question, or unprompted — covers
that shape, its conforming fix-ups and non-rewriting synchronization with the
base. A tier-3 trigger that fired only in implementation is outside it unless
the answer named it, and so is later work that materially expands the design
or scope: escalate again, naming the difference.

### Library and custom-mechanism choices

Tier routes authority; it does not choose the design. Never replace a simpler
established primitive or dependency with bespoke correctness machinery merely
to avoid tier 3. Challenge custom mechanisms, including parsers and file-format
handling, against existing primitives and suitable libraries. Compare the
supported input contract, correctness burden and maintenance cost; a hand-built
subset is not automatically simpler because it adds no dependency. Recommend
the smallest defensible approach with evidence. If it needs a protected runtime
dependency, ask the owner early, preferably during preparation. This grants no
new dependency exception and invents no missing corpus selection criteria.

For web UI, challenge custom mechanics against the framework,
existing dependencies and libraries qualifying under those live selection criteria.
Custom mechanics still require the evidenced, owner-confirmed exception specified
by the governing guidance; if that guidance is missing, stop the dependent choice
rather than assume an exception. Make a shape
that needs a person's answer visible early and get the answer once.

The tier-3 trigger list remains the owner-controlled autonomy boundary. Verify gates
at the candidate SHA rather than relying on a session's assertion.

### Batch merge reports

A batch PR allowed by [ISSUE_SPEC's sizing](../../.github/ISSUE_SPEC.md#sizing)
must carry the tier-2 merge-report comment described above, checking each issue's
acceptance criteria separately, even when the PR would otherwise be tier 1.
