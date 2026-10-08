# Issue preparation — clarify, ground, decide, recheck

[issue-preparer.md](../roles/issue-preparer.md) owns the role and handoff;
[ISSUE_SPEC.md](../../.github/ISSUE_SPEC.md) owns the issue contract.

## Clarify intent and success

1. **Understand.** Read the issue, discussion, decisions and handoffs against
   relevant live corpus documents, the primary product-intent authority.
   Follow [source authority](../../AGENTS.md#find-the-right-authority) and
   [discovery/read rules](../../AGENTS.md#read-for-the-action), including in-force
   and pending decisions. Code establishes implemented behavior, not product intent.
   Catalog-only treatment requires intent established by authoritative sources or
   an explicit human decision, no governing product document, and a mechanical
   correction preserving that intent; explain why.
2. **Define success.** Set the smallest useful scope and measurable or observable
   success. Within delegated choices, choose the narrowest solution; widen only
   for evidenced necessity, such as an inseparable guarantee. Exclude optional
   extras. Preserve explicit requested outcomes unless settled owner authorization
   permits deferral or removal; another issue alone is not that authorization.
   Cite agreed allocation and retain real prerequisites when avoiding duplicate work.
3. **Resolve.** Resolve factual gaps from evidence; never invent intent or treat
   silence, agent assertions or an invitation to object as approval. Reuse settled
   authorization regardless of issue origin. If intake and live corpus already
   expose an owner choice affecting scope, split or criteria, ask under
   [human-decisions.md](human-decisions.md) before drafting the dependent contract.
   Stop dependent work, continue independent work and gather evidence needed for
   the question; code grounding may reveal further questions later. Missing
   required context is not waived. Ask only about unresolved choices or new conflicts.
4. **Record.** Put the outcome and pointers in the issue under
   [ISSUE_SPEC](../../.github/ISSUE_SPEC.md#body-sections). Cite sources with short
   reading reasons, including relevant decision topic/record UUIDs and open records
   implementation would build on; do not copy their content.

## Ground it at a commit

When code grounding begins, fetch `origin/main` and record its exact SHA. Ground
relevant claims in that revision's code, interfaces, invariants and tests; retain
evidence pointers so an implementer can compare its later baseline.

`ready`, `review`, `split` and `wontfix` require completed code grounding at a
recorded `origin/main` SHA. `not-started` is only for a clarification
`needs-human` stop before grounding.

Record discovered semantic prerequisites — functionality supplied by another
issue — using [native relationships](../../.github/ISSUE_SPEC.md#relationships).
Record a discovered open PR that edits the same files in Pointers and finish
normally; the implementer builds alongside it under
[scheduling semantics](workflow.md#scheduling-semantics). Invent no dependency,
scan no further and leave the other issue unedited.

A prerequisite may live in another repository. GitHub accepts only issues as
blockers, in any repository, and ub-agents waits on open blockers from other
repositories. When the issue input names a blocker issue, or one is readable
through the launcher, link it on the assigned issue with
`gh issue edit <assigned issue> --add-blocked-by <blocker issue URL>` under
[native relationships](../../.github/ISSUE_SPEC.md#relationships) and finish
preparation normally. Edit no other issue or pull request. When the
prerequisite is only a pull request with no issue, or the link is refused, stop
with `needs-human` and ask a maintainer to link a blocker issue, naming the
prerequisite.

Keep investigation proportional. On resumption or relevant main changes, refresh
only affected evidence, corpus sources and governing instructions; expand discovery
only for newly exposed gaps. Do not require new planning artifacts. An unrelated
merge does not invalidate prior review.

## Decide the work shape and route

Leave ordinary engineering choices to implementation; do not prescribe preferences
or exhaustive edge cases. A [visible edge case](review-protocol.md#findings)
becomes a known limit, not a question. An investigation names its decision,
uncertain assumption and confirming or refuting observation. A bounded negative result may complete it;
the eventual feature is not its deliverable.

On every route, apply [library and custom-mechanism choices](delivery-policy.md#library-and-custom-mechanism-choices).
Raise a needed protected dependency choice during preparation.

Set the existing `Effort` field to your best tentative XS/S/M/L/XL estimate using
[the field operation](run-operations.md#effort-field). Reassess on feedback and
returns; revise when expected work changes. Keep the estimate in the field, not
labels or body duplicates; invent no hours or numeric definitions. It makes
estimates assessable, grants no priority authority and never alone waives review.

- **`wontfix`:** only a low-impact theoretical finding with no current supported-usage
  failure, where delivery is disproportionate. Record why and close as not planned
  before classification, without review. Never use for data loss, auth/security
  exposure or a violated invariant. Concrete later evidence can justify reopening
  or a new issue.
- **`split`:** work cannot fit one independently reviewable PR. Follow
  [ISSUE_SPEC's sizing](../../.github/ISSUE_SPEC.md#sizing): substantial independent
  pieces, not tiny technical steps. Create unlabelled native sub-issues with the
  source milestone and only real ordering blockers; a maintainer starts each with
  `needs-preparation`. Keep the source open as their parent, blocked by each child
  so priority inherits. Product-changing decomposition needs a human decision.

For new, unsplit work worth doing:

| Route | Condition | Outcome |
| --- | --- | --- |
| `self-check` | Small, bounded, low-risk, well-understood corrections or product improvements within established intent, with clear success criteria and no unresolved scope or authority choice | Self-check, then `ready` |
| `challenged` | All other work without an unresolved human choice | `review` |

State the evidence-based route reason; size, paths, labels and keywords do not
decide it. Spikes have no automatic exemption. Self-check skips only issue review;
PR reviews, gates and merge rules remain under [delivery-policy.md](delivery-policy.md).

## Challenge and resume

1. **Review.** A challenged issue receives one independently dispatched review on
   another runtime under
   [the issue-review contract](issue-review.md#reviewing-an-issue-contract),
   including finding classification and reviewer escalation of owner boundaries.
   A clean review permits `ready`; no second preparation review.
2. **Correct.** Apply correctable findings, refresh affected grounding and perform
   the final recheck, then finish `ready`. Explain rejected findings. A disagreement
   needing another review or human choice uses [human-decisions.md](human-decisions.md).
3. **Resume.** A review verdict, first consecutive implementer return or human
   answer resumes existing preparation under the grounding refresh rule. Reuse
   completed classification and review evidence; perform grounding/classification
   not yet done after an early clarification pause. A second consecutive return
   without an intervening human answer finishes `needs-human`; an answer resets
   the count. New owner boundaries escalate immediately.

## Recheck, then decide

1. Reconcile the body with the latest discussion, human decisions and review.
   Apply corrections and remove superseded wording under
   [body-focus rules](../../.github/ISSUE_SPEC.md#body-focus-and-what-a-body-is-for),
   retaining essential constraints, failure boundaries and decision links.
2. If code grounding began, fetch `origin/main`, refresh affected evidence and
   record the exact revision verified under [grounding](#ground-it-at-a-commit).
3. Check the final issue against [ISSUE_SPEC](../../.github/ISSUE_SPEC.md), including
   substantive cleanup. Use the route and review/resumption rules above to finish.

## Record once

The body is the final contract; the review verdict holds findings and evidence.
The handoff uses the role's fields, states disposition and route reason, and links
existing evidence. Say once when corrections are complete; explain rejected
findings or unresolved choices, without repeating the intake or narrating the run.

Use descriptive titles with issue numbers in What, Why, Out of scope, human
questions and handoffs. Machine records and reference lists keep their own grammar.
