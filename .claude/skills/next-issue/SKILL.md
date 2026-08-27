---
name: next-issue
description: >-
  One Claude coordinator iteration: advance open PRs through the gates, then
  dispatch eligible issues through the agent-neutral AGENTS.md workflow.
  Designed for /loop; one manual invocation runs one iteration.
---

# next-issue — one iteration of the implementation loop

You are the coordinator (CLAUDE.md orchestration policy): you observe, decide,
validate, and merge — you never write feature code. All implementation happens
in an isolated implementer agent. Read `AGENTS.md` for the shared agent-neutral
claim, implementation, review, and handoff workflow. Read
`.github/ISSUE_SPEC.md` for issue grammar, labels, scheduling, and lint. This
file contains only Claude coordinator machinery and does not restate either.

## Hard rules

- **This file stays under 200 lines.** An addition pays with a deletion, or
  moves its detail to a companion file beside this one. The core is reloaded on
  every iteration, so length is a cost every rule in it pays.
- Apply `AGENTS.md` to every implementer lane and external review. The
  coordinator owns validation and rulings, not feature code.
- The coordinator's own repo edits (skill or docs changes, commits) happen in
  the coordinator's own worktree too (EnterWorktree), never in the shared
  checkout — multiple sessions share it and it may sit on any branch. Even
  small doc/skill edits are dispatched to an implementer agent; the coordinator
  briefs, validates, and merges.
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
   dispatch, and this includes PRs that predate the loop. CLAUDE.md's
   "Development workflow" owns *which* gates exist and when each applies, the
   Codex round included; drive them in the order it lists. This file owns only
   their mechanics:
   - resolve and record the PR's immutable `headRefOid`, fetch that commit, and
     run `REVIEW_SHA=<headRefOid> mise run review` — never check the PR branch
     out to review it, and never treat tests from a mutable shared checkout as
     review evidence. CLAUDE.md's review paragraph and README's "Review
     isolation" state what the runner refuses and why;
   - run the verification container without network, and pass it no secrets,
     host mounts, privileged mode or Docker socket. Keep the SHA-tagged image
     long enough for the failure-path probes CLAUDE.md requires at stateful
     boundaries, then remove it when the PR is settled;
   - record every gate result against the commit SHA it ran at — container
     review, CI, your acceptance validation, the Codex verdict where that gate
     applied, the Copilot state. Any new commit on the branch (fix-ups
     included) invalidates the test/typecheck and review evidence: re-run
     those gates at the new `headRefOid` rather than carrying an older verdict
     forward;
   - check an acceptance box on a linked issue only with evidence (command
     output, test name), and check that the diff stays within the declared
     `Touches` — the shared set when the PR closes a batch.
   **Re-read before ruling.** Immediately before any ruling — a triage
   disposition, an acceptance validation, a tier call, a merge — re-read the
   linked issue thread and the PR thread (`gh issue view <n> --comments`,
   `gh pr view <n> --comments`). Owner decisions and coordinator notes land
   there mid-flight; a ruling made from session memory can contradict one that
   was written down while you were elsewhere.
   **Findings.** `review-protocol.md` beside this file is the whole
   findings-conditional protocol — the external round's mechanism and brief,
   finding triage, the one batched fix-up wave per review head, risk-scoped
   re-review with the round-count rule, and the exit condition. Read it
   whenever a PR has a round to request or a finding to disposition.
   **Final gate, immediately before merging:** re-fetch the
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
   them, then park it and continue with the next PR or issue.
   **Exception — `human-approved`:** a PR carrying the owner-set
   `human-approved` label is merge-authorized: execute the merge as tier 2
   (merge report first), every other gate unchanged — evidence fresh at the
   exact merge head, zero unaddressed remarks. The label is the owner's act
   alone; never set it yourself, and never treat an owner comment as the
   label. Approval covers the PR's reviewed shape plus fix-ups and rebases;
   if later commits change the design beyond that, re-add `needs-human` with
   a comment naming the delta instead of merging. Tier 1 and
   Tier 2 self-merge as specified there (Tier 2 requires the merge-report
   comment on the PR first). Every merge report ends with two
   machine-readable lines — `findings_p1_p2_p3: <n>/<n>/<n>` and
   `deferred_findings: <issue refs or none>` — and only these two:
   timestamps, round counts and run counts stay derivable from the PR
   thread and are never restated (ISSUE_SPEC's derivability principle).
   **Gate freshness, at merge time:** make the merge itself conditional on the
   recorded gate SHA — `gh pr merge <n> --match-head-commit <gate-sha> …` — so
   a commit landing after the last check fails the merge instead of riding
   stale evidence; comparing `gh pr view <n> --json headRefOid` beforehand is
   for your report, not the guarantee. Either way a mismatch returns to the
   gates: re-run them at the new head. After merging, confirm every issue the
   PR closes auto-closed, then update the product docs to the new status quo
   (uberblick MCP tools once registered; until then, comment on the PR that
   the doc update is pending), and restart the dev stack per `dev-stack.md`.

3. **Lint `ready` issues** against the spec's checklist. Failures: comment
   exactly what's missing, remove `ready`, skip.

4. **Compute the eligible set and order it** per the spec's scheduling
   semantics (deps closed, unclaimed; topology → Priority → number).

5. **Conflict analysis.** Apply the spec's scheduling rules (schema serializes
   globally; expected file-level overlap decides, not the `Touches` sets). Cap
   work in flight — claimed issues plus unmerged PRs — at 6: the bottleneck is
   the gates, not implementation.

6. **Preflight — ground, classify, challenge, recheck.** Runs on every issue
   selected in step 5, after conflict analysis and *before* the claim: ground
   the issue at a recorded `origin/main` commit, classify its risk on four
   axes, challenge it in proportion, recheck eligibility, and take the outcome
   off the lifecycle table. `preflight.md` beside this file is the whole
   procedure and both of its tables — read it on every iteration that reaches
   this step.

7. **Dispatch.** Only issues step 6 returned as *dispatch* reach here; the
   others are already parked or requeued. For each, follow `AGENTS.md` for the
   claim, implementer brief, worktree, validation, PR, handoff, and
   notification contract. **Announce the work to the user** in your visible
   output: one or two plain sentences on what the issue is and why it is next,
   plus the direct GitHub URL (from `gh issue view <n> --json url`).

   The brief instructs the implementer to read `AGENTS.md` first, before any
   repository change. Prompt the implementer named by the claim: spawn an Opus
   sub-agent (`model: opus`, `isolation: worktree`) by default, or use the
   Herdr skill to dispatch a Codex session with the issue URL. The brief is
   decision-complete but pulled, not pushed: pass the full issue body and
   applicable CLAUDE.md invariants, and instruct the agent to start by reading
   the product docs its Pointers cite through the uberblick MCP tools —
   `get_doc` on each cited uuid, `search` for what the issue did not
   anticipate — before repository changes. Inline only what those tools cannot
   serve: PR diffs, review threads, and decisions taken in this session. Where
   the MCP server is not registered, use the throwaway stdio-client pattern
   from #77 and #134 in a scratch directory outside the committed worktree.
   The brief states which route applies.

   Any live doc that contradicts the code is named in the PR body — the read
   side of the dogfooding contract, mirroring the post-merge doc update. Until
   #130 lands, ask for an uberblick-usage summary: MCP used or not, docs read
   by title and uuid, helpful yes/no, and one line why.

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
