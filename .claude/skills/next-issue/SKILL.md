---
name: next-issue
description: >-
  One Claude coordinator iteration: advance open PRs through the gates, then
  dispatch eligible issues through the agent-neutral AGENTS.md workflow.
  Designed for /loop; one manual invocation runs one iteration.
---

# next-issue — one iteration of the implementation loop

Read `AGENTS.md` for the shared agent-neutral claim, implementation, review, and
handoff workflow. Read `.github/ISSUE_SPEC.md` for issue grammar, labels,
scheduling, and lint. This file contains only Claude coordinator machinery and
does not restate either.

## Roles

This skill is the invoker: it reconstructs enough state to dispatch one fresh
role, then stops. The contracts live in `.agents/roles/` — `README.md` there
holds what every role obeys, and `.claude/agents/` and `.codex/agents/` expose
them to the two runtimes. Step 2 dispatches `integrator`, step 6
`issue-adversary`, step 7 `implementer`, and the external review round
`implementation-reviewer`; `program-coordinator` is the explicit exception, for
an outcome spanning several issues. Each brief carries the assignment, the
identifiers and a pointer to the mechanics — role behaviour lives in the
contracts and is not repeated here. Roles are invoked explicitly, never as a
side effect of being installed, and this file stays executable on its own.

## Hard rules

- **This file stays under 200 lines.** An addition pays with a deletion, or
  moves its detail to a companion file beside this one. The core is reloaded on
  every iteration, so length is a cost every rule in it pays.
- The coordinator's own repo edits (skill or docs changes, commits) happen in
  the coordinator's own worktree too (EnterWorktree), never in the shared
  checkout — multiple sessions share it and it may sit on any branch. Even
  small doc/skill edits are dispatched to an implementer agent; this session
  briefs and dispatches.
- Bounce nonconforming input per the spec's lint; never fill gaps by guessing.
- Escalate genuine product decisions via the spec's `needs-decision` path
  (comment with concrete options + your recommendation), notify the user
  (PushNotification), then park the issue and move on — never block the loop
  on it.
- Edit issue/PR bodies only via `--body-file` with a file written by the Write
  tool. Never build the file with shell redirection (`>` — noclobber has
  silently emptied issue bodies before), and verify body length after editing.

## Iteration

1. **Observe.** First, self-update the checkout: when it is on `main`,
   `git fetch origin main` and `git merge --ff-only origin/main` before
   anything else, so this session's next skill read, the issue spec, and the
   review-runner files all track current `main`. A refused fast-forward
   (conflicting local state, diverged history) is reported and skipped, never
   forced — continue the iteration as-is. Note the built-in lag: this
   invocation loaded its instructions before the pull, so a protocol change
   on `main` governs from the next invocation onward.
   Then `gh issue list --state open`, `gh pr list --state open`, and
   for each open PR its checks and reviews. Reconcile claims using the stale
   predicate in `AGENTS.md`.

2. **Advance open PRs first** — an open PR is closer to value than a new
   dispatch, and this includes PRs that predate the loop. For each, dispatch
   the `integrator` role as a sub-agent (adapter `.claude/agents/integrator.md`)
   with the PR URL, its immutable head SHA (`gh pr view <n> --json headRefOid`)
   and the assignment's identifiers. The brief cites `integration.md` beside
   this file for the gate sequence, the tier check and merge execution,
   `review-protocol.md` for a review round or a finding, and `dev-stack.md` for
   the post-merge restart — it does not restate them. The integrator records
   its ruling and evidence on the PR; that comment, not this session's memory,
   is the durable result.

3. **Lint `ready` issues** against the spec's checklist. Failures: comment
   exactly what's missing, remove `ready`, skip.

4. **Compute the eligible set and order it** per the spec's scheduling
   semantics (deps closed, unclaimed; topology → Priority → number).

5. **Conflict analysis.** Apply the spec's scheduling rules (schema serializes
   globally; expected file-level overlap decides, not the `Touches` sets). Cap
   work in flight — claimed issues plus unmerged PRs — at 6: the bottleneck is
   the gates, not implementation.

6. **Preflight — ground, classify, challenge, recheck.** Runs on every issue
   selected in step 5, after conflict analysis and *before* the claim.
   `preflight.md` beside this file is the whole procedure and both of its
   tables — read it on every iteration that reaches this step. Ground the issue
   at a recorded `origin/main` commit and classify its risk, or delegate that;
   the challenge itself is a dispatched `issue-adversary` whose brief carries
   the issue, that commit and the identifiers, and cites `preflight.md`. Then
   recheck eligibility and take the outcome off the lifecycle table.

7. **Dispatch.** Only issues step 6 returned as *dispatch* reach here; the
   others are already parked or requeued. For each, follow `AGENTS.md` for the
   claim, implementer brief, worktree, validation, PR, handoff, and
   notification contract. **Announce the work to the user** in your visible
   output: one or two plain sentences on what the issue is and why it is next,
   plus the direct GitHub URL (from `gh issue view <n> --json url`).

   Prompt the implementer named by the claim: spawn an Opus sub-agent in the
   `implementer` role (adapter `.claude/agents/implementer.md`) by default, or
   use the Herdr skill to dispatch a Codex session with the issue URL and the
   matching `.codex/agents/` adapter. The brief is decision-complete
   but pulled, not pushed: pass the full issue body and applicable CLAUDE.md
   invariants, and inline only what the uberblick MCP tools cannot serve — PR
   diffs, review threads, and decisions taken in this session. Where the MCP
   server is not registered, use the throwaway stdio-client pattern from #77
   and #134 in a scratch directory outside the committed worktree. The brief
   states which route applies.

   Several individually-trivial issues with the same `Touches` set may go to
   one agent only under the sizing exception in `.github/ISSUE_SPEC.md`; claim
   each separately and validate every issue independently.

8. **Report.** End with a short status a human can skim: PRs advanced (which
   gate), issues dispatched / bounced / parked, what the loop is waiting on.
   Every issue or PR named in the status carries its direct GitHub URL —
   the reader clicks through, never hunts. Until #130 lands, print each
   returning agent's uberblick-usage summary verbatim, so the owner watches
   the docs earn their keep from the console.

## Pacing under /loop (dynamic mode)

- Running sub-agents and workflows re-invoke you when they finish — never
  schedule short wakeups to poll them. Long fallback: 1200s.
- Waiting only on an external signal (Copilot review, a human answering a
  `needs-decision`): ~300s.
- Nothing eligible and nothing in flight: 300s with `noop: true` — the owner
  wants idle-time change detection at least every 5 minutes. Do not
  stop the loop yourself; the user stops it.
