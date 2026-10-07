# Delivery workflow transitions

Read when maintaining or diagnosing the delivery loop. Ordinary runs use their
assigned role's outcomes and the [shared core](../roles/README.md); they do not
need the complete transition map. [ub-agents.yaml](../../ub-agents.yaml)
declares transitions and queue policy for ub-agents to apply. This reference
also records actions and handoffs that label configuration alone cannot express.

ub-agents selects work using priority and other scheduling factors under
[the scheduling rules below](#scheduling-semantics), moves the labels,
posts the handoff, records which runtime did the work, and ensures only one run
holds an item at a time. The reviewer runs as two configured agents, one per
item kind, sharing [reviewer.md](../roles/reviewer.md), which routes each assignment
to only its applicable issue or PR review protocol.

## Transition map

Each role starts on its label: the preparer on `needs-preparation`, the
implementer on `ready` (an issue) or `needs-changes` (a pull request), the
reviewer on `needs-review`, the integrator on `ready-to-merge`. Every outcome
except `defer` removes that label and adds the next one:

| Role | Outcome | Label changes |
| --- | --- | --- |
| issue-preparer | `ready` | issue: `needs-preparation` → `ready` |
| issue-preparer | `review` | issue: `needs-preparation` → `needs-review` |
| issue-preparer | `split` | issue: `needs-preparation` removed; its sub-issues wait, unlabelled, for a maintainer to add `needs-preparation` |
| issue-preparer | `wontfix` | `needs-preparation` removed; the run has closed the issue as not planned |
| implementer | `review` | its pull request gets `needs-review`; the issue loses `ready`, or the pull request `needs-changes` |
| implementer | `integrate` | its pull request gets `ready-to-merge`; the issue loses `ready`, or the pull request `needs-changes` |
| implementer | `returned` | issue runs only: `ready` → `needs-preparation` |
| reviewer (issue) | `approve` | `needs-review` → `ready` |
| reviewer (issue) | `changes` | `needs-review` → `needs-preparation` |
| reviewer (pull request) | `approve` | `needs-review` → `ready-to-merge` |
| reviewer (pull request) | `changes` | `needs-review` → `needs-changes` |
| integrator | `merged` | pull request merged; `ready-to-merge` removed |
| integrator | `changes` | `ready-to-merge` → `needs-changes` |
| integrator | `review` | `ready-to-merge` → `needs-review` |
| any | `needs-human` | the role's label → `needs-human` |
| any | `defer` | reported as a retry, not an outcome: no label changes, and the item runs again later |

The pause, human answer and manual resumption route for `needs-human` lives in
[human-decisions.md](human-decisions.md#pause-and-resume).

## Scheduling semantics

Implementation eligibility requires `ready` and no open blocker. Blocking applies
at every stage: no preparation, review or implementation starts until blockers
close. Sub-issue status itself never affects eligibility.

Parallelism is judged at file level; overlapping `Touches` sets alone do not
serialize work, including `schema`. For expected semantic edits to the same
substantive files, the later implementer blocks its issue on the issue the open
PR closes and finishes `defer`. If the PR closes none, record the overlap in
Pointers and build without inventing a dependency; whichever lands second
merges the base. Bounded overlap in purely
additive aggregation surfaces (barrel exports, independent error collections)
is reconciled mechanically: after the earlier merge, the implementer uses a
non-rewriting merge when needed, and on integration pickup the integrator
attempts the clean base refresh in [integration.md](integration.md). Every owed
exact-head review and gate runs again after either update. Schema risk uses those reviews and gates, not package locks.

### Priority

Order eligible issues by effective priority, then oldest first. Labels rank
`priority:urgent`, `priority:high`, `priority:medium`, `priority:low`; unset sorts
as medium. Effective priority is the highest of an issue's own priority and
all open issues it blocks, transitively, including parents. With no priority
labels, order is oldest first. ub-agents computes this without writing labels.

People own priority labels; priority orders work, never admits it. Agents may
report ordering evidence but never choose a priority. The sole agent write is
[shaping](issue-shaping.md) recording the person's stated value with a provenance
comment (owner decision, 2026-09-07).

## Issue lifecycle

Unlabelled drafts and split parents run no role. A person or human intake starts
`needs-preparation`; run-created issues wait unlabelled for a maintainer, under
[follow-up operations](run-operations.md#follow-up-issues). `needs-review` means
prepared and awaiting the single issue review; `ready` asserts
[ISSUE_SPEC](../../.github/ISSUE_SPEC.md) compliance. People may grant `ready`;
role outcomes follow the transition map. `needs-human` parks a human question.

Blocked state derives from native relationships and issue closed-state; there
is no `blocked` label or redundant label for GitHub close reasons such as not
planned or duplicate. [Preparation](issue-preparation.md) owns `wontfix`, splits,
the final verdict, correctable review findings and
[return repair and escalation](issue-preparation.md#challenge-and-resume).
The [implementer](../roles/implementer.md#outcomes) owns the return-summary format.
[Shaping](issue-shaping.md) owns draft-versus-intake choice and requirement
resumption; neither exit grants `ready`.

## Parents and programs

A split source stays open outside the queues and is never `ready`. Children
inherit its milestone, use native sub-issue relationships and receive blockers
only for real ordering prerequisites; the parent is blocked by every child.
A maintainer starts children with `needs-preparation`. Only children carry
preparation or implementation queue labels, and the parent-to-child blocker
relationships propagate effective priority without label writes.

Each PR closes its child. The integrator whose merge closes the last open child
closes the parent in the post-merge pass. A program is a milestone plus its
parents; it uses ordinary queues and keeps decisions on the parent's thread.
Technical decomposition is preparer judgment; product choices beyond delegated
authority require a person. [Sizing](../../.github/ISSUE_SPEC.md#sizing) owns
when to split and the narrow batch exception.
