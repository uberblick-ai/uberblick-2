# Integration — the final gates and the merge

The mechanics of the `integrator` role, for one PR at one head SHA.
`delivery-policy.md` owns which gates exist and when each applies, and
`review-protocol.md` owns findings and rounds. This file owns how the gates run.

## Refresh the PR before final gates

On every integration pickup, fetch `origin/main` and the PR's remote head.
Confirm the base is `main`, the PR is in this repository, and the remote head
matches the assignment's `candidate_sha`. If main is already an ancestor of
that head, continue. Otherwise proactively attempt a clean rebase onto that
fetched main, without another human decision. Refreshing the trusted CI runner
or testing a prospective merged tree alone does not update the PR.

This is the integrator's narrow branch-writing exception. Use a private scratch
checkout, never the shared operator checkout or another run's worktree. Before
writing the branch, reread coordination leases and establish that your assignment
still owns the branch: your lease is the unexpired winner, and no other live or
cleanup-unconfirmed issue/PR lease owns it. Forks, unknown ownership and an
integrator configured with `different-runtime-from` are not eligible for this
push; send maintenance to the implementer with `changes` instead. The latter
configuration rejects success after its assigned head moves.

Only rebase a linear PR-only commit sequence, disabling autosquash, rerere and
updates to other refs and stopping on empty results, for example:
`git -c rerere.enabled=false rebase --no-autosquash --no-update-refs
--reapply-cherry-picks --empty=stop BASE_SHA`. Inspect `git range-diff` for the
old/new ranges and the resulting diff against main. Abort on conflicts, empty
or dropped commits, or substantive differences; never resolve conflicts, edit
implementation or flatten merge commits in integration. Route these cases and
unsupported topology to the implementer with `changes`, naming the exact task.

Immediately recheck ownership and the remote head, then push only that branch
with `git push --force-with-lease=refs/heads/BRANCH:OLD_SHA origin
HEAD:refs/heads/BRANCH`, substituting literal branch and full SHA values. If the
lease rejects, never change its expected SHA or use a blind force push: finish
`defer` with the concurrent-update evidence so a new assignment observes it.

After pushing, verify the remote head equals the new local SHA; if it moved
again, finish `defer` with the race evidence. Otherwise finish
`changes`, recording old head, fetched main and new head and saying
`Clean base refresh; adopt and validate NEW_SHA, then finish review`.
The launcher records the new head in the outcome; the assigned SHA stays unchanged.
This automatic handoff lets the implementer validate and re-handoff the exact
updated candidate with current-head runtime provenance before independent review.
Do not merge, certify the rebased diff or reuse any old-head review, test,
typecheck or CI evidence in this run. Every owed gate runs again at the new head;
a later integration run uses its own assigned SHA and retains the merged-tree
gate for any further main advance. A branch refresh grants no merge authority.

If an ownership or authority gate cannot be established, finish `defer` with the
evidence rather than writing. Human holds and product/merge approvals remain in
force. This runs on assigned integration work; it creates no periodic scan or
automatic resumption of `needs-human` items.

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
