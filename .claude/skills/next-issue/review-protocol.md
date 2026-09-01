# Review protocol — external rounds, and what happens once a review returns

Read this whenever a PR has an external round to request or a finding to
handle. When CLAUDE.md requires the pair, the implementer owns the first
challenge before handoff, on the other runtime from the diff's author, and the
integrator owns the second, a fresh session of the author's runtime; when it
requires one, the implementer owns that round. These are real adversarial
reads, not gate checks. The integrator owns authoritative dispositions and any
risk-scoped final-head round. `integration.md` beside this file owns the
gates' order and mechanics.

## Requesting the round

CLAUDE.md's gate list is the authority on *when* a pre-handoff review is
required. The implementer opens a draft PR and posts the README's exact-PR
delegation at its current head before starting a fresh
`implementation-reviewer`. One transport per *reviewer* runtime — the command
is chosen by the runtime the round must run on, not by the caller's, so a
same-runtime round (a `--codex` integrator on a Codex-authored PR) uses the
same two commands. Both run from the parent's own worktree, detached (a
foreground shell call is killed at ten minutes), with the prompt read from a
file and the log kept in private scratch:

```sh
# A Codex reviewer — the transport issue preparation validated.
codex exec -s workspace-write -c 'sandbox_workspace_write.network_access=true' - < <prompt-file> > <scratch-log> 2>&1

# A Claude reviewer — the project adapter selects the role.
claude -p --agent implementation-reviewer --model opus --permission-mode bypassPermissions < <prompt-file> > <scratch-log> 2>&1
```

Each is a fresh top-level session: `codex exec` always is, and a headless
`claude -p` carries its own `Claude-Session` trailer, unlike an `Agent`-tool
child, which shares its launcher's authorship identity and is never a
reviewer.

`codex exec` selects no `.codex/agents/*.toml` adapter, so the prompt tells a
Codex child to read the `implementation-reviewer` role contract; the Claude
adapter already does. Either assignment names the exact PR, head, child run id
and parent run id, and nothing else — the reviewer contract supplies the
critical brief. Read the verdict from the PR; inspect the private scratch log
only when dispatch fails or no durable verdict appears, so the child's
reasoning transcript does not consume the parent context.

The implementer stays in the assignment, renewing its claim, until the
reviewer writes its durable verdict. A dispatch failure is recorded on the PR,
never presented as a review; the integrator later supplies the missing
challenge as well as its own. A further round is never a resumed session — it is a fresh
reviewer at the new head, within the re-review scoping below. Every brief says:
be critical, try to falsify the implementation with focused failure-path or
mutation probes, and hunt specifically for overtesting and overengineering per
this repo's principles (KISS/YAGNI, least code wins, tests defend contracts and
invariants rather than implementation trivia).

## Challenge freshness

The two challenges need not be repeated automatically after every correction.
Their reasoning may carry across a later head only under the risk-scoped rule
below, recorded separately for the two verdicts. If a fresh round is
required, use the same runtime as the stale challenge it replaces unless the
required runtime is unavailable; record an unavailable runtime as a failed
dispatch, never as equivalent evidence.

## Finding triage — before any fix-up brief

A finding is not automatically a work item; every finding is triaged explicitly
against the supported usage model (single user, local-first, one hub, parallel
loop-dispatched agents, dev-stage data). Record three independent decisions per
finding — severity does not decide the other two:

- **Severity.** P1: supported usage can lose data, expose secrets, violate a
  CLAUDE.md invariant, or become materially unusable. P2: a real correctness,
  reliability, accessibility, or maintainability defect within supported usage,
  without P1 impact. P3: minor, local, or low-impact. Name the concrete
  supported-usage consequence; fix size or reviewer confidence does not change
  severity.
- **A branch-caused red gate is fix-now.** When a required check is green at the
  base and red at the reviewed head, the branch must restore it even when the
  stale code is a test fixture rather than production. Severity still follows
  impact; it is not inferred from the word `test`.
- **Disposition.** *Fix now* — the default for P1 and for contained
  supported-usage P2s. *Defer* — only for a non-blocking P2/P3 whose fix is
  disproportionate right now: create a linked issue and record the concrete
  accepted risk on the PR; never defer data loss, auth/security exposure, or a
  violated invariant. Queue an implementable deferral with `needs-preparation`.
  If the finding already identifies a product or authority choice, create it at
  `needs-decision` with the focused question, options and recommendation instead
  of paying a preparation/adversary pass to rediscover the same boundary.
  *Accept debt / wontfix* — for a P3, or a P2 whose claimed impact remains
  theoretical because no current supported-usage failure is established,
  record the consequence and why another delivery cycle is disproportionate,
  without creating a linked issue. When an issue already exists, close it as
  not planned with `wontfix`. A concrete bug observed later is new evidence and
  may be filed or reopened then. Never use either route for data loss,
  auth/security exposure, or a violated invariant.
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

Collect both challenges', any Copilot and integrator findings against the same head
and triage them all first; then one decision-complete brief, one implementer
pickup, one re-gate at the new head — never a pickup per finding or per
reviewer. Standing
brief constraints: smallest diff that closes the accepted findings; tests only
for the contract or invariant a finding names, never for the mechanics of the
fix. Fix-up diffs face the same Touches, scope-escape and overtesting checks as
feature diffs. Late findings still get an explicit disposition, but reviewer
timing must not manufacture extra waves.
Once all required challenges have returned and no P1 or supported-usage P2
remains, a later P3-only verdict does not justify another external round. The
integrator dispositions it and verifies any accepted local correction directly.

## Risk-scoped external re-review

A further external round is required while a P1 remains open; and for a P2/P3 fix
when it sits at a data-critical boundary (security/auth, persistence,
concurrency, schema/CRDT semantics, cross-process lifecycle) **and** is
non-local, introduces new state or synchronization, changes the design that
answered the original finding, or lacks a focused test proving it — a one-line
mechanical fix at such a boundary, proven by its test, is integrator territory;
and whenever reviewer or integrator names a concrete risk rationale. Re-review
briefs are delta-first: the fixes and the invariants they touch, expanding to
the whole PR only when a fix invalidates earlier reasoning. After four external
rounds, a further full round needs a PR comment naming the concrete unresolved
risk. Record every round as a PR comment — `Review round N (<runtime>, head
<sha>): <verdict>` — so round counts stay derivable from the thread.

## Exit and convergence

Review exits only when: no P1 remains; every supported-usage P2 is fixed or
explicitly deferred (linked issue, accepted-risk rationale); every remark is
fixed, deferred, accepted, documented or rejected explicitly; all gate evidence
is fresh
at the exact merge head; and any earlier external-review reasoning carried
across a later local fix is recorded on the PR with scope and rationale. If a
confirmation round surfaces a net-new triaged P1, or the open-P1 set fails to
shrink after a directed correction wave, park the PR `needs-human` with the
finding list instead of looping. Do not debate a P2/P3 label through fresh
rounds: after one implementer evidence response or correction wave, the
integrator rules from supported-usage impact; if it still cannot, park
`needs-human` with the finding and one focused owner question. Never park for a
false positive, an unrelated pre-existing issue, or a finding rejected with
evidence.
