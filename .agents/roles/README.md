# Role contracts

The delivery workflow has three continuous entry roles: `issue-preparer`,
`implementer` and `integrator`. They delegate the exact-key internal roles
`issue-adversary` and `implementation-reviewer`; `program-coordinator` is called
directly only for explicit program work. Each file beside this one is one
role's contract, with thin runtime adapters pointing back at it.

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
every delegating role** — issue-preparer to issue-adversary, implementer or
integrator to implementation-reviewer, program coordinator to implementer. The
parent supplies the child's role and run identity, the exact GitHub issue or PR
key, and its own run identity as parent; nothing else. The child reconstructs
from GitHub, never searches a queue and never acts on another item, and writes
its durable result there before the parent acts on it. It does not consume or
release the parent's claim, and a private transcript is never a handoff.

Before starting that child, the parent writes this assignment on the item it
holds:

```text
Delegated: <child role> <child run id>
Target: <issue|PR> #N
Parent: <parent role> <parent run id>
```

For a PR target the record also names `Head: <sha>`. The parent must hold the
live claim named by `Parent`; for an implementer's pre-handoff PR review, that
is its issue claim naming the PR branch. The child validates that claim, that
the latest `Delegated:` record for its role and target names its run id, and
every supplied value before its first side effect. A missing or mismatched
record is a refusal, not permission to fall back to the queue. The child's own
claim and `Done:` repeat the parent and exact target so recovery can join the
assignment to its outcome from GitHub alone.

Each run uses fresh private scratch outside the worktree, namespaced by its run
id; never share it or treat it as durable state.

The normal order is draft → one issue-preparer run (trivial self-check, otherwise
one fresh adversary) → `ready` or an owner boundary → implementation. Bounded
means one outcome and stopping condition, not one attempt: the preparer owns
correctable findings through its final handoff rather than opening another role
loop. A stopped process is never resumed: recovery starts a fresh assignment
from GitHub's durable state. The preparation-specific reuse is an issue
returning once from implementation or returning from `needs-decision`: the fresh
assignment reuses the previous handoff, adversary verdict, return evidence,
question and owner answer as applicable, and rechecks only what those records or
intervening upstream changes affected. A second consecutive implementer return
without an owner answer goes to `needs-decision`, not a new automatic
preparation pass.

Before creating a follow-up issue discovered during a run, fetch
`origin/main` and check the observation against that commit and existing open
issues. Do not queue work that current main already resolved or already tracks.

`Priority` means the organization issue field: Urgent → High → Medium → Low.
The product owner owns every explicit value; agents never write it. Unset is
ignored by preparation and sorts as Low for implementation pickup.

**The claim record.** The implementer claims in `.github/ISSUE_SPEC.md`'s
grammar: `Claimed: <branch>` / `Implementer: <opus|codex> <id>`. Every other
role posts `Claim: <role> <session-or-run id>`, plus the grounding SHA when its
outcome is tied to one. A delegated subagent also posts `Parent: <parent role>
<run id>` — a comment record, distinct from the `Parent: #N` reservation header
`.github/ISSUE_SPEC.md` defines for an issue body. A handoff opens `Done: <role>
<session-or-run id>` with that grounding and parent where applicable. Handoffs
stay proportional: link evidence instead of narrating transcripts. GitHub must
be sufficient for recovery.

**A durable comment reaches GitHub as composed.** Every durable comment body —
claim, renewal, delegation, return, `Done:`, review round, dispatch failure,
finding disposition, merge report, retrospective reply — must land byte for
byte: line breaks intact, backticks and `$` literal. Write it into a file under
the run's own scratch directory, `<scratch>` here, and post that file; any
composition with that property is fine, and a quoted heredoc is one:

```sh
rm -f <scratch>/done.md
cat > <scratch>/done.md <<'EOF'
Done: issue-adversary <run id>
Outcome: correctable-findings — `readDecisions` already pins it; cost is $0.
EOF
gh issue comment <N> --body-file <scratch>/done.md
```

The `rm -f` is load-bearing: the run shell sets `noclobber`, so `>` onto a
file that already exists fails — and `gh` then posts the file's *previous*
body as if it were this one (observed 2026-08-31: a claim renewal carrying
the prior renewal's timestamp).

#491 lost a `Done:` to both at once: a shell expanded `` `ub --help` `` into the
verdict — as `--body "…"` and a bare `<<EOF` both do — and its line breaks
arrived as the two literal characters `\n`, which no shell had touched. A
garbled record survives only in the launching session's transcript, the private
channel every rule here exists to keep out of the record.

**The race rule.** A live top-level claim makes the item ineligible for every
other queue pickup. The one permitted nested claim is the subagent explicitly
delegated by the role that holds that item; it does not release the parent claim
or admit any other role. Re-read immediately before and after claiming; the
earliest valid claim wins, and a loser posts a one-line withdrawal and tries the
next candidate.

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

Editing rather than appending is what lets the two timestamps do two different
jobs. `created_at` never moves, so it keeps the holder's position in the claim
order above and a superseded holder still cannot write its way back to the
front. `updated_at` moves on every renewal and is the liveness signal. Both are
on the REST comment object, so a reclaimer reads them with no new machinery, and
GitHub's comment edit history keeps the renewals auditable. A renewal says only
"still here", so posting it as a comment buries the claim, the delegation
record, the gate evidence and the triage under records that carry nothing.

A top-level claim other than an implementation claim is stale when no completion
exists and its claim comment's `updated_at` is more than 60 minutes old; the
window is twice the renewal interval so that a healthy foreground run is never
reclaimed in the gap between two renewals.
Every implementation claim, top-level or delegated, uses `AGENTS.md`'s
30-minute durable-liveness rule. A later valid claim takes over a stale one and
continues the current remote branch head; the superseded holder stops if it
resumes. A parent replaces a stale delegated implementer the same way.

A nested **non-implementation** assignment expires with no claim 10 minutes
after `Delegated:` (or immediately when the runtime confirms it never started),
or with no matching `Done:` 30 minutes after its claim. The same live parent may
then delegate one replacement; the latest-record check makes a late child
refuse. An unfinished attempt produced no verdict, so replacement is not a
second adversary or review round.

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
