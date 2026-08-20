---
name: next-issue
description: One iteration of the implementation loop — observe GitHub, advance open PRs through the gates, dispatch Opus sub-agents for eligible issues per .github/ISSUE_SPEC.md. Designed to be driven by /loop (e.g. `/loop /next-issue`); a single manual invocation runs exactly one iteration.
---

# next-issue — one iteration of the implementation loop

You are the coordinator (CLAUDE.md orchestration policy): you observe, decide,
validate, and merge — you never write feature code. All implementation happens
in Opus sub-agents. The issue contract is `.github/ISSUE_SPEC.md`; read it
before triaging — it is authoritative for the header grammar, labels, claim
protocol, scheduling semantics, and lint. This file does not restate it.

## Hard rules

- Dispatch implementation to Opus sub-agents: `model: opus`,
  `isolation: worktree`. Never edit feature code in the main checkout — it may
  hold the user's uncommitted work; worktrees only.
- The coordinator's own repo edits (skill or docs changes, commits) happen in
  the coordinator's own worktree too (EnterWorktree), never in the shared
  checkout — multiple sessions share it and it may sit on any branch. Even
  small doc/skill edits are dispatched to Opus sub-agents; the coordinator
  briefs, validates, and merges.
- Never commit to `main`. Code reaches `main` only through a PR that passed
  every gate.
- Bounce nonconforming input per the spec's lint; never fill gaps by guessing.
- Escalate genuine product decisions via the spec's `needs-decision` path
  (comment with concrete options + your recommendation), notify the user
  (PushNotification), then park the issue and move on — never block the loop
  on it.
- Edit issue/PR bodies only via `--body-file` with a file written by the Write
  tool. Never build the file with shell redirection (`>` — noclobber has
  silently emptied issue bodies before), and verify body length after editing.

## Iteration

1. **Observe.** `gh issue list --state open`, `gh pr list --state open`, and
   for each open PR its checks and reviews. Reconcile claims: apply the spec's
   stale-claim recovery rule.

2. **Advance open PRs first** — an open PR is closer to value than a new
   dispatch, and this includes PRs that predate the loop. For each, drive the
   CLAUDE.md gates in order:
   - `mise run test` and `mise run typecheck`, run in that PR's worktree;
   - your validation against every acceptance checkbox on the linked issue —
     check a box only with evidence (command output, test name);
   - footprint check: the diff stays within the issue's declared `Touches`;
   - GitHub Copilot review requested and returned;
   - local Codex review of the PR. Mechanism depends on the environment:
     when running under herdr (`test "${HERDR_ENV:-}" = 1`; use the herdr
     skill and `herdr agent` to find the Codex pane), talk to that Codex
     session directly and iterate — answer its findings, push fixes,
     re-request — until both sides are satisfied; otherwise use the codex
     plugin. Either way the review brief is the same:
     be critical, and hunt specifically for overtesting and overengineering
     per this repo's principles (KISS/YAGNI, least code wins, tests defend
     contracts and invariants — not implementation trivia).
   Triage findings: real ones become a fix-up brief for an Opus sub-agent on
   the branch; rejected ones get an explicit reply on the PR thread — never
   silent dismissal. **Final gate, immediately before merging:** re-fetch the
   PR's reviews and comment threads (`gh pr view <n> --comments` plus review
   threads via `gh api graphql` — inline review comments don't show in the
   former) and confirm zero unaddressed remarks, human or bot, including any
   that arrived after the earlier gates passed; anything open is triaged
   first. Then merge per CLAUDE.md's "Merge policy" tiers — Tier 1 and Tier 2
   self-merge as specified there (Tier 2 requires the merge-report comment on
   the PR first); Tier 3 triggers mean: label the PR `needs-human`, park it,
   and move on. After merging, confirm the issue auto-closed, then update the
   product docs to the new status quo (uberblick MCP tools once registered;
   until then, comment on the PR that the doc update is pending).

3. **Lint `ready` issues** against the spec's checklist. Failures: comment
   exactly what's missing, remove `ready`, skip.

4. **Compute the eligible set and order it** per the spec's scheduling
   semantics (deps closed, unclaimed; topology → Priority → number).

5. **Conflict analysis.** Apply the spec's `Touches` rules (schema serializes
   globally; disjoint parallelize; overlaps queue). Cap work in flight —
   claimed issues plus unmerged PRs — at 3: the bottleneck is the gates, not
   implementation.

6. **Dispatch.** For each issue to start: add `in-progress`, comment
   `Claimed: feat/<slug>` (or `fix/`). **Announce the work to the user** in
   your visible output: one or two plain sentences on what the issue is and
   why it's next, plus the direct GitHub URL (from
   `gh issue view <n> --json url`). Then spawn an Opus sub-agent whose
   brief is decision-complete: the full issue body; the Pointers resolved
   (read them yourself first, pass the relevant excerpts — the agent starts
   with zero session memory); the applicable CLAUDE.md invariants; and the
   contract: branch from fresh `main`, implement, `mise run test` +
   `mise run typecheck` green, push, open a PR with `Closes #N` and a body
   stating what changed and how it was verified. Sub-agents never merge.

7. **Report.** End with a short status a human can skim: PRs advanced (which
   gate), issues dispatched / bounced / parked, what the loop is waiting on.
   Every issue or PR named in the status carries its direct GitHub URL —
   the reader clicks through, never hunts.

## Pacing under /loop (dynamic mode)

- Running sub-agents and workflows re-invoke you when they finish — never
  schedule short wakeups to poll them. Long fallback: 1800s.
- Waiting only on an external signal (Copilot review, a human answering a
  `needs-decision`): ~600s.
- Nothing eligible and nothing in flight: 1800s with `noop: true`. Do not
  stop the loop yourself; the user stops it.
