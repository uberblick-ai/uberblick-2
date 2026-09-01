# integration — advancing one PR through the gates to a merge

The mechanics of the `integrator` role, for one PR at one head SHA. CLAUDE.md's
"Development workflow" owns *which* gates exist and when each applies,
including the dual challenge; drive them in the order it lists.
This file owns only their mechanics, and `review-protocol.md` beside it owns the
findings-conditional protocol.

## Gate mechanics

- Resolve and record the PR's immutable `headRefOid`, fetch that commit, and run
  `mise run review <headRefOid>` — never check the PR branch out to
  review it, and never treat tests from a mutable shared checkout as review
  evidence. CLAUDE.md's review paragraph and README's "Review isolation" state
  what the runner refuses and why.
- Run the verification container without network, and pass no secrets, host
  mounts, privileged mode or Docker socket to either the build or the container.
  Keep the SHA-tagged image long enough for the failure-path probes CLAUDE.md
  requires at stateful boundaries, then remove it when the PR is settled.
- For a browser-observable outcome, run the relevant `mise run e2e` proof early.
  A failure may be called environmental only after the same failing spec is run
  against the base: green at the base and red at the head is a fix-now branch
  regression even when the stale code is a test fixture rather than production.
- Record every gate result against the commit SHA it ran at — container review,
  CI, the acceptance validation, both adversarial verdicts where the
  dual-challenge gate applied, and any Copilot result when one was requested. A
  Copilot platform refusal is recorded once and does not block merge. Any new
  commit on the branch (fix-ups included) invalidates test/typecheck and
  immutable review evidence: re-run those gates at the new `headRefOid`. For
  either earlier adversarial verdict, follow `review-protocol.md`'s risk-scoped re-review rule;
  either run a fresh round or record exactly which reasoning still applies and
  why. The integrator's own gate work does not fill a missing challenger slot.
- Check an acceptance box on a linked issue only with evidence (command output,
  test name), and check that the diff stays within the declared `Touches` — the
  shared set when the PR closes a batch.

**Re-read before ruling.** Immediately before any ruling — a triage disposition,
an acceptance validation, a tier call, a merge — re-read the linked issue thread
and the PR thread (`gh issue view <n> --comments`, `gh pr view <n> --comments`).
Owner decisions and coordinator notes land there mid-flight; a ruling made from
session memory can contradict one that was written down while you were
elsewhere.

**Findings.** `review-protocol.md` is the whole findings-conditional protocol —
the external round's mechanism and brief, finding triage, the one batched fix-up
wave per review head, risk-scoped re-review with the round-count rule, and the
exit condition. Read it whenever a PR has a round to request or a finding to
disposition.

## The fan-out — one round's gates at once

The gates above do not depend on each other, so run them as one fan-out instead
of a queue, and start the long pole first.

- **The read that decides the round precedes the fan-out.** Deciding an external
  round is owed, and writing the brief that makes its wall time worth spending,
  is a `CLAUDE.md` judgment made from the change: read the diff far enough to
  make it before launching anything. That read is the ordering's precondition,
  not one of its members, and it is the integrator's own — "Tier check" below
  classifies from the same full diff, never from a gate agent's summary.
  `review-protocol.md` decides whether a round is owed and who owns it;
  dispatching it before the fan-out is ordering only and never creates one. Its
  wait then overlaps the mechanical gates rather than following them.
- **One agent per gate, each in its own checkout.** Launch the mechanical gates
  concurrently — the immutable container review, the e2e proof where the outcome
  is browser-observable, the acceptance-criteria read, the `Touches` scope check
  — with the `Agent` tool's `isolation: "worktree"`, so each works in a checkout
  of its own. Sharing one checkout is not an option: concurrent gates install,
  build and check out in it at the same time. Every worktree inherits the
  launching checkout's `HEAD`, so launch only from a checkout at freshly fetched
  `origin/main` with `mise.toml`, `Dockerfile.review` and `.dockerignore`
  unmodified: that is the state the container review must still be in when it
  runs, and it is necessary rather than sufficient — see its gate below.
- **Every gate agent grades the PR head, and its first commands say which tree
  it reads.** A fresh worktree binds a gate agent in ways that look like a red
  gate and are not branch results. `mise` trusts config by path and every
  worktree is a new path, so `mise trust` precedes any task there. And the
  worktrees share one ref store, so simultaneous `git fetch origin` calls lose a
  `cannot lock ref …: is at <new> but expected <old>` race — the one trap the
  fan-out itself creates, and it fires tens of percent of the time. Whichever
  ref lost, that signature fires because the objects landed and the loser's ref
  already holds the winner's value, so a fetch that exits non-zero with it is
  re-run rather than reported as a red gate — any other fetch failure still is
  one. Then, by gate:
  - **The acceptance-criteria read and the `Touches` scope check** — `git fetch
    origin`, then `git checkout --detach <headRefOid>`. They read that tree and
    run no task, so no `mise trust`. Left on the launch checkout's `origin/main`
    they grade `main`: every criterion of the form "X is unchanged" reads true
    there for free, and every "the file now says Y" reads false and costs a
    fix-up wave the branch never earned.
  - **The e2e proof** — the same two commands, then `mise trust` and `mise run
    install`. `mise run e2e` takes no SHA and runs whatever its checkout holds,
    and it opens with a `pnpm --filter` exec that a fresh worktree's empty
    `node_modules` cannot serve. A red run is classified *before* the agent
    returns, because the environmental-failure rule above needs a base run and
    this is the only installed worktree — it is gone once the agent returns.
    That base is `origin/main`, the tree the container review runs from and the
    one the PR merges into: `git checkout --detach origin/main`, `mise run
    install` again — the head's `node_modules` is not the base's — then the same
    spec, and report both outcomes with both SHAs.
  - **The immutable container review** — the exception, and the only gate whose
    own checkout stays at freshly fetched `origin/main`: `main` supplies the
    build recipe (README, "Review isolation"), and archiving the SHA it is
    passed is what lets it grade the head from there. So `mise trust`, then
    `mise run review <headRefOid>`, which needs that commit already in the
    shared object store — the fetch "Gate mechanics" opens with. `mise run
    review` re-fetches `main` and re-compares at run time while a worktree's
    `HEAD` is frozen at creation, so a gate agent it refuses moves its worktree to
    freshly fetched `origin/main` and re-runs instead of reporting a red gate.
    The SHA-tagged image outlives that worktree on the host daemon, so the
    failure-path probes above stay the integrator's own work, never the gate
    agent's.
