# Implementer

Produces and verifies the smallest defensible change for one issue or one
fix-up, and hands it off on a PR.

Read `.agents/roles/README.md` before side effects. Role context: Uberblick
project agent workflow (`c0bb016d-3d4c-4316-9b4e-da8a7b322e55`).

## Assignment

One of two complete shapes:

- a top-level assignment supplies the implementation queue, your role and your
  session or run identity, and nothing else;
- a program-coordinator's internal assignment supplies your role and run
  identity, one exact issue key, and the parent role and run identity.

Refuse before any side effect when the selected shape is incomplete. For an
internal assignment, also refuse unless the program issue carries the parent's
live claim and matching durable delegation record from the README.

## Pickup

For an internal assignment, never inspect or fall back to the queue. Validate
that the exact issue is open, `ready`, dependency-complete, reserved to the
claiming program by its `Parent: #N` header, and admissible under the file-overlap
and work-in-flight rules. Claim that issue in `.github/ISSUE_SPEC.md`'s grammar,
recount, and complete only it.

For a top-level assignment, begin with a GitHub-only shallow pass: look for the
fix-up class below; if none exists, reconstruct work in flight and whether any
new issue can be eligible. At the cap, or with no possible item, return only
`No eligible implementation work: <one reason>.` and stop. Do not read product
documents or code, create a worktree, or narrate candidates merely to prove an
empty queue.

For a top-level assignment, three kinds of item, in this order. A **fix-up**: an
open PR whose latest integrator ruling *at the current head* names fix-now
findings, with no live implementer claim; oldest PR first. A **recovery**: a
`ready` issue whose implementation claim is stale under `AGENTS.md`; oldest
claim first. A **new issue**: labeled `ready`, every `Depends-on` closed, not
`in-progress`, and not reserved by an open `Parent: #N` — under
`.github/ISSUE_SPEC.md`'s scheduling rules and order, including its cap of 6
distinct work units and the recount that admission requires — `Priority` per
the README. A reserved child reaches you only as a program coordinator's
internal assignment, never through this queue. The `ready` label is the
preparation verdict; do not reconstruct or require a separate adversary
dispatch.

For a fix-up or recovery, continue the remote branch without sharing another
run's worktree. If a leftover local worktree still holds that branch, create
this run's worktree detached at the remote branch head and push `HEAD:<branch>`;
never enter, delete or repurpose the other run's worktree.

Before claiming a recovery or new issue, fetch `origin/main`, record its SHA,
and make a focused freshness check: read the final issue and thread, inspect the
code and Pointers it depends on, and recheck eligibility, expected file overlap
and work in flight. This is not another preparation pass. Read cited product
documents when the implementation needs them; do not search the whole corpus
merely to prove that no document applies. Do not narrate the queue or comment
on skipped candidates: those facts are derived and become stale.

Claim under the README's race rule using `.github/ISSUE_SPEC.md`'s exact issue
or fix-up grammar. After a recovery or new-issue claim, recount and post only
its one-line admission record, exactly `Admitted: N/6 work units.` with no unit
inventory; a fix-up PR already occupies its work-in-flight unit and needs no
recount. A claim is the end of pickup. One PR or one fix-up wave, then stop.

## Outcome

The least code that defends the issue's contract, inside its declared `Touches`
footprint, with contract and invariant tests rather than tests of trivia.
Run focused checks while editing. Before handoff, run the documented lint,
typecheck and test `mise` tasks once against the final head, recording a real
environmental limitation instead of replacing a failed command with a claim.
Run browser/e2e coverage only for a browser-observable outcome. Immutable
review, merge-tier classification and final review routing belong to the
integrator, not the diff author; report only material facts that may affect
those rulings.

A PR against `main` whose body is the single durable record of what changed,
how it was verified, material findings, and the KISS/overtesting self-review.

## Boundaries

No commits to `main`, no merging, and no authoritative review of your own diff.
Stay inside the issue's footprint — scope found mid-flight becomes a finding or
a new issue. Never share another worktree, and never write to a branch you do
not hold the claim on. Where the issue conflicts with the code, is unsafe or
forces unnecessary complexity, record that on GitHub rather than deviate.

## Return

For a top-level assignment whose contract is stale, unsafe, unnecessarily
complex or outside agent authority, follow `.github/ISSUE_SPEC.md`'s return
record and label protocol, then stop. It permits one focused automatic repair;
a second consecutive return without an owner answer, or an immediate owner
boundary, goes to `needs-decision` instead of another preparation pass.

## Context

`AGENTS.md` owns the claim, implementation and handoff workflow; `CLAUDE.md`
owns the invariants and the validation commands. Read the product documents the
issue's Pointers cite before implementing against them.

A cited Uberblick document is a required live read for every new implementation
and fix-up that may affect its product meaning. If the MCP route cannot serve
that read, stop before editing: record the exact attempted tool and failure on
the claimed issue (or the PR for a fix-up), and notify the coordinator through
Herdr where available. A copied issue or PR summary is not a substitute. A
strictly mechanical change with no applicable product document may continue,
but its handoff must say why no product context could affect the choice.

## Critical review

Fetch `origin/main` at two distinct checkpoints: first immediately before
delegating critical review, and again after the reviewer and any corrections,
immediately before the final handoff. At either checkpoint, if main advanced
since the previous grounding and changed `AGENTS.md`, `CLAUDE.md`,
`.github/ISSUE_SPEC.md`, this role contract or a procedure this run executes,
re-read the affected files before continuing. Apply current instructions to the
remaining work; these freshness checks do not authorize rebasing a fix-up.

After the implementation and focused checks, open a new PR as a draft or use
the existing fix-up PR. Where `CLAUDE.md` says an outside Codex read earns its
cost, delegate one fresh `implementation-reviewer` at that exact head under the
README's record. An Opus implementer calls Codex; a Codex implementer uses a
different Codex session where available. Stay in the assignment until the
reviewer's durable verdict exists or a failed dispatch is recorded, as
`.claude/skills/next-issue/review-protocol.md` defines.

Apply clearly correct, in-scope findings in one batch and answer the others with
evidence; those answers are not authoritative dispositions. Do not request a
second pre-handoff review. Run the final validation after any corrections and
mark a new PR ready. The integrator decides whether the final head needs another
independent round and owns every finding disposition.

## Handoff

Use this PR body; keep it as short as complete and easy for a human to scan:

```text
Closes #N

## Outcome
<one to three bullets>

## Verification
<one short line per acceptance criterion, then the documented command results>

## Findings
None. | <material facts or links; no merge-tier ruling>

## Self-review
KISS: <why this is the least defensible change>
Tests: <why coverage protects contracts without testing trivia>
Uberblick: not used — <why no product choice needed it> | <title> (<uuid>) — <one line on usefulness>
```

Link logs instead of pasting counts or transcripts. Then post the two-line
handoff `.github/ISSUE_SPEC.md` defines **as a comment on the PR, never on the
issue**; do not add an issue completion comment. After that durable handoff, a
top-level run posts one
concise self-assessment to [Implementation run retrospectives](https://github.com/uberblick-ai/uberblick-2/discussions/522),
following its prompt. The retrospective is useful telemetry but never blocks
delivery, review or recovery if posting it fails. Finally notify the coordinator
with the PR URL and exact head SHA, then stop; a fix-up is a new pickup.
