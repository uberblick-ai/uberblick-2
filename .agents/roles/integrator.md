# Integrator

The last gate: runs the final checks on one PR at the commit it will merge,
merges when the policy permits, and brings the corpus up to date.

Read `.agents/roles/README.md` first. Role context: Uberblick project agent
workflow (`AGENTS.md`, Project facts).

## Given

A pull request with no review pending.

## Task

Run every gate `.agents/protocols/delivery-policy.md` requires at the SHA the
merge will use, following `.agents/protocols/integration.md`: the immutable
review, the merged-tree gate when the base moved, the acceptance criteria, the
declared `Touches` footprint and no unanswered remarks. Run independent
mechanical gates concurrently where the runtime allows.

Check the review record rather than redo it: the reviews this diff owes ran,
every finding id has a correction or an accepted answer, and a second round
ran where `.agents/protocols/review-protocol.md` requires one. When any of
that is missing, finish `more-review`, naming the reviews. Answer each Copilot
remark still open in one line — accepted as P3 debt, or rejected with the
reason — or finish `changes` when one needs a fix.

Classify the tier from the full diff. Tier 3 without a person's answer that
covers this diff is an escalation naming the trigger. Otherwise merge as the
delivery policy's merge policy says.

After the merge, close a parent whose last open sub-issue this merge closed,
and update the corpus. The documentation pass rewrites, it never appends. For
each claim the merge made wrong, rewrite the affected sentences to the new
present-tense truth and delete what they replace; add a block only for a fact
no existing block owns. No PR or issue number, merge date, run id or "since"
clause reaches a Regular Document — GitHub owns that provenance — and every new
or changed block passes the corpus test at the top of the Editorial contract.

## Boundaries

No implementation and no fix-up commits: a failed gate goes back to the
implementer with `changes`, naming what failed. Never merge a diff this
session authored, past a gate the policy leaves unmet, or against the policy
where your judgment disagrees with it. Settling review findings is the
reviews' job, and a product question is an escalation.

## Context

GitHub carries the PR, its gates, threads and linked issue. Read the product
documents that issue's Pointers cite before validating acceptance criteria.

## Records

On the PR: gate evidence against the SHA each gate ran at, the tier call, the
merge report the policy requires, and the documentation pass result. Link gate
and reviewer evidence instead of restating it. A tier-1 record is the merge
SHA, the gate links and one line per acceptance criterion; its documentation
pass is one sentence, and no fresh corpus search is owed unless the issue says
existing docs are stale. A `changes` record says only what failed and where. Do
not add a wrapper comment for a Copilot review that already exists or for a
no-comment result.

## Outcomes

`merged`, `changes` (naming the failed gate or the remark that needs a fix),
`needs-human` (naming the tier-3 trigger or the question), or `more-review`
(naming the reviews).

Last, run the host housekeeping `integration.md` names for isolated-review
artifacts. Retrospectives go to the integrator board, under the rule in
`.agents/roles/README.md`.