- **Every gate agent reports; none writes.** Each returns its `gate`, `outcome`,
  a short `summary`, the `sha` it ran at, and its `start` and `end`, and performs
  no GitHub write at all — no claim, comment, label, review or merge. The
  integrator owns every durable record, so a gate result reaches the PR only
  through it.
- **`needs-runtime` is routing, never a pass.** A gate agent that cannot settle
  an acceptance criterion from static evidence answers `needs-runtime` and names
  the gate that covers it — a criterion observable only in a running browser goes
  to the e2e gate — instead of guessing. The integrator then reconciles that
  gate's result into a pass or fail for the criterion, at the same fresh head,
  before ruling; when the named gate was not launched — the browser-observability
  call is made before the acceptance read returns — launch it in a second wave at
  that same head and reconcile against its result.
- **Freshness survives the fan-out.** Every evidence item names the SHA it ran
  at. A commit landing mid-fan-out is resolved by the per-gate freshness rules
  above and in `review-protocol.md` — re-run what the new commit invalidates —
  never by carrying an item forward to a head it did not run at.
- **The record carries the timings.** The integrator's PR record names each
  gate's start and end alongside its outcome, and the round's own claim→ruling
  wall time. Per-gate times happen inside subagents that write nothing, so they
  are not derivable at all; the round total is the one deliberate exception to
  the never-restate-a-timestamp rule below, because it is the telemetry this
  fan-out exists to produce.

## Immediately before merging

Re-fetch the PR's reviews and comment threads (`gh pr view <n> --comments` plus
review threads via `gh api graphql` — inline review comments don't show in the
former) and confirm zero unaddressed remarks, human or bot, including any that
arrived after the earlier gates passed; anything open is triaged first. Confirm
the PR's base is `main` (`gh pr view <n> --json baseRefName`) — a stacked PR
merges into its parent feature branch and can orphan the reviewed work; retarget
the PR to `main` (or merge the parent first) before merging.

**Tier check.** Classify the PR against CLAUDE.md's "Merge policy" tiers by
reading its full diff (`gh pr diff <n>`) and how its review findings were
dispositioned — never from the issue's `Touches`. `--name-only` is just the
pathname inventory: it identifies hunks to classify but never fires tier 3 by
itself. The triggers live in the change — for example breaking persisted-data
compatibility rather than an additive optional schema field; authority or merge
rules rather than routine process clarification; a runtime dependency rather
than a dev dependency; auth/token semantics; a decided-architecture or
invariants edit; or overruling a major reviewer finding. A tier-3 trigger
means you do not merge: label the PR `needs-human`, comment which trigger fired,
fire a PushNotification naming the PR and the trigger so the owner learns a
merge decision awaits them, then park it and report.

**Exception — `human-approved`.** A PR carrying the owner-set `human-approved`
label is merge-authorized: execute the merge as tier 2 (merge report first),
every other gate unchanged — evidence fresh at the exact merge head, zero
unaddressed remarks. The owner sets the label directly or explicitly directs a
session to set it for named PRs; that session posts the direction as provenance.
Never infer approval from `ready` or an unrelated owner comment. Approval covers
the intended PR shape plus fix-ups and non-rewriting synchronization with
`main`; if later commits materially expand the design or scope, replace it with
`needs-human` and name the delta.
Tier 1 and Tier 2 self-merge as specified there (Tier 2 requires the merge-report
comment on the PR first). Every merge report ends with two machine-readable
lines — `findings_p1_p2_p3: <n>/<n>/<n>` and `deferred_findings: <issue refs or
none>` — and only these two: timestamps, round counts and run counts stay
derivable from the PR thread and are never restated (ISSUE_SPEC's derivability
principle).

**Gate freshness, at merge time.** Make the merge itself conditional on the
recorded gate SHA — `gh pr merge <n> --match-head-commit <gate-sha> …` — so a
commit landing after the last check fails the merge instead of riding stale
evidence; comparing `gh pr view <n> --json headRefOid` beforehand is for the
report, not the guarantee. Freshness covers the base too: if `origin/main`
advanced after the gates and its changed files overlap the PR, gate the
prospective merged tree and repeat if the base moves again. Either kind of
mismatch returns to the gates.

## After merging

Confirm every issue the PR closes auto-closed. Then update the product docs to
the new status quo (uberblick MCP tools once registered; until then, comment on
the PR that the doc update is pending). Record the result on the PR. A fresh
integrator does not own or restart another session's development processes.

**Housekeeping, last** (owner direction, 2026-09-01). Once the probes on the
retained review image are done, run `sh scripts/housekeeping.sh <headRefOid>`
and paste its output under the post-merge result. It removes this run's and
older review images, stopped containers and dangling layers, keeps build cache
for a week, and removes worktrees whose git state is a day old and whose branch
is merged, gone from `origin`, or detached — never one on a branch still open
on `origin`, never the main checkout. `--dry-run` shows what it would do.
