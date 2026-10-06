# Integration — the final gates and the merge

The mechanics of the `integrator` role, for one PR at one head SHA.
`delivery-policy.md` owns which gates exist and when each applies, and
`review-protocol.md` owns findings and rounds. This file owns how the gates run.

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
routine process clarification; a new runtime dependency rather than a dev
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

**Gate freshness, at merge time.** Merge with `gh pr merge <n>
--match-head-commit <gate-sha> …`, so a commit landing after the last check
fails the merge. GitHub cannot bind the base the same way: immediately before
merging, fetch the base ref and compare it with the base SHA of the latest gate
evidence. Every observed move repeats the merged-tree gate against the new base,
with no file-overlap shortcut, before the merge is invoked. This is a
best-effort base guard; a base move or head mismatch returns to the gates.

## After the merge

Confirm every issue the PR closes auto-closed, and close a parent whose last
open sub-issue it closed. Then apply the pull request's `Corpus update` through
MCP, checked against the merged code. If MCP fails, record the concrete failure
and outstanding update on the PR for recovery. A fresh integrator does not own
or restart another session's development processes.

**Housekeeping, last.** On every durable outcome, merge or escalation, once the
probes on the retained review image are done, run `sh bin/housekeeping.sh`
with every review SHA this run built (each gated head and each merged-tree
commit) from the same base-ref checkout used for the review, and record a
concise summary on the PR. What it removes and keeps is in the script's header;
`--dry-run` shows it.
