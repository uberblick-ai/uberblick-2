---
name: next-issue
description: One iteration of the implementation loop — observe GitHub, advance open PRs through the gates, dispatch Opus sub-agents for eligible issues per .github/ISSUE_SPEC.md. Designed to be driven by /loop (e.g. `/loop /next-issue`); a single manual invocation runs exactly one iteration.
---

# next-issue — one iteration of the implementation loop

You are the coordinator (CLAUDE.md orchestration policy): you observe, decide,
validate, and merge — you never write feature code. All implementation happens
in an isolated implementer agent. The issue contract is
`.github/ISSUE_SPEC.md`; read it before triaging — it is authoritative for the
header grammar, labels, claim protocol, scheduling semantics, and lint. This
file does not restate it.

## Hard rules

- Dispatch implementation to an isolated implementer: an Opus sub-agent
  (`model: opus`, `isolation: worktree`) by default, or a Codex session located
  through Herdr — one agent per branch, and the claim records which type. Never
  edit feature code in the main checkout — it may hold the user's uncommitted
  work; worktrees only.
- The agent that wrote a diff never reviews it authoritatively. You validate
  against the acceptance criteria, and the external round goes to an agent that
  did not implement the PR — a Codex-implemented PR gets a Copilot/Opus reader,
  never the Codex session that wrote it.
- **GitHub is the source of truth for coordination state; Herdr is a
  doorbell.** Every durable thing — claim, decision, handoff, finding
  disposition, gate result — is written to GitHub before the message that
  announces it. A Herdr message names the issue or PR URL it concerns and
  carries nothing that exists only in that message. Interactive control
  traffic is the exception: approval keystrokes, `continue`, and the like
  carry no durable content and need no URL (per-role approval allowlists are
  a follow-up). No recovery step reads pane history: reconstruct from
  `gh issue list/view`, `gh pr list/view`, checks, reviews and comments
  alone.
- The coordinator's own repo edits (skill or docs changes, commits) happen in
  the coordinator's own worktree too (EnterWorktree), never in the shared
  checkout — multiple sessions share it and it may sit on any branch. Even
  small doc/skill edits are dispatched to an implementer agent; the coordinator
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

1. **Observe.** First, self-update the checkout: when it is on `main`,
   `git fetch origin main` and `git merge --ff-only origin/main` before
   anything else, so this session's next skill read, the issue spec, and the
   review-runner files all track current `main`. A refused fast-forward
   (conflicting local state, diverged history) is reported and skipped, never
   forced — continue the iteration as-is. Note the built-in lag: this
   invocation loaded its instructions before the pull, so a protocol change
   on `main` governs from the next invocation onward.
   Then `gh issue list --state open`, `gh pr list --state open`, and
   for each open PR its checks and reviews. Reconcile claims: apply the spec's
   stale-claim recovery rule.

