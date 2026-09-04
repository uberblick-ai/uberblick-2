# Agent-neutral development workflow

This is the canonical workflow shared by every implementer lane, regardless of
agent or transport. Read [CLAUDE.md](CLAUDE.md) for the
repository's principles, invariants, validation commands, and merge tiers.
Read [.github/ISSUE_SPEC.md](.github/ISSUE_SPEC.md) for the issue grammar,
eligibility, scheduling, and footprint rules. Do not infer missing product
decisions from this file.

Before an issue enters that workflow, `.agents/protocols/issue-shaping.md`
governs conversation to a confirmed `needs-preparation` intake. The
issue-preparer role owns queue authority and side effects, while
`.agents/protocols/issue-preparation.md` owns its provider-neutral grounding,
challenge, and recheck procedure.

GitHub is the source of truth for coordination state. Claims, decisions,
handoffs, finding dispositions, and gate results are written there, and nothing
else announces them. Recovery must be possible from GitHub alone, without
terminal history or a local worktree.

## Claim and recovery

An implementer is one isolated session of either runtime — Codex by default,
Claude on request — started by the launcher. Either way it claims its own
item: it adds `in-progress` and posts the claim defined by
`.github/ISSUE_SPEC.md`, recording the branch, runtime, and run id so
reviewers can prove that they did not author the diff.
Who may claim what, in what order, and how competing claims resolve belong to
the role contracts in `.agents/roles/`; this file does not restate them.

A claim is the *end* of a pickup, not the start of it: before writing one, the
implementer grounds the issue against a recorded `origin/main` commit and
rechecks eligibility — including `.github/ISSUE_SPEC.md`'s work-in-flight
rule, whose recount can still turn a posted claim into a withdrawal. Challenging the issue is not part of this lane; it happened in the
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

An implementation claim is stale when no later matching implementer `Done:`
exists and its claim comment's `updated_at` is more than 30 minutes old. A live
run renews that comment as `.agents/roles/README.md` defines. An open PR or a
remote commit is recoverable branch state, not evidence that the claiming run
is still alive; a valid takeover continues from the current remote head.

Local worktrees and panes are deliberately excluded because other sessions
cannot observe them. The grace period protects startup, while renewal protects
longer work.

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
agent's worktree. Only the current claim holder writes to a claimed branch;
re-read ownership before pushing and stop if a valid takeover superseded you.
A handover first records the new implementer in a claim. Keep the change inside
the issue's declared footprint and prefer the least code that defends the
contract. Add contract or invariant tests, not tests of implementation trivia.
Use the documented `mise` tasks proportionally while editing, then run lint,
typecheck and tests once against the final implementation head. Browser or e2e
coverage is required only where the issue has a browser-observable outcome. The
integrator, not the diff author, owns immutable review, merge-tier
classification, and final-head review routing.

Commit and push a feature branch, then open a PR against `main`. Its body is the
single durable outcome, verification, findings, and KISS/overtesting self-review
record and contains `Closes #N`. Before announcing completion, post the minimal
PR handoff `.github/ISSUE_SPEC.md` defines. Do not duplicate either record with
an issue completion comment. Never commit to `main` and never merge your own PR.

Where `CLAUDE.md` requires a pre-handoff challenge, the implementer opens the
PR as a draft and delegates one fresh independent critical review on the other
runtime before handoff; CLAUDE.md's gate says when ordinary findings wait for
the integrator's second reviewer, and
`.claude/skills/next-issue/review-protocol.md` says how a round is requested
and how findings converge. The reviewer authors no diff and the implementer
makes no authoritative disposition; the integrator owns final-head review, gate
evidence, and every disposition.

That handoff comment is the completion signal. The launcher relaunches from
it, and the integrator's queue reads it there; no other notification exists.

## Review and coordination

The author of a diff never reviews it authoritatively. Every challenge runs on
a session that did not write the diff, follows CLAUDE.md's gates and merge
tiers, and records the reviewing run on the PR.

Independence follows the durable authoring session, not the fresh role run. A
Claude Agent child shares its launching Claude session's authorship identity.
Before an implementation reviewer marks its delegated record running, or an
integrator claims a PR, it checks commit `Claude-Session` trailers and the
linked claim/delegation records; if this session launched an implementer whose
commit remains in the head, the PR is ineligible for that session. A new run
id, context reset, or nested agent does not change that result.

How many challenges a diff owes, who owns each, and the candidate-head freeze
are CLAUDE.md's gate; the round procedure is
`.claude/skills/next-issue/review-protocol.md`. Non-implementation children use
the one mutable delegation record `.agents/roles/README.md` defines; they do
not add separate claim and completion comments.

Every role reconstructs claims and progress from GitHub and re-reads the issue
and PR threads before acting. The integrator records validation and finding
dispositions on the PR; merge authority comes from CLAUDE.md.

## Loop pacing

A loop that repeatedly launches a continuous entry role (issue-preparer,
implementer, integrator) through `ub launch` paces relaunch by the session's own
result, not a fixed interval. A
session that did work, or stopped on a recorded boundary, is followed by the
next fresh session at once. A session that ended with the exact line
`No eligible <role slug> work: <reason>.` is followed by an idle wait of about
30 minutes (owner direction, 2026-09-01), then a fresh session; every entry
role contract emits that line and nothing else on an empty queue. The loop may
run the over-inclusive `scripts/probe-work.sh <role>` first to skip a session
that could only end that way. The loop never selects, claims or transitions
work itself.

## Process changes

A change to `AGENTS.md`, `CLAUDE.md`, `.github/ISSUE_SPEC.md`, `.agents/` or
`.claude/` is a change to the rules every session runs under. An agent-authored
one is an ordinary PR through the queue, with one cross-runtime challenge.
Whoever lands one directly — the owner may — relabels every `ready` issue whose
body cites a file or section it moved or contradicted to `needs-preparation` in
the same push, with one comment naming the commit; a contract that goes stale
under a process commit is not the next implementer's to discover (owner
decision, 2026-09-02, after #587 and #598).
