# integration — advancing one PR through the gates to a merge

The mechanics of the `integrator` role, for one PR at one head SHA. delivery-policy.md's
"Development workflow" owns *which* gates exist and when each applies,
including the dual challenge; drive them in the order it lists.
This file owns only their mechanics, and `review-protocol.md` beside it owns the
findings-conditional protocol.

## Gate mechanics

- Resolve and record the PR's immutable `headRefOid`. Where delivery-policy.md's gate
  list requires the isolated review, fetch that commit and run the project's
  `review` command with `<headRefOid>` — never check the PR branch out to
  review it, and never treat tests from a mutable shared checkout as review
  evidence; delivery-policy.md's review paragraph and the project's own
  documentation of that command state what it refuses and why. Otherwise the
  immutable review is CI at that exact head: `gh api repos/{owner}/{repo}/commits/<headRefOid>/check-runs
  --jq '.check_runs[]|select(.name|test("gates"))|.conclusion'` must print
  `success`, and the ruling links that check run. A missing or non-green run
  is not a fast path; it routes back to the isolated review.
- Run the verification container without network, and pass no secrets, host
  mounts, privileged mode or container socket to either the build or the
  container.
  Keep the SHA-tagged image long enough for the failure-path probes delivery-policy.md
  requires at stateful boundaries, then remove it when the PR is settled.
- For a browser-observable outcome, run the relevant `e2e` proof early.
  A failure may be called environmental only after the same failing spec is run
  against the base: green at the base and red at the head is a fix-now branch
  regression even when the stale code is a test fixture rather than production.
- Record every gate outcome against the commit SHA it ran at — container
  review, CI, the acceptance validation, both adversarial verdicts where the
  dual-challenge gate applied, and any Copilot result when one was requested.
  Record the exact base-ref SHA that the exact-head gate set began from as
  its base-freshness point too.
  Link the check, review record or failure evidence; do not paste full logs,
  test counts or timings into each ruling. A Copilot review is already its own
  record and gets no wrapper comment; a platform refusal is recorded once and
  does not block merge. Any new commit on the branch (fix-ups included)
  invalidates test/typecheck and immutable review evidence: re-run those gates
  at the new `headRefOid`. For either earlier adversarial verdict, follow
  `review-protocol.md`'s risk-scoped re-review rule; either request a fresh round or
  record exactly which reasoning still applies and why. The integrator's own
  gate work does not fill a missing challenger slot.
- An advance of the base ref after those exact-head gates fires a separate
  merged-tree gate, regardless of whether the two diffs appear to touch the
  same files. Fetch the current base and PR head, use `git merge-tree
  --write-tree <base-sha> <head-sha>` and `git commit-tree <tree> -p
  <base-sha> -p <head-sha>` to make the prospective two-parent merge commit,
  and hold that throwaway commit on a private ref for the gate's lifetime.
  From the required checkout at that base, run the `review` command with
  `<merge-commit>`; when the PR warrants browser e2e, run it from a detached
  temporary worktree at the same merge commit. Record both the merge commit
  and the exact base-ref SHA in the evidence, then remove the temporary
  ref and worktree. Never push either. Exact-head gates are insufficient once
  the base moves, and `merge-tree` reporting textual mergeability never
  substitutes for the suite on the tree that will ship.
- Inspect candidate contents at the recorded head, never the trusted runner’s
  base checkout, when evaluating acceptance criteria.
- Check an acceptance box on a linked issue only with evidence (command output,
  test name), and check that the diff stays within the declared `Touches` — the
  shared set when the PR closes a batch.

**Re-read before ruling.** Immediately before any ruling — a triage disposition,
an acceptance validation, a tier call, a merge — re-read the linked issue thread
and the PR thread (`gh issue view <n> --comments`, `gh pr view <n> --comments`).
Owner decisions and preparer cross-references land there mid-flight; a ruling made from
session memory can contradict one that was written down while you were
elsewhere.

