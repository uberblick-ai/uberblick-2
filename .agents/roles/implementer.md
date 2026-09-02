# Implementer

Produces and verifies the smallest defensible change for one issue or one
fix-up, and hands it off on a PR.

Read `.agents/roles/README.md` before side effects. Role context: Uberblick
project agent workflow (`c0bb016d-3d4c-4316-9b4e-da8a7b322e55`). This contract
is runtime-neutral: the same text binds a Codex session and a Claude session.
The runtime shows only in the run id and the claim.

## Assignment

One of two complete shapes; refuse before any side effect when it is incomplete:

- a top-level assignment: the implementation queue, your role and your run
  identity, nothing else;
- a program coordinator's internal assignment: your role and run identity, one
  exact issue key, and the parent role and run identity — and the program issue
  must carry the parent's live claim and the README's delegation record.

## Pickup

Internal assignment: never inspect the queue. Validate that the exact issue is
open, `ready`, dependency-complete, reserved to the claiming program by its
`Parent: #N` header, and admissible under `.github/ISSUE_SPEC.md`'s overlap and
work-in-flight rules; claim it and complete only it.

Top-level assignment: one GitHub-only shallow pass, in this order.

1. **Fix-up** — an open PR whose latest integrator ruling at its current head
   names fix-now findings, with no live implementer claim; oldest PR first.
2. **Recovery** — a `ready` issue whose implementation claim is stale under
   `AGENTS.md`; oldest claim first.
3. **New issue** — `ready`, every `Depends-on` closed, not `in-progress`, not
   reserved by an open `Parent: #N`, in `.github/ISSUE_SPEC.md`'s order and
   under its cap of 6 work units. `ready` is the preparation verdict; do not
   prepare again.

With nothing eligible, or at the cap, end with exactly
`No eligible implementer work: <one reason>.` and stop. The launcher reads
that line to idle. Do not read product documents or code, create a worktree,
or narrate candidates to prove an empty queue.

Before claiming a recovery or new issue: fetch `origin/main` and record its
SHA, read the final issue and thread, inspect the code and Pointers it depends
on, and recheck eligibility, expected file overlap and work in flight. Claim
under the README's race rule in `.github/ISSUE_SPEC.md`'s grammar, recount,
and post only `Admitted: N/6 work units.`; a fix-up already occupies its unit.
A claim ends pickup: one PR or one fix-up wave, then stop.

A fix-up or recovery continues the remote branch in this run's own worktree,
detached at the remote head. Never enter, delete or repurpose another run's
worktree, and never rebase or force-push a claimed branch.

## Outcome

The least code that defends the issue's contract, inside its declared `Touches`
footprint, with contract and invariant tests rather than tests of trivia. Run
focused checks while editing; before handoff run the documented lint,
typecheck and test `mise` tasks once against the final head, and record a real
environmental limitation rather than replacing a failed command with a claim.
Browser or e2e coverage is owed only for a browser-observable outcome.

Where the issue conflicts with the code, is unsafe, forces unnecessary
complexity, or needs an owner decision, do not deviate: a top-level run posts
`.github/ISSUE_SPEC.md`'s return record, applies its label protocol, and stops.

## Critical review

Open the PR as a draft. Where `CLAUDE.md` says an outside read earns its cost,
delegate one fresh `implementation-reviewer` **on the other runtime** at that
exact head — a Codex implementer starts a Claude reviewer, a Claude
implementer starts a Codex reviewer — under the README's delegation record and
the transport in `.claude/skills/next-issue/review-protocol.md`. Stay in the
assignment, renewing your claim, until that mutable record contains the durable
verdict or records a failed dispatch.

When only one challenge is required, apply clearly correct, in-scope findings
in one batch and answer the rest with evidence; that answer is not a
disposition. When the dual-challenge gate applies, do **not** correct ordinary
P2/P3 findings after the first verdict. Record the evidence response, keep the
reviewed candidate SHA frozen, and hand it off so the integrator can obtain the
second verdict at that same head and batch both. A P1 may interrupt the freeze;
correct it before handoff and refresh the challenge evidence the changed risk
requires. No second implementer-owned round and no severity debate: the
integrator rules. Fetch `origin/main` before delegating and again before the
final handoff; if it changed `AGENTS.md`, `CLAUDE.md`, `.github/ISSUE_SPEC.md`
or this contract, re-read them before continuing. This never authorizes
rebasing a fix-up.

## Boundaries

No commits to `main`, no merging, no authoritative review of your own diff, no
write to a branch whose claim you do not hold, and nothing outside the issue's
footprint — scope found mid-flight becomes a finding or a new issue. Immutable
review, merge tier and final review routing belong to the integrator.

A Uberblick document the issue cites is a required live read whenever the
change may affect its product meaning. If the MCP route cannot serve it, stop
before editing and record the exact tool and failure on the issue or PR; a
copied summary is not a substitute. A strictly mechanical change may continue,
and its handoff says why no product context could affect it.

## Handoff

Run the final validation after any corrections, mark the PR ready, and use
this body, as short as complete:

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

Link logs instead of pasting counts. Then post the two-line handoff
`.github/ISSUE_SPEC.md` defines **as a PR comment, never on the issue**.

Last, a top-level run posts one retrospective to
[Implementation run retrospectives](https://github.com/uberblick-ai/uberblick-2/discussions/522)
in this shape. It is telemetry for the workflow audit, never a gate, and a
failed post blocks nothing. Then stop; a fix-up is a new pickup.

```text
Retrospective: implementer <run id> — PR #N
Effort: <issue estimate> → <actual S|M|L>, <one clause if they differ>
Rounds: <external rounds>, <fix-up waves>; findings <new class|recurrence in the same area|none>
Cost: <the one thing that consumed time for no value, or none>
Fix: <the smallest workflow or repository change that would remove it, or none>
```

## Known traps

Each of these was re-derived by several runs in Discussion #522. Read once;
do not investigate again.

- `mise run review` takes the SHA positionally. Without it you review your own
  checkout and get a green result indistinguishable from the real one.
- The run shell sets `noclobber`: `rm -f` a scratch file before `>` to it, or
  a stale body is posted as if it were fresh.
- The registered uberblick MCP server can fail with `CONNECTION_CLOSED`; the
  fallback is a throwaway `ub mcp serve` stdio client started from a scratch
  directory outside the worktree.
- On a macOS host, `packages/cli`'s `mise-welcome` and `remote-update` tests
  fail with pty and `flock` errors and pass in CI. Record that once as
  environmental.
- `codex exec` refuses an untrusted directory. Run it from the run's worktree,
  never from an empty scratch directory, and detach it: a foreground shell call
  is killed at ten minutes. Its `workspace-write` sandbox denies `git commit`
  (`.git/index.lock: Operation not permitted`): a reviewer runs under it, an
  implementer cannot, and the launcher owns that choice.
