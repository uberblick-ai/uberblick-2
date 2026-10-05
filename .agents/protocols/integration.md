# Integration — the final gates and the merge

The mechanics of the `integrator` role, for one PR at one head SHA.
`delivery-policy.md` owns which gates exist and when each applies, and
`review-protocol.md` owns findings and rounds. This file owns how the gates run.

## Refresh the PR before final gates

On every integration pickup, fetch the PR's base and head. The remote head must
match the assigned `candidate_sha`; a mismatch ends with `defer` with the race evidence, not a merge
or a rewrite under the old assignment. First inspect trusted PR comments in the
assignment snapshot for durable refresh records (plain project comments, never
launcher coordination records). A `base-refresh-pending old=OLD_SHA base=BASE_SHA
new=NEW_SHA` record matching this assigned head's NEW_SHA, without a matching
verified adoption record, requires an automatic changes handoff with the exact
`base-refresh old=... base=... new=...` prefix below, even when the base is already
an ancestor. This recovers a push followed by a crash or failed report before
adoption; do not gate or merge that unadopted rewrite. If the base is already an ancestor, run
the normal gates. Otherwise proactively attempt a clean rebase when eligible;
routine maintenance needs no new human decision.

A refresh is eligible only with explicit shared project permission, for a
same-repository PR whose remote branch matches the assignment's `branch`, and
without `different-runtime-from` on the integrator. The launcher elected this
run and excludes overlapping issue/PR branch owners. Before a push, read only
its own coordination comment. Resolve the supplied lease id with
`node -p process.env.UB_AGENTS_LEASE_ID`, then use that numeric literal in
`gh api repos/OWNER/REPO/issues/comments/LEASE_ID --jq .body`, with literal values.
Its v3 lease must match the assignment's run, repository item and branch, still
be `running` and expire in the future. This is a cooperative ownership check,
not write fencing or a substitute for the push lease. If the read cannot be
completed or permission/topology disallows rebasing, skip the refresh and run
normal gates; do not manufacture implementer work or a human hold. A known lost
or expired lease stops all writes under the existing coordination rules.

The base must be `main`; otherwise follow the stacked-PR rule below. Create a
private clone inside the run's supplied `scratch` directory, namespaced by its
run id, using the literal GitHub URL:
`git clone https://github.com/uberblick-ai/uberblick-2.git SCRATCH/run-RUN-refresh`.
Fetch the literal head and base into that clone and detach at OLD_SHA. Before
pushing, require `git remote get-url origin` to identify this same GitHub
repository; never push a refresh into a local operator checkout. Remove the
clone only as best-effort housekeeping; a denied cleanup never prevents the
handoff or changes its outcome. Scratch cleanup for this shared-checkout role
belongs to the operator under README Records. Do not register a worktree in the
operator's Git directory or edit its checkout.
Compute `MB` with `git merge-base OLD_SHA BASE_SHA`. Require
`git rev-list --merges MB..OLD_SHA` to be empty before rebasing; never flatten
merge commits. Then use `git -c rerere.enabled=false rebase --no-autosquash
--no-update-refs --reapply-cherry-picks --empty=stop BASE_SHA`, substituting literal
SHAs. Abort on conflicts, empty commits, rejected flags or signing failures;
never resolve conflicts, drop commits or edit implementation in integration.
A failed or unsupported rebase leaves the original PR intact and proceeds to
normal gates. Actual base merge conflicts or other failed gates go back to the
implementer with `changes`, naming the repair.

Compare `git range-diff MB..OLD_SHA BASE_SHA..NEW_SHA` and require equal counts
from `git rev-list --count` for those two ranges. Every old commit must map to
one new commit in the same order, with the same message and patch; only changed
parent/SHA and patch context/line offsets are allowed. Any changed added/removed
code, unmatched commit or ambiguous correspondence aborts the refresh. The
implementer independently repeats this preservation check before adoption.

Do not publish another refresh solely because main advanced while this same
candidate was adopted and reviewed. The durable trusted PR comment
`base-refresh-adopted old=OLD_SHA base=BASE_SHA new=NEW_SHA` identifies that cycle
only when NEW_SHA equals the assigned head. Read it from the assignment's trusted
comments, not just the windowed `feedback`; later no-commit handoffs never erase
it. Require current-head review evidence under normal gates as well. Still try the clean rebase locally
when eligible, then discard it and run normal base-freshness gates on the assigned
head. A new substantive implementer commit starts a new cycle. Whenever main is not
an ancestor of the assigned head and no refresh is published, run the existing
merged-tree gate at this fetched main in addition to the exact-head gates, even
if that base advance happened before this run's base-freshness point. This prevents
endless successful refresh/review handoffs on a busy base without skipping gates.