**Findings.** `review-protocol.md` is the whole findings-conditional protocol —
the durable review request and the wait for its verdict, finding triage, the one batched fix-up
wave per review head, risk-scoped re-review with the round-count rule, and the
exit condition. Read it whenever a PR has a round to request or a finding to
disposition.

## Run the required checks

Determine the required review and gates from the diff and delivery policy.
Request an owed independent review early; perform mechanical checks concurrently
when their inputs and workspaces are independent. Ordinary commands suffice:
do not create an agent per mechanical check. The integrator owns acceptance
judgment, tier classification and durable results.

Every check names the exact commit it examined. Read candidate code at that
commit; run browser checks in its own installed worktree. The immutable review
runner instead uses the trusted base checkout and receives the candidate SHA.
Keep mutating builds out of shared worktrees. Re-read the head before using a
result and apply the freshness rules above when head or base changed.

A criterion needing runtime evidence is not a static pass. Run the appropriate
proof and compare a failing case with the base before calling it environmental.
Record outcomes and links, not gate-agent transcripts or timing reports.

## Immediately before merging

Re-fetch the PR's reviews and comment threads (`gh pr view <n> --comments` plus
review threads via `gh api graphql` — inline review comments don't show in the
former) and confirm zero unaddressed remarks, human or bot, including any that
arrived after the earlier gates passed; anything open is triaged first. Confirm
the PR's base is the project's base branch (`gh pr view <n> --json baseRefName`)
— a stacked PR merges into its parent feature branch and can orphan the reviewed
work; retarget the PR to that branch (or merge the parent first) before merging.

**Tier check.** Classify the PR against delivery-policy.md's "Merge policy" tiers by
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
**An owner decision on the closed issue is also that approval** (`.agents/protocols/delivery-policy.md`,
owner decision 2026-09-05): when the issue carries the owner's dated decision
fixing the PR's intended shape — the shaping confirmation, an `Owner decision`
comment, or the answer that lifted `needs-decision` — verify the diff conforms
to it and that no finding expands it, set `human-approved` yourself with a
comment citing that decision, and merge as tier 2. Park `needs-human` only for
a delta the decision did not cover, and name it; a tier-3 trigger that fired
only in implementation is such a delta unless the decision named it. Never
infer approval from `ready` alone or from an owner comment unrelated to the
PR's shape. Approval covers the intended PR shape plus fix-ups and
non-rewriting synchronization with the base; if later commits materially expand
the design or scope, replace it with `needs-human` and name the delta.
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
report, not the guarantee. Freshness covers the base too, but GitHub provides
no merge argument that binds it: immediately before merging, fetch the base ref
and compare it with the base SHA named by the latest gate
evidence. If it moved after the exact-head gates, or after a prior merged-tree
gate, run the merged-tree gate above against the new base and recheck again;
every observed move repeats that gate, without a file-overlap shortcut. Only
then invoke the merge. `--match-head-commit` still protects only the PR head,
so this immediate fetch-and-recheck is an honest best-effort base guard, not a
claim that another merge cannot land before GitHub executes the command.
Either an observed base move or a head mismatch returns to the applicable
gates.

## After ruling

After a merge, confirm every issue the PR closes auto-closed. Then update the
affected product docs through MCP to the new status quo. If MCP fails, record
the concrete failure and outstanding update on the PR for recovery. Record the result on
the PR. A fresh integrator does not own or restart another session's development
processes.

**Housekeeping, last** (owner direction, 2026-09-01). On every durable outcome —
merge or parked ruling — once the probes on the retained review image are done,
run the project's `housekeeping` command with every review SHA this run built —
each exact head it gated and each merged-tree commit from an observed base
advance — from the same freshly fetched base-ref checkout used for the container
review, and record a concise summary on the PR. It removes the review artifacts
this run left on the host; the project's own command states exactly which, and
supports `--dry-run` to show what it would do.
