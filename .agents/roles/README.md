# Role contracts

The Uberblick project uses six roles in its development cycle: `issue-preparer`,
`issue-adversary`, `implementer`, `implementation-reviewer`, `integrator` and
`program-coordinator`. Each file beside this one is one role's contract, with
thin adapters in `.claude/agents/` and `.codex/agents/` pointing back at it.

This file states what every role obeys, so no contract repeats it. Repository
policy — `AGENTS.md`, `CLAUDE.md`, `.github/ISSUE_SPEC.md` — wins on conflicts,
with one owner-authorized exception: a role posts its own claim, in the grammar
`.github/ISSUE_SPEC.md` defines, where `AGENTS.md` still assigns that claim to a
coordinator (owner correction on #467, 2026-08-29; `AGENTS.md` follows in its
own change). Installing these descriptions starts nothing, and merge authority
comes only from that policy. The role split's reasoning is Uberblick project
agent workflow (`c0bb016d-3d4c-4316-9b4e-da8a7b322e55`): contracts link it, none
restates it.

## One queue assignment, picked by the role

A launcher supplies two things and nothing else: your role, and your session or
run identity; missing either is a refusal, stated before any side effect. The
assignment is a *queue assignment* — claim and complete one eligible item for
this role under your contract's `Pickup` section. No preselected target exists.
The order is prepared (small tiers self-checked or singly challenged in that same
pass) → the adversary for a substantial one → `ready` (owner) → implemented, and a
`Pickup` ordering by `Priority` means the organization issue field, read as
`.github/ISSUE_SPEC.md`'s scheduling section defines: Urgent → High → Medium →
Low, and unset means untriaged and ineligible.

Bounded means one outcome and one stopping condition, not one attempt:
investigating and retrying inside it is the work, and an invocation may inspect,
or lose the race on, several candidates while performing the role on exactly one.
A resumed role has voided this contract; the next assignment starts fresh.

**The claim record.** The implementer claims in `.github/ISSUE_SPEC.md`'s grammar
(`Claimed: <branch>` / `Implementer: <opus|codex> <id>`); every other role posts a
comment whose first line is `Claim: <role> <session-or-run id>`, plus the head or
grounding SHA wherever the outcome is tied to one. A role's handoff comment opens
with `Done: <role> <session-or-run id>` and that same SHA where the claim carried
one: that line is what makes a claim consumed and a completion findable. An
issue-preparer's record adds a second line, `Tier: trivial|bounded|substantial —
<outcome>`, the outcome `cleared for ready`, `to the adversary`, `returned to
product interaction` or `round cap — to the owner`. Both live on GitHub, which
holds all execution state; recovery must be possible from it alone.

**The race rule.** A live claim by any role makes the item ineligible for every
other role. Re-read the candidate's thread immediately before writing the claim
and immediately after; the earliest valid claim wins, and a loser posts a one-line
withdrawal under its own claim and tries the next candidate in order. A claim is
stale — its item eligible again — under `AGENTS.md`'s three facts for an
implementation claim, and for every other role when that session left no
completion record and the claim is older than 30 minutes.

## Product context, proportional to the action

Current Uberblick context is required before a product-sensitive choice or a
judgment against product intent. If it is unavailable and proceeding could change
product meaning, stop and report what was needed and observed. Mechanical
inspection, validation and GitHub bookkeeping continue on their own inputs.

## Decide inside your authority, escalate beyond it

Make and record the decisions the issue, the program authorization, the adopted
principles and repository policy already cover; that is the work, not a shortcut
around it. Escalate when the work would materially change overall direction;
consequential web, CLI or MCP behavior; adopted product principles; external
guarantees or resources; or agent authority. Escalating means an open
`decision`-tagged Uberblick record — the question, the options weighed, the
reasoning, and the trigger that would revive an alternative, with no answer —
reported in the handoff. Then stop: the owner answers.

Delegating a bounded subtask is allowed and stays bounded; the delegating role
still owns the outcome and the durable record. A context reset never erases
authorship — the author of a diff is never its independent reviewer.
