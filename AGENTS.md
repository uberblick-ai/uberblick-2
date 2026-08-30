# Agent-neutral development workflow

This is the canonical workflow shared by every implementer and coordinator,
regardless of agent or transport. Read [CLAUDE.md](CLAUDE.md) for the
repository's principles, invariants, validation commands, and merge tiers.
Read [.github/ISSUE_SPEC.md](.github/ISSUE_SPEC.md) for the issue grammar,
eligibility, scheduling, and footprint rules. Do not infer missing product
decisions from this file.

GitHub is the source of truth for coordination state. Claims, decisions,
handoffs, finding dispositions, and gate results are written there before a
transient notification announces them. Herdr is a doorbell for dispatch and
status only; interactive control traffic such as approval keystrokes or
`continue` carries no durable content and is exempt. Recovery must be possible
from GitHub alone, without terminal history or a local worktree.

## Claim and recovery

Implementation runs in one of two lanes: an isolated Opus sub-agent by
default, or a Codex session dispatched through Herdr. Either way the implementer
claims its own item: it adds `in-progress` and posts the claim defined by
`.github/ISSUE_SPEC.md`, recording the branch, implementer type, and implementer
session or agent id so reviewers can prove that they did not author the diff.
Who may claim what, in what order, and how competing claims resolve belong to
the role contracts in `.agents/roles/`; this file does not restate them.

A claim is the *end* of a pickup, not the start of it: before writing one, the
implementer grounds the issue against a recorded `origin/main` commit and
rechecks eligibility — including `.github/ISSUE_SPEC.md`'s reservation and
work-in-flight rules, whose recount can still turn a posted claim into a
withdrawal. Challenging the issue is not part of this lane; it happened in the
issue-preparer's own run, and `ready` is that verdict. Two consequences are
agent-neutral, because reclaimers and reviewers depend on them: a pickup that
stops before any repository edit never leaves an `in-progress` label behind, and
a top-level issue whose contract turns out to be stale, or to need a decision
only the owner can make, is returned instead of being implemented. The first
consecutive return since the latest owner answer gets one focused
`needs-preparation` repair that reuses prior grounding and challenge work. A
second goes to `needs-decision`; an immediate owner boundary may go there on the
first return. The exact record and label transitions live in
`.github/ISSUE_SPEC.md`.

An `in-progress` claim is stale and may be reclaimed only when all three facts
are true:

- no open PR exists for the named branch;
- no commit on that branch at `origin` is newer than the claim comment; and
- the claim comment is older than 30 minutes.

Local worktrees and panes are deliberately excluded because other sessions
cannot observe them. The grace period protects the interval between the claim
and the implementer's first push.

## Implementation

Treat the issue body and its comments as the authoritative requirements,
constraints, and acceptance criteria. Use your own engineering judgment for
implementation details, test names, and small design choices explicitly left
open. If the brief conflicts with the code, is unsafe, or requires unnecessary
complexity, stop and record the discrepancy on GitHub rather than silently
deviating.

For a newly claimed issue, start from fresh `origin/main` in an isolated
worktree. For a fix-up or handover, continue the claimed branch in a new
isolated worktree without rebasing or force-pushing. Never share another
agent's worktree. Only the current claim holder writes to a claimed branch. A
handover first records the new implementer in a claim. Keep the change inside
the issue's declared footprint and prefer the least code that defends the
contract. Add contract or invariant tests, not tests of implementation
trivia. Use the documented `mise` tasks proportionally while editing, then run
lint, typecheck and tests once against the final implementation head. Browser
or e2e coverage is required only where the issue has a browser-observable
outcome. The integrator, not the diff author, owns immutable review,
merge-tier classification, and final-head review routing.

Commit and push a feature branch, then open a PR against `main`. Its body is the
single durable outcome, verification, findings, and KISS/overtesting self-review
record and contains `Closes #N`. Before announcing completion, post the minimal
PR handoff `.github/ISSUE_SPEC.md` defines. Do not duplicate either record with
an issue completion comment. Never commit to `main` and never merge your own PR.

Where `CLAUDE.md` requires a local Codex review, the implementer opens the PR as
a draft and delegates one fresh independent critical review before handoff so it
can correct clear findings in the same run. The reviewer authors no diff and the
implementer makes no authoritative disposition; after any corrections the
integrator owns final-head review, gate evidence, and every disposition. The
exact delegation and convergence procedure lives in the role contracts and
`.claude/skills/next-issue/review-protocol.md`.

Only after that durable comment may the implementer notify the coordinator. A
Codex Herdr message carries the PR URL and exact head SHA; for an Opus
sub-agent, its return to the coordinator is that notification. Polling GitHub
is the fallback when the doorbell is unavailable.

## Review and coordination

The author of a diff never reviews it authoritatively. Use an independent
session and follow CLAUDE.md's gates and merge tiers. A mandatory Codex round
on a Codex-authored PR uses a different Codex session where one is available;
only otherwise use an independent Opus reviewer. Record the reviewing session
on the PR.

When CLAUDE.md's dual-challenge gate applies, the implementer owns the fresh
Codex challenge and the integrator owns a distinct Opus challenge. Both use the
`implementation-reviewer` role and write exact-head verdicts on the PR. The
integrator's own acceptance and gate validation, and a Copilot review, are
additional evidence rather than either required challenge.

Every role reconstructs claims and progress from GitHub and re-reads the issue
and PR threads before acting. The integrator records validation and finding
dispositions on the PR; merge authority comes from CLAUDE.md.
