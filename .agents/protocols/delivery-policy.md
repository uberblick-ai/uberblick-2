# Delivery policy

Executable review, validation and merge rules. Product intent, architecture and
principles live in the MCP corpus; this file owns operational authority only.
Independent review runs on the durable requests `review-protocol.md` defines,
answered by independently launched reviewers; the counts below are executable
in `review-rounds.mjs` beside it.

## Development workflow (every functionality)

1. **Issue first.** Every piece of functionality starts as a GitHub issue:
   what, why, acceptance criteria. No issue, no branch. Issues the
   implementation loop may pick up must conform to `.github/ISSUE_SPEC.md`
   (`Depends-on`/`Touches` header, runnable acceptance criteria, explicit
   out-of-scope); the `ready` label asserts conformance and eligibility.
2. **Branch + implementer agents.** Implementation happens on a feature branch
   (`feat/<slug>`, `fix/<slug>`), written by isolated implementer agents that
   claim their own issue in `.github/ISSUE_SPEC.md`'s grammar under
   `.agents/roles/implementer.md`. Never commit feature work directly to
   `main`.
3. **PR.** Open a PR against `main` linked to the issue (`Closes #N`), with a
   body stating what changed and how it was verified.
4. **Gates — all of them, before merge.** Effort follows semantic risk. Paths
   and line counts are inspection signals, not automatic extra rounds; link
   exact-head evidence instead of repeating it:
   - immutable review green at the exact merge head. The Docker review
     (`mise run review <head-sha>`, from a trusted checkout of `origin/main`)
     is required when the diff touches persistence, synchronization,
     concurrency, process lifecycle or auth, when a challenge round is owed,
     when `main` moved under the PR, or when CI is not green at that head;
     otherwise, for tier 1, CI's `gates` check run at `headRefOid` is the
     immutable review — verify its conclusion at that SHA and link it, since
     nothing enforces it (owner decision, 2026-09-02). Worktree tests are
     useful during implementation but are never merge evidence, because a
     shared checkout can change during review;
   - integrator validation against the issue's acceptance criteria;
   - **independent implementation challenge, proportionate to semantic risk.**
     How many challenges a candidate owes and who requests each is the
     "Reviews owed" table below; `review-rounds.mjs` beside this file is that
     table in executable form and `review-rounds.test.mjs` holds the two in
     parity. A challenge is never a child of the role that owes it: the
     requester posts the durable review request `review-protocol.md` defines,
     and an independently launched `implementation-reviewer` claims it and
     answers at the exact candidate head. Where the table owes nothing, the
     implementer writes `Challenge: none owed (<reason>)` in its handoff and
     requests nothing, and the integrator requests nothing either. Where it
     owes two, both target the same frozen candidate head before ordinary
     P2/P3 corrections: the implementer hands off the first verdict without
     changing that head, the integrator requests and awaits the second, and one
     ruling batches both sets of findings. A P1 may break the freeze; its
     corrected head re-establishes the required independent evidence before
     merge. Every
     challenge actively hunts for counterexamples, missing failure paths,
     incorrect assumptions, overengineering and overtesting; integrator gate
     work and Copilot do not substitute for a required challenge;
   - **zero unaddressed PR remarks** — immediately before merging, re-fetch
     the PR's reviews and comment threads (human and bot alike, including
     remarks that arrived after the other gates passed); merge only when
     every remark is fixed or explicitly answered.
   Findings are triaged into an explicit disposition: fixed on the branch;
   deferred to a linked issue with the accepted risk recorded on the PR
   (never for data loss, auth/security exposure, or a violated invariant);
   create that issue through `.github/ISSUE_SPEC.md`'s **Request source** path;
   accepted as debt on the PR when P3, or when a P2's claimed impact remains
   theoretical because no current supported-usage failure is established; or,
   under that theoretical condition, closed `wontfix` if already an issue. Both
   record the consequence and disproportionate delivery cost;
   documented as an out-of-usage-model boundary; or rejected with an
   explicit reply on the PR thread — never silent dismissal. A concrete bug
   observed later is new evidence and may be filed or reopened then.
   GitHub Copilot is optional additional evidence, not a gate. When requested,
   record a platform refusal or outage once and continue; every review remark it
   actually posts still falls under the zero-remark gate above.
   Reviewing a commit is one command, `mise run review <head-sha>`,
   run from a checkout at freshly fetched `origin/main` with `mise.toml`,
   `Dockerfile.review` and `.dockerignore` unmodified — the task refuses
   otherwise, because main is what supplies the build recipe. The reviewed
   commit contributes file contents, via `git archive`; its manifests still
   install in the networked build stage, so pass the SHA rather than checking
   the branch out, and never pass secrets, host mounts, privileged mode, or
   the Docker socket. For persistence,
   startup/shutdown, networking, concurrency, and other stateful boundaries,
   passing happy-path tests is not enough: run focused failure-path probes in
   the retained review image and post reproducible findings inline. README's
   "Review isolation" states the full boundary.
