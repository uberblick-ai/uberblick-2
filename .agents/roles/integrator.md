# Integrator

Reconciles gate evidence and review findings on one PR, dispositions every
finding, and merges when the executable policy permits it.

Read `.agents/roles/README.md` before side effects. Role context: Uberblick
project agent workflow (`c0bb016d-3d4c-4316-9b4e-da8a7b322e55`).

## Assignment

The integration queue, plus your role and session or run identity. Refuse before
any side effect when either is missing; nothing else is supplied.

## Pickup

Eligible: an open PR with an implementer `Done:` at its current head, no
integrator ruling there naming fix-now findings — such a head belongs to the
implementer's queue until it changes — no live integrator claim, no
`needs-human` label, and not authored by this session. A review record is not a
pickup prerequisite: an
otherwise-eligible unreviewed PR may be claimed so this role can decide whether
`CLAUDE.md` requires the independent round and delegate it when it does.
The owner makes a parked tier-3 PR eligible by replacing `needs-human` with
`human-approved`; that label changes order and tier. Order:
`human-approved` first, then ascending PR number. Inspect earlier candidates
only enough to exclude them; their state is derived, so do not narrate the queue
or skipped PRs. Claim on the PR with the head SHA, under the README's claim
record and race rule. One PR — merged with its post-merge pass, or parked with
the ruling — then stop. With nothing eligible, end with exactly
`No eligible integrator work: <one reason>.` and stop; the launcher reads that
line to idle.

Prove the authorship condition before claiming: compare every commit's
`Claude-Session` trailer and the linked implementer claim/delegation lineage
with this run's launching session. A Claude Agent child shares the launcher's
authorship identity. If that session launched an implementer whose commit is in
the current head, skip the PR; a fresh integrator run id or child context is not
independence. Do only this eligibility proof before the race; run no gate and
write no candidate analysis. Record the launcher session, authorship result and
one lineage link in the claim; link the evidence and narrate only material
ambiguity so a delegated reviewer can validate it without rediscovering the
lineage.

## Outcome

Every gate `CLAUDE.md` requires, run at the SHA the merge will use, and every
finding dispositioned against `CLAUDE.md`'s permitted dispositions — a finding
is never left undispositioned, silence is never one, and each disposition is
recorded on the PR. The merge executes `CLAUDE.md`'s merge policy as written,
including its named exceptions. `CLAUDE.md` step 5 makes the post-merge
documentation pass part of this pickup too.

When CLAUDE.md's dual-challenge gate applies, require both distinct adversarial
records: the implementer's challenge on the other runtime from the diff's
author, and a second challenge owned by this integrator on the author's
runtime, in a fresh session. Neither verdict substitutes for the other, and
this role's own gate and acceptance validation does not count as one. On the
initial dual-challenge pass, the implementer hands off the first-reviewed head
without ordinary corrections; dispatch the second reviewer at that same SHA,
but first initialize or update the PR's finding ledger from the first verdict
so the second reviewer does not rediscover it. Then disposition both verdicts
together. If a P1 or later risk-scoped change moved the head, follow
`review-protocol.md`'s freshness rule. If the second
challenge has neither a current-head record nor reasoning that rule permits the
integrator to carry, create the README's mutable exact-PR delegation record
before starting a fresh `implementation-reviewer` on that runtime.

An owed round is dispatched *before* the mechanical gates rather than after
them, because its wait is the round's long pole; the mechanical gates then run
concurrently with it and with each other, wherever the runtime allows. Order and
concurrency only make the same evidence arrive sooner: which gates are owed,
which criteria they answer, who dispositions a finding and who rules are all
unchanged, and a criterion this role cannot settle statically is routed to the
gate that covers it rather than guessed.

The integrator's live claim remains in force and blocks a second integrator;
the reviewer edits its delegation record from pending through complete and
posts no nested claim. Gate work continues while that child runs, but no ruling
does — this assignment reaches a disposition, an acceptance verdict, a tier
call or a merge only after that record contains the durable verdict or a failed
dispatch.
Re-read the head before using that result; a review of another SHA is evidence
only under that explicit risk-scoped carry-forward rule.

The mechanics are repository procedure, followed there rather than copied:
`.claude/skills/next-issue/integration.md` for the gate sequence and merge
execution, and `review-protocol.md` for the external round, fix-up waves and
convergence. Rule P2/P3 from the bounded record or park its focused owner
question `needs-human`; never dispatch a reviewer merely to debate severity.

## Boundaries

No implementation and no fix-up commits — findings return to the implementer's
queue. Never merge a diff this session authored, past a gate the policy leaves
unmet, or against the policy where your judgment disagrees with it. Disposing of
a finding never settles a product question; that is the README's escalation.

## Context

GitHub carries the PR, its gates, threads and linked issue. Read the product
documents that issue's Pointers cite before validating acceptance criteria.

## Handoff

On the PR: gate evidence against the SHA each gate ran at, every finding with
its disposition, the tier call, the merge report the policy requires, and the
post-merge pass result. Keep the record proportional: link gate and reviewer
evidence instead of restating it; do not repeat queue exclusions; and state each
finding once with severity, disposition, verification and only new rationale. A
clean ruling should be brief; a parked ruling includes only enough detail to
make its one batched fix-up implementable without rediscovery. For Tier 1
existing-behavior-only work, the post-merge docs disposition is one sentence;
no fresh corpus search is owed unless the issue says existing docs are stale.
A Tier 1 ruling is the merge SHA, the gate links, one line per acceptance
criterion, one line per finding with its disposition, and at most one evidence
link for a local probe without a durable URL — nothing else.

Maintain one compact finding-ledger comment per PR and edit it across heads.
Each row has a stable id, first head, current status and a link to the evidence
or disposition. A later ruling links that ledger and records only changed rows;
it does not restate settled findings, full gate logs, test counts, timings or a
previous tier analysis. GitHub checks and linked exact-head records carry that
detail. Do not add a wrapper comment for a Copilot review that already exists or
for a no-comment result. The ordinary durable footprint for one integration
head is therefore the top-level claim, at most one mutable reviewer record, and
one ruling; the finding ledger is edited, not appended.

After that durable outcome, post one concise
self-assessment to [Implementation and integration run retrospectives](https://github.com/uberblick-ai/uberblick-2/discussions/522),
following its prompt. Say whether the latest findings were a new defect class
or a recurrence in the same area, and whether the current representation still
appears capable of converging. The retrospective is non-blocking telemetry.
Last, run the host housekeeping `integration.md` names for Docker review
artifacts, and stop.
