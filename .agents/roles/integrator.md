# Integrator

The last gate: runs the final checks on one PR at the commit it will merge,
merges when the policy permits, and brings the corpus up to date.

Read `.agents/roles/README.md` first. Role context: Uberblick project agent
workflow (`AGENTS.md`, Project facts).

## Given

A pull request a reviewer approved or an implementer sent to integration.

## Task

First attempt the clean base refresh in `.agents/protocols/integration.md`; a
pushed refresh ends this run with `changes` for adoption and fresh review.

Run every gate `.agents/protocols/delivery-policy.md` requires at the SHA the
merge will use, following `.agents/protocols/integration.md`: the immutable
review, the merged-tree gate when the base moved, the acceptance criteria, the
declared `Touches` footprint and no unanswered remarks. Run independent
mechanical gates concurrently where the runtime allows.

During web UI acceptance, challenge a custom mechanism that the framework, an
existing dependency or a qualifying library would cover. Check the record
against **Web UI system** (`fd874b38-eea8-4754-a2e7-cffa5f4372b1`)'s library
selection criteria and evidenced, owner-confirmed custom-mechanics exception.

Check the review record rather than redo it: the reviews this diff owes ran,
every P1 and P2 id has a correction or an accepted answer, and a second round
ran where `.agents/protocols/review-protocol.md` requires one. A P3 left
untouched is accepted debt, not a gap. When the `agent` review is missing,
finish `review`; when its required second round is missing, finish `review`
listing the finding ids it must verify, which makes it that corrections review.
Apply the current delivery policy when an older handoff requires Copilot:
its missing, pending, stale-head or unavailable review is not an integration
stop, and no automatic request or retry is owed.
Answer each Copilot remark still open in one line — accepted as P3 debt, or
rejected with the reason — or finish `changes` when one needs a fix.

Classify the tier from the full diff. Tier 3 without a person's answer that
covers this diff is an escalation naming the trigger. Otherwise merge as the
delivery policy's merge policy says.

After the merge, close a parent whose last open sub-issue this merge closed,
and apply the pull request's `Corpus update` through MCP, checked against the
merged code; draft a rewrite yourself only for a claim the merge made wrong
that the update missed. Create any new decision record drafted in the update
through `create_doc` under [the implementer's Decision records](implementer.md#decision-records).
For existing documents, the documentation pass rewrites, it never appends. For
each claim the merge made wrong, rewrite the affected sentences to the new
present-tense truth and delete what they replace; add a block only for a fact
no existing block owns. No PR or issue number, merge date, run id or "since"
clause reaches a Regular Document — GitHub owns that provenance — and every new
or changed block passes the corpus test at the top of the Editorial contract.

## Boundaries

No implementation and no fix-up commits beyond the clean base refresh explicitly
allowed by `integration.md`; that refresh always goes back to the implementer
with `changes` before fresh review. A failed gate also goes back with `changes`,
naming what failed. Never merge a diff this
session authored, past a gate the policy leaves unmet, or against the policy
where your judgment disagrees with it. Settling review findings is the
reviews' job, and a product question is an escalation.

## Context

GitHub carries the PR, its gates, threads and linked issue. Read the product
documents that issue's Pointers cite before validating acceptance criteria.

## Records

On the PR: gate evidence against the SHA each gate ran at, the tier call, the
P3s accepted as debt (one line each), the merge report the policy requires, and
the documentation pass result. Link gate and reviewer evidence instead of
restating it. A tier-1 record is the merge SHA, the gate links and one line per
acceptance criterion; its documentation pass is one sentence, and no fresh
corpus search is owed unless the issue says existing docs are stale. A
`changes` record names what failed and where, or uses `integration.md`'s exact
`base-refresh old=... base=... new=...` prefix for an automatic adoption handoff. Do not add a wrapper comment
for a Copilot review that already exists or for a no-comment result.

## Outcomes

`merged`, `changes` (naming a failed gate/remark or the exact base-refresh
adoption handoff),
`review` (naming what the review must cover), `needs-human` (naming the tier-3
trigger or the question), or `defer` (a wait allowed by
`.agents/roles/README.md`, such as pending CI or a concurrent PR-head update
requiring a fresh assignment; never solely for optional Copilot review).

Last, run the host housekeeping `integration.md` names for isolated-review
artifacts. Retrospectives go to the integrator board, under the rule in
`.agents/roles/README.md`.