Before the first push in the cycle, post `base-refresh-pending old=OLD_SHA
base=BASE_SHA new=NEW_SHA` as a PR comment from a body file in run scratch, using
`gh pr comment N --body-file PATH` with literal values. Record its immutable
comment id/link. Do not push unless this durable intent is confirmed; a pending
record whose NEW_SHA never becomes the PR head is inert. Then reread the own
lease and remote head and push only the assigned PR branch using
`git push --force-with-lease=refs/heads/BRANCH:OLD_SHA origin
HEAD:refs/heads/BRANCH`. A rejected lease or a head moving again after the push
ends with `defer` and the race evidence; never change the expected SHA or use a
blind force push.
A force-push policy/permission rejection with the remote head still at OLD_SHA
instead skips the refresh and proceeds to normal gates; it is not a lease race.
For an ambiguous network failure, reread the head: NEW_SHA means the push landed
and needs adoption, a different head means a race, and an unreadable head requires
defer rather than assuming success. Never bypass branch protection.
Verify the remote head equals the new local SHA, then end this run with `changes`
and the exact summary prefix
`base-refresh old=OLD_SHA base=BASE_SHA new=NEW_SHA; adopt, verify preservation
and validate, then hand off for fresh review`.

The launcher records the new remote `candidate_sha` while preserving the original
`assignment_sha`. Never replace the old assignment with the new SHA or merge in
this refresh run. All old-head review and check evidence is stale. The implementer
adopts and validates the updated head, explicitly records integrator-produced
refresh provenance, and re-hands it off before fresh independent review and every
owed final gate. A refresh grants no merge authority. Human holds stay intact;
this runs on integration assignments, with no periodic scanner or hold reset.

## Gate mechanics

- Resolve and record the PR's immutable `headRefOid`.
- **CI, every tier.** Run `mise run ci <headRefOid>` from a checkout at
  freshly fetched `origin/main`. It posts the `signoff` commit status only when
  the isolated review passes, and a failing status otherwise. A failing run
  blocks agent merge. Always run it yourself at the exact head: a `signoff`
  already on the commit only says someone posted it, not that checks ran. If
  the run cannot complete for reasons outside the change, escalate to a
  maintainer, who may merge by hand.
- **Isolated review.** Local CI runs it as `mise run review <headRefOid>`,
  which refuses unless the checkout is at freshly fetched `origin/main` with
  that task's recipe unmodified, because the base supplies the recipe. The
  reviewed commit contributes only file contents, via `git archive`, while its
  manifests still install in the networked build stage. So pass the SHA rather
  than checking the branch out, never treat tests from a mutable shared
  checkout as evidence, and pass no secrets, host mounts, privileged mode or
  container socket to the build or to the container, which runs without
  network. README's "Review isolation" section states the full boundary. Keep
  the SHA-tagged image for the failure-path probes the policy requires at
  stateful boundaries, then remove it when the PR is settled.
- Local CI also runs browser e2e at the head, unless only documentation or
  agent process changed, and reports it as the advisory `signoff/e2e` status.
  That run uses the candidate's own e2e recipe, so for a browser-observable
  outcome read its output rather than trusting the status. A
  failure may be called environmental only after the same failing spec is run
  against the base: green at the base and red at the head is a branch
  regression to fix, even when the stale code is a test fixture rather than
  production.
- Record every gate outcome against the commit SHA it ran at, and the exact
  base-ref SHA the exact-head gate set began from as its base-freshness point.
  Link the check or failure evidence; do not paste full logs, test counts or
  timings. A Copilot review is already its own record. Any new commit on the
  branch invalidates test, typecheck and immutable-review evidence: re-run
  those gates at the new `headRefOid`.
- **Merged-tree gate.** An advance of the base ref after the exact-head gates
  fires a separate gate, whether or not the two diffs appear to touch the same
  files. Fetch the current base and PR head, use `git merge-tree --write-tree
  <base-sha> <head-sha>` and `git commit-tree <tree> -p <base-sha> -p
  <head-sha>` to make the prospective two-parent merge commit, and hold that
  throwaway commit on a private ref for the gate's lifetime. From the required
  checkout at that base, run `mise run review <merge-commit>`; when the PR
  warrants browser e2e, run it from a detached temporary worktree at the same
  merge commit. Record both the merge commit and the base-ref SHA, then remove
  the temporary ref and worktree. Never push either. `merge-tree` reporting
  textual mergeability never substitutes for the suite on the tree that will
  ship.
