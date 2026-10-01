# Delivery policy

Executable review, validation and merge rules. Product intent, architecture and
principles live in the MCP corpus; this file owns operational authority only.
Which reviews a diff owes is decided here; ub-agents dispatches them and binds
each verdict to the head it reviewed.

## Development workflow (every functionality)

1. **Issue first.** Every piece of functionality starts as a GitHub issue:
   what, why, acceptance criteria. No issue, no branch. Issues the
   implementer may be given must conform to `.github/ISSUE_SPEC.md`
   (`Depends-on`/`Touches` header, runnable acceptance criteria, explicit
   out-of-scope); the `ready` label asserts conformance and eligibility.
2. **Branch + implementer agents.** Implementation happens on a feature branch,
   written by isolated implementer runs under `.agents/roles/implementer.md`.
   Never commit feature work directly to `main`.
3. **PR.** Open a PR against `main`, linked to the issue
   (`Closes #N`), with a body stating what changed and how it was verified.
4. **Gates — all of them, before merge.** Effort follows semantic risk. Paths
   and line counts are inspection signals, not automatic extra rounds; link
   exact-head evidence instead of repeating it:
   - immutable review green at the exact merge head. The isolated review
     (`mise run review <sha>`, from a trusted checkout of `origin/main`) is
     required when the diff touches persistence,
     synchronization, concurrency, process lifecycle or auth, when a challenge
     round is owed, when the base moved under the PR, or when CI is not green
     at that head; otherwise, for tier 1, CI's `gates` check run at `headRefOid` is the
     immutable review — verify its conclusion at that SHA and link it, since
     nothing enforces it (owner decision, 2026-09-02). Worktree tests are
     useful during implementation but are never merge evidence, because a
     shared checkout can change during review;
   - integrator validation against the issue's acceptance criteria;
   - **independent implementation challenge, proportionate to semantic risk.**
     Which reviews a candidate owes is the "Reviews owed" table below. The
     implementer names them in its outcome; the integrator may add more. A
     review is never run by the role that owes it: ub-agents runs the `agent`
     review on a different runtime from the diff's author and requests the
     `copilot` review from GitHub, at the exact candidate head. Where the table
     owes nothing, the implementer states `none owed (<reason>)`. Where it owes
     two, both review the same head before any correction, and one ruling
     batches both sets of findings. The `agent` review actively hunts for
     counterexamples, missing failure paths, incorrect assumptions,
     overengineering and overtesting; integrator gate work does not substitute
     for a required review;
   - **zero unaddressed PR remarks** — immediately before merging, re-fetch
     the PR's reviews and comment threads (human and bot alike, including
     remarks that arrived after the other gates passed); merge only when
     every remark is fixed or explicitly answered.
   Findings are triaged into an explicit disposition: fixed on the branch;
   deferred to a linked issue with the accepted risk recorded on the PR
   (never for data loss, auth/security exposure, or a violated invariant);
   create that issue as `.agents/roles/README.md` describes;
   accepted as debt on the PR when P3, or when a P2's claimed impact remains
   theoretical because no current supported-usage failure is established; or,
   under that theoretical condition, closed `wontfix` if already an issue. Both
   record the consequence and disproportionate delivery cost;
   documented as an out-of-usage-model boundary; or rejected with an
   explicit reply on the PR thread — never silent dismissal. A concrete bug
   observed later is new evidence and may be filed or reopened then.
   A Copilot review is required where the table owes it and optional evidence
   otherwise. Every remark it posts falls under the zero-remark gate above. A
   required Copilot review that the platform refuses or cannot deliver parks the
   PR `needs-human` rather than merging past it; an optional one's refusal is
   recorded once and does not block.
   Reviewing a commit is one command — `mise run review <sha>` — run from a
   checkout at freshly fetched `origin/main` with that task's own recipe
   unmodified; it refuses otherwise, because
   the base is what supplies the recipe. The reviewed commit contributes file
   contents, via `git archive`; its manifests still install in the networked
   build stage, so pass the SHA rather than checking the branch out, and never
   pass secrets, host mounts, privileged mode, or the container socket. For
   persistence, startup/shutdown, networking, concurrency, and other stateful
   boundaries,
   passing happy-path tests is not enough: run focused failure-path probes in
   the retained review image and post reproducible findings inline. README's
   "Review isolation" section states the full boundary.
