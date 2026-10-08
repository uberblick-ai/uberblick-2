# Human decisions

Read when preparing a human question or resuming from a human answer. Scope
clarification and technical preparation stay in [issue-preparation.md](issue-preparation.md).

## Escalate what is not yours to decide

Decide what the issue, settled decisions, adopted principles and repository
policy already cover. Ask a person when the next step would change product
direction, an adopted principle or guarantee (a
[visible edge case](review-protocol.md#findings) aside), external resources or agent
authority; when the merge policy says tier 3; or when review stops converging.
Material ambiguity about intent, scope or success that evidence and settled
authorization cannot resolve also needs a person's answer.
A specification gap resolved by evidence or settled intent is correctable:
correct it.

For implementation within an already approved issue that meets an open
decision, follow [the implementer's bounded exception](../roles/implementer.md#build-on-an-open-decision).
All other boundary crossings follow the escalation rule here.

Distinguish maintainer decisions from inferences and cite settled authority once.
Authoring formats and user-visible limitations of durable content require a
maintainer decision, except a [visible edge case](review-protocol.md#findings); rendering mechanics remain engineering choices within existing
constraints. Before escalating replacement of an established primitive, identify
it and the contract it would supply; custom application rendering alone does not
establish such a replacement.

Finish `needs-human` with a scannable question before the evidence. Keep this
structure visible outside collapsed details:

- State what is blocked. Number each independent decision and letter its
  alternatives `A`, `B`, etc. Keep identifiers stable in follow-ups so answers
  such as `1A, 2B` suffice. Give implications, your recommendation and material
  risks/tradeoffs; aim for one or two plain-language sentences per decision
  without dropping essential information.
- @-mention the person who opened the issue (for a PR, its issue's opener) if
  they have write access; otherwise `@uberblick-ai/maintainers`. Never address
  the question to an agent or bot.
- Give one answer destination and one unambiguous next action:
  `Answer here, then remove needs-human and add <label>.`, with the label
  [Pause and resume](#pause-and-resume) names. Do not offer launcher-generated resume steps for the stopped role when a
  correction or handoff requires another role.

Put supporting technical evidence, commits, CI results and resume mechanics in
a collapsed `<details>` block with a descriptive `<summary>`, or link their
existing record. If the launcher flattens Markdown or the explanation is long,
post a structured decision comment and link the concise report summary's
invitation to answer to it. The summary must still name every independent
choice, recommendation and material risk; keep the prescribed closing line
visible in both records. This presentation changes no answer authority,
outcome or label rule.

Any person with write access may answer. A comment from a person's account is
the answer; one from `uberblick-agent` or a bot never is. The next run works
within it. An answer covers what it names, plus fix-ups that conform to it;
anything beyond that is a new question. An agent comment is evidence unless a
person explicitly adopts it from their own account.

## Challenge a decided record

Create an `open` successor through `create_doc`, with `supersedes` naming the
decided record and prose stating the challenge, evidence and recommendation.
Do not edit the decided record or work around it. Stop only work depending on
that decision until a person answers, and continue independent work. The prior
answer stays in force until the person approves a successor; read the live topic's
resolution and use the installed MCP schemas for the write.
This successor write is permitted for the issue preparer and implementer.

The preparer finishes `needs-human` if the challenge remains unresolved. The
implementer uses [its stop and independent-work handoff rule](../roles/implementer.md#build-on-an-open-decision):
`returned` on an issue, or independent work committed and pushed on the PR
before `needs-human`. Independent items continue in their own runs.

## Pause and resume

`needs-human` pauses the item: no run picks it up while the label is there.
The person who answers removes it and adds the label that should run next —
`needs-preparation` on an issue, `needs-changes` on a pull request — unless
the answer calls for another. A comment alone does not resume the run; roles do not change workflow
labels. The question and answer belong on the assigned GitHub item; the launcher
posts the handoff, or it links to the decision comment as described above.

Before posting a decision comment, use
[run-operations.md](run-operations.md#posting-records-and-scratch).