5. **Merge, then docs.** After the gates pass, merge per the merge policy
   below; then update the product docs (through the Uberblick MCP tools) to the new status quo.

### Reviews owed

The count is a function of what the diff decides, never of where it landed:
paths identify what to inspect and buy no round on their own. A listed boundary
or a named concrete risk is settled before the exemption is considered, so no
diff is waived out of a boundary it crosses.

| Condition | Reviews owed | Who requests each |
| --- | --- | --- |
| `boundary` — the diff changes schema meaning, persistence, synchronization, concurrency, auth, runtime dependencies or decided architecture, or the implementer or integrator names a concrete unresolved risk warranting both perspectives | 2 | `implementer` on the other runtime, then `integrator` on the author's runtime |
| `exempt` — a test-only, docs-only or narrowly mechanical diff that preserves production behavior, where focused validation directly proves the contract and it is not an agent-authored process change | 0 | nobody |
| `otherwise` — every other diff, including an agent-authored process change that would otherwise be exempt | 1 | `implementer` on the other runtime |

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
- **Tier 3 — `needs-human`, pre-merge.** Label the PR `needs-human`, park it,
  continue with other eligible issues. The owner authorizes by swapping
  `needs-human` for `human-approved`, or explicitly directs a session to do so
  for named PRs with a provenance comment; the loop then executes that merge as
  tier 2. Every other gate remains. Triggers: a breaking or destructive schema
  change, data migration, or break in persisted-data compatibility; a change to
  CRDT or concurrency semantics; changes to decided architecture or guarantees defined by their owning corpus
  documents; new *runtime* dependencies; auth/token semantics;
  overruling a major reviewer finding; and process changes that alter
  authority, eligibility, merge/approval rules, or destructive automation.
  Paths identify what to inspect; they never trigger tier 3 by themselves.
- **Owner approval — one decision, not a late ceremony.** `human-approved` may
  be recorded as soon as a PR's intended shape and known findings are visible.
  It covers conforming fix-ups and non-rewriting synchronization with `main`.
  If later work materially expands the design or scope, replace it with
  `needs-human` and name the delta.
  **An owner decision on the issue is that approval** (owner decision,
  2026-09-05): when the issue a PR closes carries the owner's dated decision
  fixing the PR's intended shape — the shaping confirmation, a recorded
  `Owner decision` comment, or the answer that lifted `needs-decision` — the
  integrator does not park. It verifies the diff conforms to the decided shape
  and that no finding expands it, applies `human-approved` itself with a
  comment citing that decision, and merges as tier 2. It parks `needs-human`
  only for a delta the decision did not cover, naming the delta. A tier-3
  trigger that fired only in implementation — a persisted-data break, a CRDT
  or concurrency change, a runtime dependency, auth semantics — is such a
  delta unless the decision named it.
- **Tier routes authority; it does not choose the design.** Never replace a
  simpler established primitive or dependency with bespoke correctness
  machinery merely to avoid tier 3. Make the intended shape visible early and
  obtain the owner decision once; the approval can precede final gates.
- **`packages/cli` — tiered from the diff, not the package name** (owner
  decision, 2026-08-24). A diff that adds or changes the user-facing command
  surface — new subcommands, a changed user↔uberblick interaction, anything
  relevant to distribution or to new users — is tier 3; a logical extension or
  a bugfix of already-shipped CLI behavior is tier 2.

The tier-3 trigger list is the owner-controlled autonomy boundary. Verify gates
at the candidate SHA rather than relying on a session’s assertion.