5. **Merge, then docs.** After the gates pass, merge per the merge policy
   below; then update the product docs (through the corpus MCP tools) to the
   new status quo.

### Reviews owed

The count is a function of what the diff decides, never of where it landed:
paths identify what to inspect and buy no round on their own. A listed boundary
or a named concrete risk is settled before the exemption is considered, so no
diff is waived out of a boundary it crosses.

| Condition | Reviews owed |
| --- | --- |
| `boundary` — the diff changes schema meaning, persistence, synchronization, concurrency, auth, runtime dependencies or decided architecture, or the implementer or integrator names a concrete unresolved risk warranting a second perspective | `agent` and `copilot` |
| `exempt` — a test-only, docs-only or narrowly mechanical diff that preserves production behavior, where focused validation directly proves the contract and it is not an agent-authored process change | none |
| `otherwise` — every other diff, including an agent-authored process change that would otherwise be exempt | `agent` |

### Merge policy — the rules are the authority, not a session

- **Tier 1 — existing behavior only.** No change to production behavior,
  persisted state, public command or interface surface, dependencies, or
  decided architecture. This includes focused tests, documentation corrections,
  and mechanical maintenance that defend or describe an existing contract. The
  integrator merges when the ordinary gates and acceptance criteria are green;
  no merge report is owed.
- **Tier 2 — self-merge with evidence.** Production-behavior changes that meet
  neither tier 1 nor tier 3, including feature packages and backward-compatible
  additive schema work: all gates green **plus** a merge-report comment on the PR —
  acceptance criteria checked off one by one, gate outcomes, any rejected
  review findings with reasons. The integrator audits post-merge while updating
  the product docs; audit findings become issues, not reverts, unless critical.
- **Tier 3 — `needs-human`, pre-merge.** The integrator finishes `needs-human`
  and the PR parks. The owner authorizes by swapping `needs-human` for
  `human-approved`, or explicitly directs a session to do so for named PRs with
  a provenance comment; the integrator then executes that merge as tier 2. Every other gate remains. Triggers: a breaking or destructive schema
  change, data migration, or break in persisted-data compatibility; a change to
  CRDT or concurrency semantics; changes to decided architecture or guarantees defined by their owning corpus
  documents; new *runtime* dependencies; auth/token semantics;
  overruling a major reviewer finding; and process changes that alter
  authority, eligibility, merge/approval rules, or destructive automation.
  Paths identify what to inspect; they never trigger tier 3 by themselves.
- **Owner approval — one decision, not a late ceremony.** `human-approved` may
  be recorded as soon as a PR's intended shape and known findings are visible.
  It covers conforming fix-ups and non-rewriting synchronization with the base.
  If later work materially expands the design or scope, replace it with
  `needs-human` and name the delta.
  **An owner decision on the issue is that approval** (owner decision,
  2026-09-05): when the issue a PR closes carries the owner's dated decision
  fixing the PR's intended shape — the shaping confirmation, a recorded
  `Owner decision` comment, or the answer that lifted `needs-decision` — the
  integrator does not park. It verifies the diff conforms to the decided shape
  and that no finding expands it, cites that decision in its merge report, and
  merges as tier 2. It parks `needs-human` only for a delta the decision did not
  cover, naming the delta. A tier-3
  trigger that fired only in implementation — a persisted-data break, a CRDT
  or concurrency change, a runtime dependency, auth semantics — is such a
  delta unless the decision named it.
- **Tier routes authority; it does not choose the design.** Never replace a
  simpler established primitive or dependency with bespoke correctness
  machinery merely to avoid tier 3. Make the intended shape visible early and
  obtain the owner decision once; the approval can precede final gates.
- **The user-facing command surface — tiered from the diff, not the package
  name** (owner decision, 2026-08-24). A diff that adds or changes that surface
  — new subcommands, a changed interaction between a person and the product,
  anything relevant to distribution or to new users — is tier 3; a logical
  extension or a bugfix of already-shipped command behavior is tier 2.

The tier-3 trigger list is the owner-controlled autonomy boundary. Verify gates
at the candidate SHA rather than relying on a session’s assertion.
