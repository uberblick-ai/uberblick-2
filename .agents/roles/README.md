# Role contracts

Shared identity, ownership and recovery for delivery roles. Read the assigned
role for pickup and action order; the issue schema lives in
`.github/ISSUE_SPEC.md`, and executable gates in
`.agents/protocols/delivery-policy.md`. Product intent and workflow reasoning
live in the MCP corpus. These are distinct authorities, not duplicate policies.

## One bounded assignment

An entry role receives its role and session or run identity, then self-picks one
eligible queue item under its `Pickup` section. Missing either is a refusal
before side effects.

**An internal subagent is the one exception** — the issue-preparer starting an
issue-adversary, and nothing else. Implementation review is not delegated: the
role that owes a round posts the durable request
`.agents/protocols/review-protocol.md` defines and an independently launched
`implementation-reviewer` claims it. The
parent supplies the child's role and run identity, the exact GitHub issue key,
and its own run identity as parent; nothing else. The child reconstructs
from GitHub, never searches a queue and never acts on another item, and writes
its durable result there before the parent acts on it. It does not consume or
release the parent's claim, and a private transcript is never a handoff.

Before starting an internal child, the parent writes this assignment on the
item it holds:

```text
Delegated: <child role> <child run id>
Status: pending
Target: issue #N
Parent: <parent role> <parent run id>
```

The parent must hold the
live claim named by `Parent`. The child validates that claim, that
the latest `Delegated:` record for its role and target names its run id, and
every supplied value before its first side effect. A missing or mismatched
record is a refusal, not permission to fall back to the queue.

The internal child is the `issue-adversary`; no role delegates an
implementation or a review. The delegation
comment is the child's one mutable lifecycle record: the child edits `Status: pending`
to `Status: running` before substantive work and to `Status: complete` when it
appends its grounded verdict. It posts no separate nested claim or `Done:`
comment. The parent edits the same record to `Status: failed — <reason>` when
the transport never starts or returns no verdict. This keeps assignment,
liveness, authorship lineage and outcome recoverable from GitHub without three
timeline comments for one read. The record's `created_at` orders competing
assignments; its `updated_at` is liveness; its final body is the handoff.

Each run uses fresh private scratch outside the worktree, namespaced by its run
id; never share it or treat it as durable state.

The normal order is draft → one issue-preparer run (route chosen by
`.agents/protocols/issue-preparation.md`) → `ready` or an owner boundary → implementation. Bounded
means one outcome and stopping condition, not one attempt: the preparer owns
correctable findings through its final handoff rather than opening another role
loop. A stopped process is never resumed: recovery starts a fresh assignment
from GitHub's durable state. The preparation-specific reuse is an issue
returning once from implementation or returning from `needs-decision`: the fresh
assignment reuses the previous handoff, adversary verdict, return evidence,
question and human answer as applicable, and rechecks only what those records or
intervening upstream changes affected. A second consecutive implementer return
without a human answer goes to `needs-decision`, not a new automatic
preparation pass.

Before creating a follow-up issue discovered during a run, fetch
the project's base ref and check the observation against that commit and existing open
issues. Do not queue work that the current base already resolved or already tracks.
Create it through `.github/ISSUE_SPEC.md`'s **Request source** path so its
provenance is set and read back without becoming a gate.

`Priority` means the organization issue field: Urgent → High → Medium → Low.
A human owns every explicit value; agents never write it. Unset is
ignored by preparation and sorts as Medium for implementation pickup.

**The claim record.** The implementer claims in `.github/ISSUE_SPEC.md`'s
grammar: `Claimed: <branch>` / `Implementer: <claude|codex> <id>`. Every
top-level role other than the implementer posts `Claim: <role> <session-or-run
id>`, plus the grounding SHA when its outcome is tied to one; an
`implementation-reviewer` claims one review request that way, naming the head
and request `.agents/protocols/review-protocol.md` requires. (The `Parent:`
line of a delegation record names a role and run id; the `Parent: #N` split
header `.github/ISSUE_SPEC.md` defines for an issue body is a different record
in a different place.) A top-level handoff opens `Done: <role>
<session-or-run id>` with that grounding. Internal children use the single
mutable delegation record above instead. Handoffs stay proportional: link evidence
instead of narrating transcripts. GitHub must be sufficient for recovery.

