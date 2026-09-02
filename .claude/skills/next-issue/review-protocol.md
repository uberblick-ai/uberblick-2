# Review protocol — external rounds, and what happens once a review returns

Read this whenever a PR has an external round to request or a finding to
handle. When CLAUDE.md requires the pair, the implementer owns the first
challenge before handoff, on the other runtime from the diff's author, and the
integrator owns the second, a fresh session of the author's runtime; when it
requires one, the implementer owns that round. These are real adversarial
reads, not gate checks. The integrator owns authoritative dispositions and any
risk-scoped final-head round. `integration.md` beside this file owns the
gates' order and mechanics.

For the required pair, both reviewers read the same frozen candidate head. The
implementer records an evidence response but does not make ordinary P2/P3
corrections between them; after handoff the integrator obtains the second
verdict and batches both. A P1 may interrupt the freeze because another review
of a head already known unsafe buys nothing.

## Requesting the round

CLAUDE.md's gate list is the authority on *when* a pre-handoff review is
required. The implementer opens a draft PR and posts the README's exact-PR
delegation at its current head before starting a fresh
`implementation-reviewer`. Add `Round: N` to that mutable record; the reviewer
edits its status and appends its verdict there rather than posting claim and
completion comments. One transport per *reviewer* runtime — the command
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
`claude -p` carries its own `Claude-Session` trailer. A Claude parent may
instead start the reviewer with the `Agent` tool (`subagent_type:
implementation-reviewer`, `model: opus`). That child shares its launcher's
authorship identity, so it may review only a diff that identity did not
author — proven the way an integrator proves its own independence: no commit
in the head carries the launcher's `Claude-Session` trailer, and the launcher
launched no implementer whose commit is in the head. Under that proof the
`Agent` child is the Claude transport for a Codex-authored diff (owner
decision, 2026-09-01); without it, it is never a reviewer.

`codex exec` selects no `.codex/agents/*.toml` adapter, so the prompt tells a
Codex child to read the `implementation-reviewer` role contract; the Claude
adapter already does. Either assignment names the exact PR, head, child run id
and parent run id, and nothing else — the reviewer contract supplies the
critical brief. Read the verdict from the completed PR record; inspect the
private scratch log only when dispatch fails or no durable verdict appears, so
the child's reasoning transcript does not consume the parent context.

The implementer stays in the assignment, renewing its claim, until the
reviewer completes its durable record. A dispatch failure edits that record to
`Status: failed — <reason>` and is never presented as a review or repeated in a
new failure comment; the integrator later supplies the missing challenge as
well as its own. A further round is never a resumed session — it is a fresh
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

## Finding continuity

The integrator maintains one compact finding-ledger comment per PR and edits it
across heads. Each row has a stable id, the head where it was first established,
its current disposition and one evidence link. Reviewers read it before filing
findings. A settled observation is not a new finding merely because another
runtime assigns a different severity: cite the existing id and add only
material new evidence. Reopen that id only when the affected code changed or a
reproducible supported-usage consequence makes the prior disposition no longer
sound. The integrator updates the row; later rulings link it and discuss only
rows that changed. New reviewer findings use the collision-free id
`R<round>-F<sequence>`; the id does not change when severity or disposition
does. Before dispatching the second reviewer of a required pair, the integrator
initializes or updates the ledger from the first verdict so the second read can
distinguish new evidence from rediscovery.

```text
<!-- uberblick-finding-ledger -->
Finding ledger — PR #N
| ID | First head | Status | Evidence / disposition |
```

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

Collect both challenges', any Copilot and integrator findings against the same
frozen head and triage them all first; then one decision-complete brief, one
implementer pickup, one re-gate at the new head — never a correction between
the required pair and never a pickup per finding or per reviewer. The
implementer's first-review evidence response may reject or clarify a finding,
but for a dual challenge it does not move the head before the integrator's
review. Standing
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
the whole PR only when a fix materially changes the representation or
invalidates earlier reasoning. Once the required pair has returned, another
full-PR round needs a PR record naming that concrete reason; generic freshness,
a new reviewer, or a severity disagreement is not one. Record every round in
its mutable delegation comment as `Review round N (<runtime>, head <sha>):
<verdict>` so round counts stay derivable without separate lifecycle comments.

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

Two successive correction heads that surface new supported-usage defects in
the same hand-built mechanism trigger a representation check before another
local patch. Compare deletion or an established primitive against continuing
the mechanism, and record why the chosen shape can now converge. If the simpler
shape needs authority or a dependency decision the issue does not grant, park
that focused question before paying for a third correction head. Merge tier is
approval routing, never a reason to preserve bespoke correctness machinery.