2. **Advance open PRs first** — an open PR is closer to value than a new
   dispatch, and this includes PRs that predate the loop. For each, drive the
   CLAUDE.md gates in order:
   - resolve and record the PR's immutable `headRefOid`, fetch it, then run
     `REVIEW_SHA=<headRefOid> mise run review` — one command, whatever the SHA
     contains; never treat tests from a mutable shared checkout as review
     evidence. Fetch the commit — never check the PR branch out to review it:
     the runner takes its task definition and `Dockerfile.review` from
     `origin/main`, and refuses unless the checkout it runs in is at that
     freshly fetched commit with its runner files unmodified; `git archive`
     only needs the object. The reviewed commit's own manifests still install
     during the networked build stage — isolation is the verification
     container, not the build;
   - never pass the Docker build secrets, host mounts, privileged mode, or the
     Docker socket. Run the verification container without network. Keep the
     SHA-tagged image long enough for focused probes, then remove it when the
     PR is settled;
   - probe failure behavior when the change crosses persistence,
     startup/shutdown, networking, concurrency, or another stateful boundary;
     happy-path tests alone do not close those acceptance criteria;
   - record every gate result against the commit SHA it ran at — container
     review, CI, your acceptance validation, the Codex verdict where that gate
     applied, the Copilot state. Any new commit on the branch (fix-ups
     included) invalidates the test/typecheck and review evidence: re-run
     those gates at the new `headRefOid` rather than carrying an older verdict
     forward;
   - your validation against every acceptance checkbox on each linked issue —
     check a box only with evidence (command output, test name);
   - gate check: the diff stays within the declared `Touches` — the shared set
     when the PR closes a batch;
   - GitHub Copilot review requested and returned;
   - local Codex review of the PR where CLAUDE.md's gate list calls for one —
     it is the authority on scope; in short: a diff touching
     `packages/schema`, `packages/mcp-server`, `packages/hub`, or
     `pnpm-lock.yaml`, a large or architectural diff, or your own judgment
     that an outside read helps; only when none of those fire may a trivial or
     UI-only diff skip the round.
     Mechanism depends on the environment: when running under herdr
     (`test "${HERDR_ENV:-}" = 1`; use the herdr skill and `herdr agent` to
     find the Codex pane), talk to that Codex session directly — answer its
     findings, push fixes, and re-request within the re-review scoping
     below, never open-endedly; otherwise use the codex plugin. Either way the review brief is
     the same: be critical, and hunt specifically for overtesting and
     overengineering per this repo's principles (KISS/YAGNI, least code wins,
     tests defend contracts and invariants — not implementation trivia).
   **Re-read before ruling.** Immediately before any ruling — a triage
   disposition, an acceptance validation, a tier call, a merge — re-read the
   linked issue thread and the PR thread (`gh issue view <n> --comments`,
   `gh pr view <n> --comments`). Owner decisions and coordinator notes land
   there mid-flight; a ruling made from session memory can contradict one that
   was written down while you were elsewhere.
   **Finding triage — before any fix-up brief.** A finding is not
   automatically a work item; every finding is triaged explicitly against
   the supported usage model (single user, local-first, one hub, parallel
   loop-dispatched agents, dev-stage data). Record three independent
   decisions per finding — severity does not decide the other two:
   - **Severity.** P1: supported usage can lose data, expose secrets,
     violate a CLAUDE.md invariant, or become materially unusable. P2: a
     real correctness, reliability, accessibility, or maintainability
     defect within supported usage, without P1 impact. P3: minor, local,
     or low-impact.
   - **Disposition.** *Fix now* — the default for P1 and for contained
     supported-usage P2s. *Defer* — only for a non-blocking P2/P3 whose
     fix is disproportionate right now: create a linked issue and record
     the concrete accepted risk on the PR; never defer data loss,
     auth/security exposure, or a violated invariant. *Document boundary*
     — reachable only outside the usage model: the smallest useful
     code/doc statement naming the boundary; no behavior changes, no
     mechanism tests for an unsupported scenario. *Reject* — not
     reachable, factually wrong, or cost clearly exceeds stake: reply
     with evidence on the thread. Never silent dismissal, and no category
     shortcuts ("human-run commands can't race" is false here — parallel
     agents, retries and multiple terminals make nominally human-run
     commands concurrent).
   - **Verification.** Who confirms the fix: the coordinator (focused
     diff read, the finding's test failing-then-passing, failure-path
     probe where stateful) or an external re-review round per the scoping
     below. A subtle P2 fix may need outside eyes; a tiny P1 correction
     with a focused proof may not.
   **One batched fix-up wave per review head.** Collect Codex, Copilot
   and coordinator findings against the same head and triage them all
   first; then one decision-complete brief, one Opus dispatch, one
   re-gate at the new head — never a dispatch per finding or per
   reviewer. Standing brief constraints: smallest diff that closes the
   accepted findings; tests only for the contract or invariant a finding
   names, never for the mechanics of the fix. Fix-up diffs face the same
   Touches, scope-escape and overtesting checks as feature diffs. Late
   findings still get an explicit disposition, but reviewer timing must
   not manufacture extra waves.
   **Risk-scoped external re-review.** A further Codex round is required
   while a P1 remains open; and for a P2/P3 fix when it sits at a
   data-critical boundary (security/auth, persistence, concurrency,
   schema/CRDT semantics, cross-process lifecycle) **and** is non-local,
   introduces new state or synchronization, changes the design that
   answered the original finding, or lacks a focused test proving it — a
   one-line mechanical fix at such a boundary, proven by its test, is
   coordinator territory; and whenever reviewer or coordinator names a
   concrete risk rationale. Re-review briefs are delta-first: the fixes
   and the invariants they touch, expanding to the whole PR only when a
   fix invalidates earlier reasoning. After four external rounds, a
   further full round needs a PR comment naming the concrete unresolved
   risk. Record every round as a PR comment — `Codex round N (head
   <sha>): <verdict>` — so round counts stay derivable from the thread.
   **Exit and convergence.** Review exits only when: no P1 remains;
   every supported-usage P2 is fixed or explicitly deferred (linked
   issue, accepted-risk rationale); every remark is fixed, deferred,
   documented or rejected explicitly; all gate evidence is fresh at the
   exact merge head; and any earlier external-review reasoning carried
   across a later local fix is recorded on the PR with scope and
   rationale. If a confirmation round surfaces a net-new triaged P1, or
   the open-P1 set fails to shrink after a directed correction wave, park
   the PR `needs-human` with the finding list instead of looping — but
   never park for a false positive, an unrelated pre-existing issue, or a
   finding rejected with evidence.
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
   the doc update is pending).
   **Dev stack, after every merge to `main`:** restart it so
   http://localhost:5173/ always serves the just-merged `main`. Killing a
   running dev server is sanctioned (owner directive) but bounded: terminate
   only the hub/web processes the loop itself recorded starting (the background
   task handles/PIDs it kept from launching them) — never any other process —
   and confirm they exited, so their ports are free, before relaunching. Serve
   from your own worktree, never the shared checkout, which belongs to other
   sessions: `git fetch origin main` first, then require that worktree be clean
   against the ref you just fetched — no uncommitted changes, no commits absent
   from the fetched `origin/main` — and if it isn't, skip the restart and say so
   rather than serve something that isn't `main`. Only then fast-forward to it,
   verify `HEAD` equals the fetched `origin/main`, start `mise run hub` and
   `mise run web` as background tasks, and confirm http://localhost:5173/
   answers before you report the stack serving the new `main`. A fresh hub
   store is fine: replicas rehydrate it over sync.