**Durable records.** Post comment bodies from files (`gh ... --body-file`),
and update a mutable record by its immutable comment id (`gh api ... -F
body=@<file>`), never "edit last". Preserve literal text and newlines. Confirm
scratch-file writes succeeded before posting; noclobber can leave stale content.

**The race rule.** A live top-level claim makes the item ineligible for every
other queue pickup. An internal child's mutable assignment record is its
ownership record; it neither releases the parent claim nor admits another
role. Re-read immediately before and after a claim;
the earliest valid claim wins, and a loser posts a one-line withdrawal and
tries the next candidate.

Before that race, do only the grounding and safety checks the selected role
explicitly requires. Run no delivery gate and write no explanation of derived
queue state or skipped candidates. A claim records ownership and the minimum
proof another role needs; evidence and decisions follow only after the claim
wins.

**Claims are ordered, and a live one is renewed.** Every claim, withdrawal and
takeover is ordered by its comment `createdAt`, and by the immutable comment id
where two share a timestamp. Ownership follows that order,
so a holder superseded by a valid takeover does not recover the item by writing
again: its own claim keeps the older position, and the later write is
recognisably stale rather than authoritative.

A live run renews by **editing its own claim comment**, never by posting another
one: touch the body so the comment's `updated_at` moves, appending or replacing a
single `Renewed: <UTC timestamp>` line. Do not renew before that `updated_at` is
25 minutes old; renew before it reaches 30 minutes.

A top-level claim other than an implementation claim is stale when no completion
exists and its claim comment's `updated_at` is more than 60 minutes old; the
window is twice the renewal interval so that a healthy foreground run is never
reclaimed in the gap between two renewals.
An implementation claim is stale when no matching later implementer Done
exists and the claim's updated_at is more than 30 minutes old. A later valid
claim takes over a stale one and continues the current
remote branch head; the superseded holder stops if it resumes.

A nested adversary assignment expires when its record remains
`pending` for 10 minutes, when a `running` record's `updated_at` is more than 30
minutes old, or immediately when the runtime confirms it stopped without a
verdict. The same live parent marks that record failed and may then delegate
one replacement; the latest-record check makes a late child refuse. A live
child may renew by editing its record under the same 25/30-minute cadence as a
claim. An unfinished attempt produced no verdict, so replacement is not a
second adversary round.

## Every process a run starts is that run's to end

A run owns each process it spawns on the host — a browser, a load or timing
probe, a server, a watcher — until that process exits. Start one in the
foreground of a script under a cleanup trap so that an interrupted run still
tears it down, and give it its own deadline (a `timeout`, or the tool's own
equivalent) so it dies on its own clock rather than waiting on a parent that may
never return. Never disown a process to make it someone else's problem.
A trap only runs between commands, so a loop that blocks in a foreground
`sleep` will not honour `SIGTERM` until that sleep ends: background the wait
and `wait` on it, or signal the process group, or the trap is decoration.

Where a helper must outlive a single foreground call — the claim renewer is the
standing example, because a foreground call is capped well below the renewal
interval — detaching it is correct, and two obligations come with it: the run
stops it by exact pid before it finishes, and the helper carries a deadline of
its own so that a run which dies without stopping it cannot leave it running
indefinitely. A renewer that outlives its run is worse than none, because it
keeps an abandoned claim looking alive instead of letting it age into recovery.

## Product context, proportional to the action

Current corpus context is required before a product-sensitive choice or a
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

## Worktrees and completion

New implementation starts from the project's freshly fetched base ref in this run's own
isolated worktree. Recovery continues the current remote head without rebase or
force-push. Never share, delete or repurpose another run's worktree. Re-read
ownership before pushing and stop if a valid takeover superseded it. A pickup
that stops before editing must release any implementation claim it posted.
A stopped process resumes only as a fresh assignment from durable records.

Entry-role outcomes use their exact Worked, No eligible, or Blocked final line.
The launcher immediately relaunches after work, waits about 30 minutes after an
empty queue, and stops on permission/authentication blockage. An unrecognized
line is an unconfirmed outcome. GitHub remains the durable coordination record;
the launcher does not interpret claims or findings to choose work.
