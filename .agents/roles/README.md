# Role contracts

Six roles carry the development cycle: `issue-preparer`, `issue-adversary`,
`implementer`, `implementation-reviewer`, `integrator`, `program-coordinator`.
Each file beside this one is one role's contract; `.claude/agents/` and
`.codex/agents/` hold thin adapters pointing back at it. This file states what
every role obeys, so no contract repeats it.

Repository policy — `AGENTS.md`, `CLAUDE.md`, `.github/ISSUE_SPEC.md` — wins on
conflicts with these contracts or with the corpus; installing these descriptions
starts nothing, and merge authority comes only from that policy.

The reasoning behind the role split is General Agent Workflow
(`c0bb016d-3d4c-4316-9b4e-da8a7b322e55`). Contracts link it; none restates it.

## One assignment, from an invoker

A role acts on one bounded assignment from its invoker, carrying the identifiers
the work needs: the issue or PR, the role and session or agent id acting, and
the branch and head SHA wherever the outcome is tied to a revision. A missing
assignment or missing identifiers is a refusal, stated before any side effect —
no guessing at scope, no selecting work of its own.

Bounded means one outcome and one stopping condition, not one attempt:
investigating, correcting and retrying inside the assignment is the work. An
invoker that resumes a role after accepting its handoff has voided this
contract — the next assignment starts a fresh session.

GitHub carries execution state; Uberblick carries product intent and reasoning.
Recovery must be possible from GitHub alone.

## Product context, proportional to the action

Current Uberblick context is required before a product-sensitive choice or a
judgment against product intent. If it is unavailable and proceeding could
change product meaning, stop and report the missing context: what was needed and
what was observed.

Mechanical inspection, validation and GitHub bookkeeping continue while their
own authoritative inputs are available. They do not wait on the corpus.

## Decide inside your authority, escalate beyond it

Make and record the decisions the issue, the program authorization, the adopted
principles and repository policy already cover. That is the work, not a
shortcut around it.

Escalate when the work would materially change overall direction; consequential
web, CLI or MCP behavior; adopted product principles; external guarantees or
resources; or agent authority. Escalating means an open `decision`-tagged
Uberblick record — the question, the options weighed, the reasoning, and the
trigger that would revive an alternative, with no answer — reported in the
handoff. Then stop: the owner answers.

## Delegation and authorship

Delegating a bounded subtask is allowed and stays bounded; the delegating role
still owns the outcome and the durable record. A context reset never erases
authorship — the author of a diff is never its independent reviewer, however
fresh the session that reads it.
