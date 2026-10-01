# Delivery policy

Which gates a change passes, which reviews it owes and who may merge it.
Product intent, architecture and principles live in the MCP corpus; this file
owns operational authority only. `integration.md` holds how the gates run, and
`review-protocol.md` how findings are settled.

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
   - **Immutable review.** CI's `gates` check at that head is enough for a
     tier-1 change that owes no review and touches none of persistence,
     synchronization, concurrency, process lifecycle or auth; verify its
     conclusion and link it, since nothing enforces it (owner decision,
     2026-09-02). Every other change, and any change where the base moved
     under the PR or CI is not green at that head, runs the isolated review
     (`mise run review <sha>`, `integration.md`). At stateful boundaries —
     persistence, startup and shutdown, networking, concurrency — passing
     happy-path tests is not enough: run focused failure-path probes and post
     reproducible findings. Worktree tests help while building but are never
     merge evidence.
   - **Acceptance.** Every acceptance criterion of the issue, with evidence.
   - **Independent review**, per "Reviews owed" below, settled under
     `review-protocol.md`.
   - **No unanswered remarks.** Immediately before merging, every review
     comment — human or bot, including any that arrived after the other gates
     passed — is fixed or answered.
4. **Merge, then docs.** Merge under the merge policy below, then update the
   product docs through the corpus MCP tools to the new state.

## Reviews owed

Which reviews a change owes depends on what the diff decides, never on where it
landed: paths identify what to inspect and buy no review on their own. A listed
boundary or a named concrete risk is settled before the exemption is
considered, so no diff is waived out of a boundary it crosses.

| Condition | Reviews owed |
| --- | --- |
| `boundary` — the diff changes schema meaning, persistence, synchronization, concurrency, auth, runtime dependencies or decided architecture, or the implementer or integrator names a concrete unresolved risk warranting a second perspective | `agent` and `copilot` |
| `exempt` — a test-only, docs-only or narrowly mechanical diff that preserves production behavior, where focused validation directly proves the contract and it is not an agent-authored process change | none |
| `otherwise` — every other diff, including an agent-authored process change that would otherwise be exempt | `agent` |

The implementer routes by the reviews owed: it finishes `review` when the
`agent` review is owed, first requesting the Copilot review at the same head
when that is owed too, or `integrate` with `none owed (<reason>)`. The
integrator may require more with `review`. The `agent` review always runs on a
different runtime from the author and is never started by the role that owes
it. It hunts for counterexamples, missing failure paths, incorrect
assumptions, overengineering and overtesting; gate work never substitutes for
it.

A Copilot review is required where the table owes it and optional evidence
otherwise; every remark it posts falls under the no-unanswered-remarks gate. A
required Copilot review that cannot be delivered is an escalation and is never
merged past; an optional one's refusal is recorded once and blocks nothing.

## Merge policy — the rules are the authority, not a session

- **Tier 1 — existing behavior only.** No change to production behavior,
  persisted state, public command or interface surface, dependencies, or
  decided architecture: focused tests, documentation corrections and
  mechanical maintenance that defend or describe an existing contract. Merge
  when the gates and acceptance criteria are green; no merge report is owed.
- **Tier 2 — merge with evidence.** Production-behavior changes that are
  neither tier 1 nor tier 3, including feature packages and backward-compatible
  additive schema work: all gates green plus a merge-report comment on the PR —
  acceptance criteria checked off one by one, gate outcomes, and every finding
  answered rather than corrected, with its reason. The integrator audits after
  merging while updating the product docs; audit findings become issues, not
  reverts, unless critical.
- **Tier 3 — a person decides before merge.** Without a person's answer that
  covers the diff, the integrator escalates (`.agents/roles/README.md`),
  naming the trigger; with one, it merges as tier 2 and every other gate still
  applies. Triggers: a breaking or destructive schema change, data migration,
  or break in persisted-data compatibility; a change to CRDT or concurrency
  semantics; a change to decided architecture or to guarantees defined by
  their owning corpus documents; a new *runtime* dependency; auth or token
  semantics; overruling a major reviewer finding; a process change that alters
  authority, eligibility, merge or approval rules, or destructive automation;
  and a diff that adds or changes the user-facing command surface — new
  subcommands, a changed interaction between a person and the product,
  anything relevant to distribution or to new users (owner decision,
  2026-08-24). A logical extension or a bugfix of already-shipped command
  behavior is tier 2. Paths identify what to inspect; they never trigger tier 3
  by themselves.

The answer may come early. A person's answer on the issue or the PR that fixes
the PR's intended shape — while shaping, to a question, or unprompted — covers
that shape, its conforming fix-ups and non-rewriting synchronization with the
base. A tier-3 trigger that fired only in implementation is outside it unless
the answer named it, and so is later work that materially expands the design
or scope: escalate again, naming the difference.

Tier routes authority; it does not choose the design. Never replace a simpler
established primitive or dependency with bespoke correctness machinery merely
to avoid tier 3: make the intended shape visible early and get the answer once.

The tier-3 trigger list is the owner-controlled autonomy boundary. Verify gates
at the candidate SHA rather than relying on a session's assertion.
