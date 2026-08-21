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
   - resolve and record the PR's immutable `headRefOid`, fetch it, inspect that
     commit's `Dockerfile.review`, then run
     `REVIEW_SHA=<headRefOid> mise run review`; never treat tests from a mutable
     shared checkout as review evidence. Fetch the commit — never check the PR
     branch out to review it: `mise run review` reads its own task definition
     from the current working tree, and `git archive` only needs the object.
     For an older PR that predates
     `Dockerfile.review`, construct a temporary trusted Dockerfile from the
     toolchain declared at that SHA and still build from `git archive`;
   - never pass branch-owned Docker builds secrets, host mounts, privileged
     mode, or the Docker socket. Run the verification container without
     network. Keep the SHA-tagged image long enough for focused probes, then
     remove it when the PR is settled;
   - probe failure behavior when the change crosses persistence,
     startup/shutdown, networking, concurrency, or another stateful boundary;
     happy-path tests alone do not close those acceptance criteria;
   - record every gate result against the commit SHA it ran at — container
     review, CI, your acceptance validation, the Codex verdict, the Copilot
     state. Any new commit on the branch (fix-ups included) invalidates the
     test/typecheck and review evidence: re-run those gates at the new
     `headRefOid` rather than carrying an older verdict forward;
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
   first. Confirm the PR's base is `main` (`gh pr view <n> --json baseRefName`)
   — a stacked PR merges into its parent feature branch and silently orphans
   the reviewed work (this happened: #13 into feat/hub, re-landed as #25);
   retarget the PR to `main` (or merge the parent first) before merging.
   **Tier check, before any merge:** classify the PR against CLAUDE.md's
   "Merge policy" tiers by reading its full diff (`gh pr diff <n>`) and how
   its review findings were dispositioned — never from the issue's `Touches`.
   `--name-only` is just the pathname inventory, and it only catches the
   mechanical triggers (`schema`, `.github/`, `.claude/skills/`); the semantic
   ones live in the hunks — a `package.json` entry landing under
   `dependencies` rather than `devDependencies`, auth or token semantics
   changing inside otherwise ordinary code, a CLAUDE.md hunk in the
   decided-architecture or invariants sections, or this PR overruling a major
   Copilot/Codex finding. A tier-3 trigger means you do not merge: label the
   PR `needs-human`, comment which trigger fired, fire a PushNotification
   naming the PR and the trigger so the owner learns a merge decision awaits
   them, then park it and continue with the next PR or issue. Tier 1 and
   Tier 2 self-merge as specified there (Tier 2 requires the merge-report
   comment on the PR first).
   **Gate freshness, at merge time:** make the merge itself conditional on the
   recorded gate SHA — `gh pr merge <n> --match-head-commit <gate-sha> …` — so
   a commit landing after the last check fails the merge instead of riding
   stale evidence; comparing `gh pr view <n> --json headRefOid` beforehand is
   for your report, not the guarantee. Either way a mismatch returns to the
   gates: re-run them at the new head. After merging, confirm the issue
   auto-closed, then update the product docs to the new status quo (uberblick
   MCP tools once registered; until then, comment on the PR that the doc
   update is pending).
   **Dev stack, after every merge to `main`:** restart it so
   http://localhost:5173/ always serves the just-merged `main`. Killing a
   running dev server is sanctioned (owner directive) but bounded: terminate
   only the background hub/vite processes the loop itself recorded starting —
   never any other process — and confirm they exited, so their ports are free,
   before relaunching. Serve from your own worktree, never the shared checkout,
   which belongs to other sessions; the worktree must be clean (no uncommitted
   changes, no unpushed commits) — if it isn't, skip the restart and say so
   rather than serve something that isn't `main`. Then `git fetch origin main`,
   fast-forward to it, verify `HEAD` equals the fetched `origin/main`, start
   `mise run hub` and `mise run web` as background tasks, and confirm
   http://localhost:5173/ answers before you report the stack serving the new
   `main`. A fresh hub store is fine: replicas rehydrate it over sync.

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
  schedule short wakeups to poll them. Long fallback: 1200s.
- Waiting only on an external signal (Copilot review, a human answering a
  `needs-decision`): ~300s.
- Nothing eligible and nothing in flight: 300s with `noop: true` — the owner
  wants idle-time change detection at least every 5 minutes. Do not
  stop the loop yourself; the user stops it.
