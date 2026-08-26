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
default, or a Codex session dispatched through Herdr. Before prompting either
implementer, the coordinator adds `in-progress`
and posts the claim defined by `.github/ISSUE_SPEC.md`. It records the branch,
implementer type, and implementer session or agent id so reviewers can prove
that they did not author the diff.

An `in-progress` claim is stale and may be reclaimed only when all three facts
are true:

- no open PR exists for the named branch;
- no commit on that branch at `origin` is newer than the claim comment; and
- the claim comment is older than 30 minutes.

Local worktrees and panes are deliberately excluded because other sessions
cannot observe them. The grace period protects the interval between the
claim-before-prompt write and the implementer's first push.

## Implementation

Treat the issue body and coordinator comments as the authoritative
requirements, constraints, and acceptance criteria. Use your own engineering
judgment for
implementation details, test names, and small design choices explicitly left
open. If the brief conflicts with the code, is unsafe, or requires unnecessary
complexity, stop and record the discrepancy on GitHub rather than silently
deviating.

For a newly claimed issue, start from fresh `origin/main` in an isolated
worktree. For a fix-up or handover, continue the claimed branch in a new
isolated worktree without rebasing or force-pushing. Never share another
agent's worktree. Keep the change inside the issue's declared footprint and
prefer the least code that defends the contract. Add contract or invariant
tests, not tests of implementation trivia. Use the documented `mise` tasks for
the issue's validation, including lint, typecheck, and tests where applicable.

Commit and push a feature branch, then open a PR against `main` whose body
contains `Closes #N`, describes the change, and records validation. Never
commit to `main` and never merge your own PR.

Before announcing completion, post the PR handoff defined by
`.github/ISSUE_SPEC.md`, including its KISS/overtesting self-review.

Only after that durable comment may a Herdr notification carry the PR URL and
exact head SHA. Polling GitHub is the fallback when the doorbell is unavailable.

## Review and coordination

The author of a diff never reviews it authoritatively. Use an independent
session and follow CLAUDE.md's gates and merge tiers. When a mandatory Codex
round applies to a Codex-authored PR, use a different Codex session where one
is available; only otherwise use an independent Opus reviewer, and record the
reviewing session on the PR.

Coordinators advance open PRs before dispatching new issues, reconstruct
claims and progress from GitHub, and re-read the issue and PR threads before
every ruling. They record validation and finding dispositions on the PR; merge
authority
comes from CLAUDE.md.