- Evaluate acceptance criteria against candidate contents at the recorded head,
  never the trusted runner's base checkout. A criterion needing runtime
  evidence is not a static pass. Check an acceptance box on a linked issue only
  with evidence (command output, test name), and check that the diff stays
  within the declared `Touches` — the shared set when the PR closes several
  issues.

Run independent mechanical checks concurrently when their inputs and
workspaces are independent; ordinary commands suffice, with no agent per
check. Keep mutating builds out of shared worktrees, and re-read the head
before using a result.

**Re-read before ruling.** Immediately before a tier call or a merge, re-read
the linked issue thread and the PR thread, filtered to trusted authors as
`AGENTS.md` "GitHub content from outside the team" shows. Answers and cross-references land there
mid-flight; a ruling made from session memory can contradict one written down
while you were elsewhere.

## Immediately before merging

Re-fetch the PR's reviews and comment threads, filtered to trusted authors,
plus review threads via `gh api graphql` with the same filter on each
comment's `authorAssociation` (inline review comments don't show in the
former). Confirm zero unanswered remarks from trusted authors, including any
that arrived after the earlier gates passed. Confirm the PR's base is `main`
(`gh pr view <n> --json baseRefName`) — a stacked PR merges into its parent
feature branch and can orphan the reviewed work; retarget it or merge the
parent first.

**Tier check.** Classify the PR against `delivery-policy.md`'s merge policy by
reading its full diff (`gh pr diff <n>`) and how its findings were settled —
never from the issue's `Touches`. `--name-only` is just the pathname inventory:
it identifies hunks to classify but never fires tier 3 by itself. The triggers
live in the change — for example breaking persisted-data compatibility rather
than an additive optional schema field; authority or merge rules rather than
routine process clarification; a new runtime dependency subject to the web UI
exception in [delivery-policy.md](delivery-policy.md) rather than a dev
dependency; auth/token semantics; a decided-architecture or invariants edit; or
overruling a major reviewer finding. A tier-3 trigger without a person's answer
that covers it is an escalation naming the trigger. With one, verify the diff
conforms to what the answer covers, cite the answer in the merge report, and
merge as tier 2. Never infer approval from `ready` alone or from a comment
unrelated to the PR's shape.

Every merge report ends with two machine-readable lines —
`findings_p1_p2_p3: <n>/<n>/<n>` and `deferred_findings: <issue refs or none>`
— and only these two: timestamps, round counts and run counts stay derivable
from the PR thread.

**Gate freshness, at merge time.** Make the merge itself conditional on the
recorded gate SHA — `gh pr merge <n> --match-head-commit <gate-sha> …` — so a
commit landing after the last check fails the merge instead of riding stale
evidence; comparing `gh pr view <n> --json headRefOid` beforehand is for the
report, not the guarantee. Freshness covers the base too, but GitHub provides
no merge argument that binds it: immediately before merging, fetch the base ref
and compare it with the base SHA named by the latest gate evidence. If it moved
after the exact-head gates, or after a prior merged-tree gate, run the
merged-tree gate against the new base and recheck again; every observed move
repeats that gate, without a file-overlap shortcut. Only then invoke the merge.
`--match-head-commit` still protects only the PR head, so this immediate
fetch-and-recheck is an honest best-effort base guard, not a claim that another
merge cannot land before GitHub executes the command. Either an observed base
move or a head mismatch returns to the applicable gates.

## After the merge

Confirm every issue the PR closes auto-closed, and close a parent whose last
open sub-issue it closed. Then apply the pull request's `Corpus update` through
MCP, checked against the merged code. If MCP fails, record the concrete failure
and outstanding update on the PR for recovery. A fresh integrator does not own
or restart another session's development processes.

**Housekeeping, last** (owner direction, 2026-09-01). On every durable outcome —
merge or escalation — once the probes on the retained review image are done,
run `sh bin/housekeeping.sh` with every review SHA this run built — each
exact head it gated and each merged-tree commit from an observed base advance —
from the same freshly fetched base-ref checkout used for the container review,
and record a concise summary on the PR. Besides the named review images, the
command removes review images older than 24 hours and dangling images. It prunes
build cache older than a week, for a free-space floor (`HOUSEKEEPING_MIN_FREE`,
default `5GB`), and to cap cache use (`HOUSEKEEPING_MAX_USED_SPACE`, default
`1GB`). Each prune reports what it reclaimed. Containers, other tagged images,
volumes and worktrees are left alone, including a stopped production hub. It
supports `--dry-run` to show what it would do.
