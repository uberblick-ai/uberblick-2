# Issue preparation — ground, decide, recheck

Turn a confirmed intake into implementable work. `issue-shaping.md` owns user
intent and MVP boundaries; `.github/ISSUE_SPEC.md` owns the body, sizing and
lifecycle; `.agents/roles/issue-preparer.md` owns the run and handoff.
Preparation adds technical grounding, not unrequested product scope. Its review
does not replace implementation correctness review.

## Ground it at a commit

Read the issue, thread and prior handoffs first. A review verdict, first
implementer return, or human answer resumes existing preparation: refresh only
the disputed contract, affected evidence and upstream changes. Do not repeat
broad discovery or reclassify that work.

Fetch `origin/main` and record its SHA. Ground claims in that revision's code,
interfaces, invariants and tests. Read existing parent, milestone, requirement
and decision records where relevant; do not require new planning artifacts or
reopen settled intent. Verify shipped concepts against current code and agreed targets against
the corpus. Use closed history only when a pointer or missing
substrate makes it relevant; do not sweep closed-as-not-planned work.

For new preparation, scan the corpus catalog and select documents by their
descriptions and targeted search. Read relevant documents and governing links;
a catalog scan is not a content read. Put title, UUID and a short reading reason
in Pointers, without copying the source. Mark missing context honestly. A proven
mechanical correction with no governing product document may stop at the
catalog scan; explain why. Resumed work refreshes only affected sources.

Include relevant decisions in that reading guide, including open records the
implementation would build on: cite the topic and record UUIDs with the reading
reason. Read the topic's answer in force and pending records under **Decision
logs** (`b7fdc6d7-ce5c-4733-a083-3fc30196f0b3`); an open recommendation never
supplies the approved outcome required by ISSUE_SPEC. A challenge to a decided
record follows the successor and affected-work stop in the preparer's role.

Before drafting on every route, compare the likely footprint with the files in
all open PRs. Inspect overlapping diffs to distinguish a dependency, semantic
conflict or mechanical reconciliation. Use tracked-file searches; exclude copied
worktrees. Record material overlap and affected planned contracts in this issue's
Pointers, or a native blocked-by relationship for a real prerequisite; do not
edit the other issue.

Keep grounding proportional. If main advances, inspect changed paths and refresh
only affected evidence, including role or protocol files the run is following.
An unrelated merge does not invalidate prior review.

## Decide the work shape and route

Preserve the agreed useful outcome, constraints and non-goals. Resolve factual
uncertainty from evidence, leave ordinary engineering choices to implementation,
and escalate only unresolved human choices or the existing review limits.
Do not turn implementation preferences into requirements or enumerate every
edge case. An investigation names its decision, uncertain assumption and
confirming or refuting observation; a bounded negative result can complete it.
The eventual feature is not its deliverable.

Grounded dispositions include:

- **`wontfix`:** grounding shows only a low-impact theoretical finding and no
  current supported-usage failure. Record why delivery is disproportionate and
  close as not planned before route classification, without review. Never use this for data loss,
  auth/security exposure or a violated invariant. Concrete later evidence may
  justify reopening or a new issue.
- **`split`:** the request cannot fit one independently reviewable PR. Follow
  ISSUE_SPEC's sizing rule: substantial, independently useful pieces rather
  than tiny technical steps. Create native sub-issues with `needs-preparation`,
  the source milestone and only real ordering blockers. Keep the source open
  as their parent, blocked by each child so priority inherits. Product-changing
  decomposition requires a human decision.

For a new, unsplit issue that remains worth doing:

| Route | Condition | Outcome |
| --- | --- | --- |
| `trivial` | Mechanical, no behavior or contract choice, understood, local and easily reversed | Self-check, then `ready` |
| `challenged` | Every other combination | `review` |

Classify from evidence, not paths, labels or keywords; state the route reason
briefly. A spike has no automatic review exemption. A resumed pass uses the
existing classification and review evidence.

## Challenge and resume

On every route, challenge custom web UI mechanics against the framework,
existing dependencies and qualifying libraries. Read **Web UI system**
(`fd874b38-eea8-4754-a2e7-cffa5f4372b1`) for selection and the evidenced,
owner-confirmed exception; cite it rather than copying its policy.

A challenged issue receives one independently dispatched review on another
runtime under `.agents/roles/reviewer.md`. The reviewer reconstructs the contract
from GitHub and challenges wrong assumptions, missing outcomes or invariants,
unsafe or wasteful work shapes and conflicts with current work.

Findings are `correctable` when evidence or settled intent resolves them, or
`owner-boundary` for unresolved product/authority, safety or fundamentally unsafe
scope. The reviewer escalates owner boundaries itself. A clean review permits
`ready`; otherwise the preparer applies correctable findings, repeats affected
grounding and the final recheck, then finishes `ready`. Explain rejected findings.
If another review or a person's choice is needed to settle one, escalate; there
is no second preparation review.

The first consecutive implementer return resumes the same way. A second return
without an intervening human answer stops at `needs-human`; an answer resets
that count and resumes affected work. A newly exposed owner boundary escalates
immediately. Use the shared role rules for the focused question, options and
recommendation. There is no extra approval ceremony for already-authorized work.

## Recheck, then decide

Before finishing, fetch main again and refresh affected grounding; re-read the
issue, thread and review verdict. Fold material corrections into the body,
remove superseded wording and link decisions where traceability matters.

Check the final contract against ISSUE_SPEC: What describes the outcome,
acceptance criteria distinct observable guarantees, and Pointers useful sources
and non-obvious traps. Preserve constraints and failure boundaries that affect
what must be built. Remove discovery narration, copied corpus text, repeated
rationale and file inventories. Length follows the contract, not a word target.

Finish with the disposition above: `review` before a challenged issue's review,
`ready` when no findings remain or all correctable ones are applied, or
`needs-human` for an unresolved owner boundary or exhausted review/return limit.
A `wontfix` run closes the issue itself with `gh issue close <N> --reason
"not planned"`; the launcher only changes labels.

## Record once

The issue body is the final contract; the review verdict holds findings and
evidence; the handoff states the disposition and links the verdict. Say once
when all corrections are applied. Explain individual dispositions only when
not clear from those records, such as a rejected finding or unresolved choice.
Retain the role's handoff fields and route reason; do not copy the original
intake into a comment or narrate the run.

In preparer-authored prose, use a descriptive title alongside an issue number
in What, Why, Out of scope, human questions and handoffs. Machine-readable
records and reference lists retain their own grammar and bare identifiers.
