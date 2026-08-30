# integration — advancing one PR through the gates to a merge

The mechanics of the `integrator` role, for one PR at one head SHA. CLAUDE.md's
"Development workflow" owns *which* gates exist and when each applies, the Codex
round included; drive them in the order it lists. This file owns only their
mechanics, and `review-protocol.md` beside it owns the findings-conditional
protocol.

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
- Record every gate result against the commit SHA it ran at — container review,
  CI, the acceptance validation, the Codex verdict where that gate applied, the
  Copilot state. Any new commit on the branch (fix-ups included) invalidates
  test/typecheck and immutable review evidence: re-run those gates at the new
  `headRefOid`. For an earlier Codex verdict, follow `review-protocol.md`'s
  risk-scoped re-review rule; either run a fresh round or record exactly which
  reasoning still applies and why.
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

## Immediately before merging

Re-fetch the PR's reviews and comment threads (`gh pr view <n> --comments` plus
review threads via `gh api graphql` — inline review comments don't show in the
former) and confirm zero unaddressed remarks, human or bot, including any that
arrived after the earlier gates passed; anything open is triaged first. Confirm
the PR's base is `main` (`gh pr view <n> --json baseRefName`) — a stacked PR
merges into its parent feature branch and silently orphans the reviewed work
(this happened: #13 into feat/hub, re-landed as #25); retarget the PR to `main`
(or merge the parent first) before merging.

**Tier check.** Classify the PR against CLAUDE.md's "Merge policy" tiers by
reading its full diff (`gh pr diff <n>`) and how its review findings were
dispositioned — never from the issue's `Touches`. `--name-only` is just the
pathname inventory: it identifies hunks to classify but never fires tier 3 by
itself. The triggers live in the change — for example breaking persisted-data
compatibility rather than an additive optional schema field; authority or merge
rules rather than routine process clarification; a runtime dependency rather
than a dev dependency; auth/token semantics; a decided-architecture or
invariants edit; or overruling a major Copilot/Codex finding. A tier-3 trigger
means you do not merge: label the PR `needs-human`, comment which trigger fired,
fire a PushNotification naming the PR and the trigger so the owner learns a
merge decision awaits them, then park it and report.

**Exception — `human-approved`.** A PR carrying the owner-set `human-approved`
label is merge-authorized: execute the merge as tier 2 (merge report first),
every other gate unchanged — evidence fresh at the exact merge head, zero
unaddressed remarks. The owner sets the label directly or explicitly directs a
session to set it for named PRs; that session posts the direction as provenance.
Never infer approval from `ready` or an unrelated owner comment. Approval covers
the intended PR shape plus fix-ups and rebases; if later commits materially
expand the design or scope, replace it with `needs-human` and name the delta.
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
report, not the guarantee. Either way a mismatch returns to the gates: re-run
them at the new head.

## After merging

Confirm every issue the PR closes auto-closed. Then update the product docs to
the new status quo (uberblick MCP tools once registered; until then, comment on
the PR that the doc update is pending), and restart the dev stack per
`dev-stack.md`. Record the result on the PR.
