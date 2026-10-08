# Role contracts

Read this core and your assigned role. Read a reference below only when its
condition applies, before taking the relevant action. Product intent lives in
the MCP corpus; local protocols own workflow; `AGENTS.md` routes authority and
required product context. [ISSUE_SPEC.md](../../.github/ISSUE_SPEC.md) owns the
issue contract and [delivery-policy.md](../protocols/delivery-policy.md) the gates.

## One run, one item, one outcome

ub-agents is the tool that selects work using priority and other scheduling
factors, launches delivery roles, and advances the workflow from their reported
outcomes. A run gets one assigned issue or pull request — for a pull request,
also its head — and works only that item. Roles do not select work or set its
priority; the human priority rule and shaping exception live in
[workflow.md](../protocols/workflow.md#priority).

End with exactly one outcome your role lists and a short handoff: what was
decided or changed, the grounding commit (or a role-defined not-started status),
and links to evidence. Carry what the
next run needs and nothing it can read from GitHub itself. `defer` reports a
retry with no label change. A private transcript is never a handoff: GitHub must
be sufficient for a fresh run to continue.

## Authority and independence

ub-agents moves workflow labels, posts handoffs and dispatches reviews. A role
never changes a workflow label on an existing item, posts a claim, or starts
the `agent` review itself. Within its role's permissions it writes the task's
products: issue bodies and relationships, commits and pull requests, findings,
the merge, corpus updates and new issues. Optional Copilot requests follow
delivery policy.

Preserve confirmed scope and essential guarantees. Unresolved intent or a product,
guarantee, resource or agent-authority choice beyond settled authorization needs
human clarification. Authoring formats and user-visible limits of durable content
are owner choices, except a
[visible edge case](../protocols/review-protocol.md#findings). Stop dependent work and continue independent work. Silence
and agent assertions are not approval; reuse settled human answers. Other
role-specific stops remain unchanged.

Only the integrator lands PRs; the implementer may merge the base into its branch
under its handoff rule. No run enables auto-merge, approves its own pull
request, changes branch protection or repository settings, pushes a tag or
publishes a release. A blocked operation is never worked around by copying
credentials, changing global settings or disabling commit signing: escalate or
defer with the evidence.

Delegating a bounded subtask is allowed; the delegating run still owns the
outcome and the record. A context reset never erases authorship: the author of
a change is never its independent reviewer.

## Headless Claude

Commands must match the allowlist literally: no shell expansion or loops, and
one plain command per call. Files are limited to the worktree and run scratch;
read corpus documents through MCP. Use the launcher's literal `report_command`
for its `report`, `read` and `retrospective` commands.

## Read for the action

| When | Read |
| --- | --- |
| Preparing an assigned issue, including clarity of scope and success | [issue-preparation.md](../protocols/issue-preparation.md) and [ISSUE_SPEC.md](../../.github/ISSUE_SPEC.md) |
| Interactively shaping an idea or choosing an intake destination | [issue-shaping.md](../protocols/issue-shaping.md) |
| Before posting a human question, applying a human answer or acting on a decided-record challenge | [human-decisions.md](../protocols/human-decisions.md) |
| Posting or updating a record, or creating scratch | [Run operations: records and scratch](../protocols/run-operations.md#posting-records-and-scratch) |
| Creating a follow-up issue found during a run | [Run operations: follow-up issues](../protocols/run-operations.md#follow-up-issues) |
| Starting or waiting on a process, including a background tool call | [Run operations: process ownership](../protocols/run-operations.md#every-process-a-run-starts-is-that-runs-to-end) |
| Working in a checkout or pushing a branch | [Run operations: worktrees](../protocols/run-operations.md#worktrees) |
| A run lost time, incurred rework or missed needed context, and the cause and preventive change can be named | [retrospectives.md](../protocols/retrospectives.md) to check the reporting threshold |
| Maintaining or diagnosing workflow transitions or scheduling | [workflow.md](../protocols/workflow.md) and [ub-agents.yaml](../../ub-agents.yaml) |