3. **Lint `ready` issues** against the spec's checklist. Failures: comment
   exactly what's missing, remove `ready`, skip.

4. **Compute the eligible set and order it** per the spec's scheduling
   semantics (deps closed, unclaimed; topology → Priority → number).

5. **Conflict analysis.** Apply the spec's scheduling rules (schema serializes
   globally; expected file-level overlap decides, not the `Touches` sets). Cap
   work in flight — claimed issues plus unmerged PRs — at 6: the bottleneck is
   the gates, not implementation.

6. **Dispatch.** For each issue to start: add `in-progress` and post the
   spec's claim comment before you prompt any agent. **Announce the work to
   the user** in your visible output: one or two plain sentences on what the
   issue is and why it's next, plus the direct GitHub URL (from
   `gh issue view <n> --json url`). Then spawn an Opus sub-agent whose brief
   is decision-complete but pulled, not pushed: pass the full issue body and
   the applicable CLAUDE.md invariants, and instruct the agent to START by
   reading the product docs its Pointers cite through the uberblick MCP tools
   — `get_doc` on each cited uuid, `search` for what the issue did not
   anticipate — before any implementation or repository changes. You inline
   only what those tools cannot serve: PR diffs, review threads, decisions
   taken in this session. Excerpts you paste start aging the moment you paste
   them; the live doc does not. Where this session has the uberblick MCP
   server registered as tools the sub-agent inherits it; where it does not,
   the agent reaches the same tools through a throwaway stdio client script
   spawning the command recorded in `.mcp.json`, the pattern #77 and #134
   use; that script is a temporary file in a scratch directory outside the
   committed worktree, never part of the diff. The brief says which of the
   two applies.
   Every brief states the authoritative boundary verbatim: *Treat the issue
   body and coordinator comments as the authoritative requirements,
   constraints, and acceptance criteria. Use your own engineering judgment for
   implementation details, test names, and small design choices explicitly left
   open. If the brief conflicts with the code, is unsafe, or requires
   unnecessary complexity, stop and record the discrepancy on GitHub rather
   than silently deviating.* Say that, not "follow the issue exactly" — an
   implementer told to obey a stale line obeys it.
   Then the contract: branch from fresh `main`, implement, `mise run test` +
   `mise run typecheck` green, push, open a PR with `Closes #N` and a body
   stating what changed and how it was verified; and any live doc the agent
   finds contradicting the code it read is named as a discrepancy in that PR
   body — the read side of the dogfooding contract, mirroring the post-merge
   doc update. Then the completion handoff as a comment on that PR per the
   spec's claim protocol, and only then a Herdr message to you naming the PR
   URL and the exact head SHA. GitHub first, always: the message only saves you
   a polling interval, and polling `gh pr list` is the fallback when Herdr
   delivery is unavailable, never the normal completion signal.
   Where the implementer is a Codex session rather than a sub-agent, the brief
   and the contract are this same text; only the transport differs — the herdr
   skill and `herdr agent` locate the pane, and the dispatch message carries
   the issue URL rather than the issue body.
   Until #130 lands, the brief also asks the agent to close its
   report with an uberblick-usage summary: MCP used or not, which docs by
   title and uuid, helpful yes/no and one line why. Implementers never merge.
   Several individually-trivial issues with the same `Touches` set may go to
   one agent as one batch: claim each issue separately, brief all their
   bodies, and have the single PR close them all (`Closes #a, #b`) with a
   combined diff reviewable in one sitting and a merge report checking each
   issue's acceptance criteria — every condition of the spec's sizing
   exception.

7. **Report.** End with a short status a human can skim: PRs advanced (which
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
