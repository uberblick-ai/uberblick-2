# Issue shaping — intent to a focused intake

Use with a human for interactive exploration of ideas or refinement of existing
issues, including assigned ones; this grants no interactive authority to unattended
roles. Discussion may end without a write. [Preparation](issue-preparation.md) reuses settled intent
and owns technical grounding, acceptance criteria, dependencies and implementation-sized work.

## Narrow the intent

Identify the core problem and smallest useful outcome, separating essentials
from optional ambitions. Never invent intent. Use evidence for factual gaps and
ask one focused human question when the answer changes outcome, scope or tradeoff;
clear intent needs no questionnaire or repeated approval.

Treat suggested mechanisms as clues unless the human makes them binding.
Distinguish facts, human decisions and inferences; leave engineering choices to
preparation and implementation, without architecture, file lists or exhaustive
edge cases. Preserve requested behavior, safety and data-preservation guarantees.
During interactive exploration, actively propose smaller useful scopes and
meaningful alternative ways to achieve the goal, with their implications and
tradeoffs. Corpus or code evidence may support a materially different approach.
Help the human choose or refine the outcome; do not silently decide
or force options on already-clear intent. Unattended preparation uses
[human-decisions.md](human-decisions.md) for unresolved choices, without waiting
for live dialogue. Defer optional follow-ups without automatically filing them
or fragmenting cohesive work. Reopen settled choices
only for new evidence or changed direction, naming the conflict.

## Keep the effort oriented

**Discussion overview.** For larger discussions, keep the outcome, settled
decisions, open questions and deferred work compact; refresh on material change
or resumption, not every exchange. Small requests need none. Only when authorized,
preserve it as a short comment on the existing effort issue, linking decisions;
this grants no queue or relationship changes.

**Investigation.** A spike identifies its decision, uncertain assumption and
cheapest confirming or refuting observation. A bounded negative result can suffice;
the eventual feature is not its goal. Exploration is read-only; experiments need
applicable authorization.

## Confirm the scope and destination

Reflect the problem, useful outcome, measurable success where meaningful
(otherwise observable), essential constraints, deferred work and unresolved choices.

Writing requires explicit authorization for meaning and destination. Reuse prior
authorization: “file it” or “queue it for preparation” chooses an issue. Silence
or a request for more analysis is not approval. If undecided, offer:

- **Discuss with coworkers:** publish a draft requirement.
- **Create an intake:** file confirmed scope for a maintainer to start.

Do not choose from size or confidence, or repeat an answered menu. Neither path
authorizes `ready` or implementation. Read [requirement-resumption.md](requirement-resumption.md)
only for shared drafts or resumption by UUID.

## Record durable choices

Apply [delivery policy's when-to-record test](delivery-policy.md#decision-records).
Qualifying choices need decision records, not just issue text. Discover relevant
decision records and any governing lifecycle guidance by purpose under
[AGENTS.md](../../AGENTS.md#read-for-the-action); use installed MCP schemas for calls.
The meaning/destination authorization above applies. With the person present,
record their actual choice as `decided` through `create_doc` or `set_status`
with `answer: {who, when, where}`, not an agent stance; unanswered topics stay
`open` with a recommendation. Changes to decided records require an `open`
successor naming `supersedes`, effective only after recorded human approval.
Link the record from the intake instead of copying its reasoning; it grants no queue authority.

## Create a small intake

Use this minimal handoff:

```text
Title: <concise behavioral title>

Goal or problem:
<current problem and smallest useful outcome>

Evidence or example:
<success example, observation or reference; omit if absent>

Known constraints:
<essential behavior, trade-offs, scope boundaries and unresolved human choices;
omit if absent>
```

For issue creation, reuse any priority the human already stated; otherwise ask,
suggesting a value when useful. Never infer or choose priority for the human.

Create with `gh issue create --repo uberblick-ai/uberblick-2`. Posting as a
maintainer: add `--label needs-preparation`. Posting as `uberblick-agent`: add
no trigger label; ask the human to add `needs-preparation` from their account.
Add only the human-stated `priority:<value>`, recording that decision in a comment;
otherwise leave it unset. Tell the human to set Request Source `Human` in the sidebar.

Do not invent `Touches`, relationships, architecture, acceptance criteria,
Pointers or `ready`; preparation supplies the grounded contract under ISSUE_SPEC.
Stop after the authorized draft or intake. If creation is unavailable, return the
handoff, chosen destination and limitation to the coordinator; never claim creation,
preparation or readiness.
