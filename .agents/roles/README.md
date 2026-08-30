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
before side effects.

**An internal subagent is the one exception, and it is the same exception for
every delegating role** — issue-preparer to issue-adversary, integrator to
implementation-reviewer, program coordinator to implementer. The parent supplies
the child's role and run identity, the exact GitHub issue or PR key, and its own
run identity as parent; nothing else. The child reconstructs from GitHub, never
searches a queue and never acts on another item, and writes its durable result
there before the parent acts on it. It does not consume or release the parent's
claim, and a private transcript is never a handoff.

Before starting that child, the parent writes this assignment on the item it
holds:

```text
Delegated: <child role> <child run id>
Target: <issue|PR> #N
Parent: <parent role> <parent run id>
```

For a PR target the record also names `Head: <sha>`. The parent must hold the
live claim named by `Parent`; the child validates that claim, this delegation
record and every supplied value before its first side effect. A missing or
mismatched record is a refusal, not permission to fall back to the queue. The
child's own claim and `Done:` repeat the parent and exact target so recovery can
join the assignment to its outcome from GitHub alone.

The normal order is draft → one issue-preparer run (trivial self-check, otherwise
one fresh adversary) → `ready` or an owner boundary → implementation. Bounded
means one outcome and stopping condition, not one attempt: the preparer owns
correctable findings through its final handoff rather than opening another role
loop. A stopped process is never resumed: recovery starts a fresh assignment
from GitHub's durable state. The one preparation-specific reuse is an issue
returning from `needs-decision`: the fresh assignment reuses the previous
handoff, adversary verdict, question and owner answer, and rechecks only what
the answer or intervening upstream changes affected.

`Priority` means the organization issue field: Urgent → High → Medium → Low.
The product owner owns every explicit value; agents never write it. Unset is
ignored by preparation and sorts as Medium for implementation pickup.

**The claim record.** The implementer claims in `.github/ISSUE_SPEC.md`'s
grammar: `Claimed: <branch>` / `Implementer: <opus|codex> <id>`. Every other
role posts `Claim: <role> <session-or-run id>`, plus the grounding SHA when its
outcome is tied to one. A delegated subagent also posts `Parent: <parent role>
<run id>` — a comment record, distinct from the `Parent: #N` reservation header
`.github/ISSUE_SPEC.md` defines for an issue body. A handoff opens `Done: <role>
<session-or-run id>` with that grounding and parent where applicable. Handoffs
stay proportional: link evidence instead of narrating transcripts. GitHub must
be sufficient for recovery.

**The race rule.** A live top-level claim makes the item ineligible for every
other queue pickup. The one permitted nested claim is the subagent explicitly
delegated by the role that holds that item; it does not release the parent claim
or admit any other role. Re-read immediately before and after claiming; the
earliest valid claim wins, and a loser posts a one-line withdrawal and tries the
next candidate.

**Claims are ordered, and a live one is renewed.** Every claim, renewal,
withdrawal and takeover is ordered by its comment `createdAt`, and by the
immutable comment id where two share a timestamp. Ownership follows that order,
so a holder superseded by a valid takeover does not recover the item by writing
again: its own claim keeps the older position, and the later write is
recognisably stale rather than authoritative.

A live run renews by posting `Renewed: <role> <session-or-run id>` on the item
at least every 15 minutes, and staleness is measured from the holder's newest
claim-or-renewal comment rather than its first. A top-level claim other than an
implementation claim is stale when no completion exists and that newest comment
is more than 30 minutes old; the window is twice the renewal interval so that a
healthy foreground run is never reclaimed in the gap between two renewals.
Every implementation claim, top-level or delegated, uses `AGENTS.md`'s same
three facts, because branch ownership is not a timer. A parent may replace a
delegated implementer only after those facts make the claim stale and an
explicit handover records the new implementer; a newer remote branch commit
therefore prevents replacement even when no `Done:` exists after 30 minutes.

A nested **non-implementation** subagent claim with no matching `Done:` expires
after 30 minutes, even while its parent remains live; that same parent may then
launch one replacement. The unfinished attempt produced no verdict, so the
replacement is not a second adversary or review round.

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
