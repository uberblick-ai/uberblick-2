# Review protocol — external rounds, and what happens once a review returns

Read this whenever a PR has an external round to request or a finding to
handle. The implementer owns the first required critical round before handoff;
the integrator owns authoritative dispositions and any final-head round.
`integration.md` beside this file owns the gates' order and mechanics.

## Requesting the round

CLAUDE.md's gate list is the authority on *when* a local Codex review is
required. The implementer opens a draft PR and posts the README's exact-PR
delegation at its current head before starting a fresh
`implementation-reviewer`. An Opus implementer calls Codex with the same
validated transport as issue preparation:

```sh
codex exec -s workspace-write -c 'sandbox_workspace_write.network_access=true' - < <prompt-file> > <scratch-log> 2>&1
```

This command selects no `.codex/agents/*.toml` adapter, so the prompt tells the
child to read the `implementation-reviewer` role contract. A Codex implementer
uses a different Codex session where one is available. The assignment names the
exact PR, head, child run id, and implementer parent run id, and nothing else
— the reviewer contract supplies the critical brief. Read the verdict from the
PR; inspect the private scratch log only when dispatch fails or no durable
verdict appears, so the child's reasoning transcript does not consume the
parent context.

The implementer stays in the foreground until the reviewer writes its durable
verdict. A dispatch failure is recorded on the PR, never presented as a review;
the integrator later supplies any still-required round. A further round is never
a resumed session — it is a fresh reviewer at the new head, within the
re-review scoping below. Every brief says: be critical, and hunt specifically
for overtesting and overengineering per this repo's principles (KISS/YAGNI,
least code wins, tests defend contracts and invariants rather than
implementation trivia).

## Author-owned refinement

For a review delegated by an implementer, the author applies clearly correct,
in-scope findings in one batch and answers the others with evidence. Those
answers are inputs, not dispositions. It requests no second pre-handoff round.
A correction makes the earlier exact-head verdict stale as gate evidence, but
not useless: the findings and author's responses remain durable input to the
integrator, which decides whether the final head needs another external read.

## Finding triage — before any fix-up brief

A finding is not automatically a work item; every finding is triaged explicitly
against the supported usage model (single user, local-first, one hub, parallel
loop-dispatched agents, dev-stage data). Record three independent decisions per
finding — severity does not decide the other two:

- **Severity.** P1: supported usage can lose data, expose secrets, violate a
  CLAUDE.md invariant, or become materially unusable. P2: a real correctness,
  reliability, accessibility, or maintainability defect within supported usage,
  without P1 impact. P3: minor, local, or low-impact.
- **Disposition.** *Fix now* — the default for P1 and for contained
  supported-usage P2s. *Defer* — only for a non-blocking P2/P3 whose fix is
  disproportionate right now: create a linked issue and record the concrete
  accepted risk on the PR; never defer data loss, auth/security exposure, or a
  violated invariant. Queue an implementable deferral with `needs-preparation`.
  If the finding already identifies a product or authority choice, create it at
  `needs-decision` with the focused question, options and recommendation instead
  of paying a preparation/adversary pass to rediscover the same boundary.
  *Document boundary* — reachable only outside the usage
  model: the smallest useful code/doc statement naming the boundary; no behavior
  changes, no mechanism tests for an unsupported scenario. *Reject* — not
  reachable, factually wrong, or cost clearly exceeds stake: reply with evidence
  on the thread. Never silent dismissal, and no category shortcuts ("human-run
  commands can't race" is false here — parallel agents, retries and multiple
  terminals make nominally human-run commands concurrent).
- **Verification.** Who confirms the fix: the integrator (focused diff read,
  the finding's test failing-then-passing, failure-path probe where stateful) or
  an external re-review round per the scoping below. A subtle P2 fix may need
  outside eyes; a tiny P1 correction with a focused proof may not.

## One batched fix-up wave per review head

Collect Codex, Copilot and integrator findings against the same head and triage
them all first; then one decision-complete brief, one implementer pickup, one
re-gate at the new head — never a pickup per finding or per reviewer. Standing
brief constraints: smallest diff that closes the accepted findings; tests only
for the contract or invariant a finding names, never for the mechanics of the
fix. Fix-up diffs face the same Touches, scope-escape and overtesting checks as
feature diffs. Late findings still get an explicit disposition, but reviewer
timing must not manufacture extra waves.

## Risk-scoped external re-review

A further Codex round is required while a P1 remains open; and for a P2/P3 fix
when it sits at a data-critical boundary (security/auth, persistence,
concurrency, schema/CRDT semantics, cross-process lifecycle) **and** is
non-local, introduces new state or synchronization, changes the design that
answered the original finding, or lacks a focused test proving it — a one-line
mechanical fix at such a boundary, proven by its test, is integrator territory;
and whenever reviewer or integrator names a concrete risk rationale. Re-review
briefs are delta-first: the fixes and the invariants they touch, expanding to
the whole PR only when a fix invalidates earlier reasoning. After four external
rounds, a further full round needs a PR comment naming the concrete unresolved
risk. Record every round as a PR comment — `Codex round N (head <sha>):
<verdict>` — so round counts stay derivable from the thread.

## Exit and convergence

Review exits only when: no P1 remains; every supported-usage P2 is fixed or
explicitly deferred (linked issue, accepted-risk rationale); every remark is
fixed, deferred, documented or rejected explicitly; all gate evidence is fresh
at the exact merge head; and any earlier external-review reasoning carried
across a later local fix is recorded on the PR with scope and rationale. If a
confirmation round surfaces a net-new triaged P1, or the open-P1 set fails to
shrink after a directed correction wave, park the PR `needs-human` with the
finding list instead of looping — but never park for a false positive, an
unrelated pre-existing issue, or a finding rejected with evidence.
