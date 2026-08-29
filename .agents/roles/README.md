# Role contracts

The Uberblick project uses six roles in its development cycle: `issue-preparer`,
`issue-adversary`, `implementer`, `implementation-reviewer`, `integrator` and
`program-coordinator`. Each file beside this one is one role's contract, with
thin adapters in `.claude/agents/` and `.codex/agents/` pointing back at it.

This file states what every role obeys, so no contract repeats it. Repository
policy — `AGENTS.md`, `CLAUDE.md`, `.github/ISSUE_SPEC.md` — wins on conflicts,
with the owner-authorized exceptions recorded here: each role posts its own
claim, and an issue-preparer may grant `ready` after the one-pass clearance its
contract defines (owner corrections on #467 and #477, 2026-08-29). Installing
these descriptions starts nothing, and merge authority still comes only from
repository policy. The role split's reasoning is Uberblick project agent
workflow (`c0bb016d-3d4c-4316-9b4e-da8a7b322e55`).

## One bounded assignment

An entry role receives its role and session or run identity, then self-picks one
eligible queue item under its `Pickup` section. Missing either is a refusal
before side effects. The preparation exception is explicit: an issue-preparer
supplies its fresh issue-adversary subagent the exact issue and parent run id,
because that adversary is an internal challenge, not another queue pickup.

The normal order is draft → one issue-preparer run (trivial self-check, otherwise
one fresh adversary) → `ready` or an owner boundary → implementation. Bounded
means one outcome and stopping condition, not one attempt: the preparer owns
correctable findings through its final handoff rather than opening another role
loop. A resumed role has voided this contract; recovery starts a fresh assignment
from GitHub's durable state. `Priority` means the organization issue field:
Urgent → High → Medium → Low; unset is ineligible.

**The claim record.** The implementer claims in `.github/ISSUE_SPEC.md`'s
grammar: `Claimed: <branch>` / `Implementer: <opus|codex> <id>`. Every other
role posts `Claim: <role> <session-or-run id>`, plus the grounding SHA when its
outcome is tied to one. The delegated adversary also posts `Parent:
issue-preparer <run id>`. A handoff opens `Done: <role> <session-or-run id>`
with that grounding and parent where applicable. Handoffs stay proportional:
link evidence instead of narrating transcripts. GitHub must be sufficient for
recovery.

**The race rule.** A live top-level claim makes the item ineligible for every
other queue pickup. The one permitted nested claim is the adversary explicitly
delegated by the preparer that holds that issue; it does not release the parent
claim or admit any other role. Re-read immediately before and after claiming;
the earliest valid claim wins, and a loser posts a one-line withdrawal and tries
the next candidate. A claim is stale under `AGENTS.md`'s three facts for an
implementation claim, and for other top-level roles when no completion exists
after 30 minutes. A live parent keeps its nested adversary assignment live.

## Product context, proportional to the action

Current Uberblick context is required before a product-sensitive choice or a
judgment against product intent. If it is unavailable and proceeding could change
product meaning, stop and report what was needed and observed. Mechanical
inspection, validation and GitHub bookkeeping continue on their own inputs.

## Decide inside your authority, escalate beyond it

Make and record decisions already covered by the issue, program authorization,
adopted principles and repository policy. Escalate when work would materially
change direction, consequential product behavior, adopted principles, external
guarantees or resources, or agent authority. For preparation, an unresolved
product, authority, safety, or fundamentally unsafe-shape finding is that stop;
correctable specification findings are not.

Delegating a bounded subtask is allowed and stays bounded; the delegating role
still owns the outcome and the durable record. A context reset never erases
authorship — the author of a diff is never its independent reviewer.
