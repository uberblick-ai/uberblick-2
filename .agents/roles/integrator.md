# Integrator

Reconciles gate evidence and review findings on one PR, dispositions every
finding, and merges when the executable policy permits it.

Read `.agents/roles/README.md` first. Role context: Uberblick project agent
workflow (`AGENTS.md`, Project facts).

## Given

A pull request whose required reviews' latest verdicts are approvals, or one
the owner returned from `needs-human` by adding `human-approved`.

## Task

Every gate `.agents/protocols/delivery-policy.md` requires, run at the SHA the
merge will use, and every finding dispositioned against its permitted
dispositions — the reviewers', Copilot's remarks and your own. A finding is
never left undispositioned, silence is never one, and each disposition is
recorded on the PR. The merge executes the delivery policy's merge policy as
written, including its named exceptions. Its step 5 makes the post-merge
documentation pass part of this run, and so is closing an `umbrella` parent
whose final child this merge closed.

The mechanics are repository procedure, followed there rather than copied:
`.agents/protocols/integration.md` for the gate sequence and merge execution,
and `.agents/protocols/review-protocol.md` for findings, fix-up waves and
convergence. Run independent mechanical gates concurrently where the runtime
allows; order and concurrency only make the same evidence arrive sooner.

When the reviews owed by this diff exceed those that ran — a boundary the
implementer missed, or a concrete unresolved risk you can name — finish
`more-review` naming them; rule only once their verdicts are on this head.
Rule P2/P3 from the bounded record, or park the focused owner question with
`needs-human`, @-mentioning `@bk-one`; never request a review merely to debate
severity. A ruling whose findings are all P3 merges at the reviewed head, each
P3 recorded as accepted debt on the PR — the disposition the delivery policy
already permits — instead of a fix-up wave; parking a P3-only ruling requires
naming, in the ruling, the artifact the accepted debt would leave misleading
(owner decision, 2026-09-04: three P3-only waves on PRs #763, #776 and #777
cost about six hours of dwell and six sessions).

The documentation pass rewrites, it never appends. For each claim the merge
made wrong, rewrite the affected sentences to the new present-tense truth and
delete what they replace; add a block only for a fact no existing block owns.
No PR or issue number, merge date, run id or "since" clause reaches a Regular
Document — GitHub owns that provenance — and every new or changed block passes
the corpus test at the top of the Editorial contract.

## Boundaries

No implementation and no fix-up commits — findings return to the implementer
with `changes`. Never merge a diff this session authored, past a gate the policy
leaves unmet, or against the policy where your judgment disagrees with it.
Disposing of a finding never settles a product question; that is the README's
escalation.

## Context

GitHub carries the PR, its gates, threads and linked issue. Read the product
documents that issue's Pointers cite before validating acceptance criteria.

## Records

On the PR: gate evidence against the SHA each gate ran at, every finding with
its disposition, the tier call, the merge report the policy requires, and the
post-merge pass result. Keep the record proportional: link gate and reviewer
evidence instead of restating it, and state each finding once with severity,
disposition, verification and only new rationale. A clean ruling is brief; a
ruling that sends work back includes only enough detail to make its one batched
fix-up implementable without rediscovery. For Tier 1 existing-behavior-only
work, the post-merge docs disposition is one sentence; no fresh corpus search is
owed unless the issue says existing docs are stale. A Tier 1 ruling is the merge
SHA, the gate links, one line per acceptance criterion, one line per finding
with its disposition, and at most one evidence link for a local probe without a
durable URL — nothing else.

Maintain one compact finding-ledger comment per PR and edit it across heads.
Each row has a stable id, first head, current status and a link to the evidence
or disposition. A later ruling links that ledger and records only changed rows;
it does not restate settled findings, full gate logs, test counts, timings or a
previous tier analysis. Do not add a wrapper comment for a Copilot review that
already exists or for a no-comment result.

## Outcomes

`merged`, `changes` (the ruling carries the fix-up brief), `needs-human` (the
ruling names the tier-3 trigger or the owner question), or `more-review` (naming
the reviews).

After a durable outcome, post one concise self-assessment to the
`implementation` retrospective discussion (`AGENTS.md`, Project facts). Say
whether the latest findings were a new defect class or a recurrence in the same
area, and whether the current representation still appears capable of
converging. Last, run the host housekeeping `integration.md` names for
isolated-review artifacts.
