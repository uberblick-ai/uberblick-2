# Review protocol — findings, corrections and convergence

Read this whenever a PR has a review to give, a finding to handle or a
correction to verify. delivery-policy.md's "Reviews owed" table decides which
reviews a candidate owes; ub-agents runs them at the candidate head, and
`integration.md` beside this file owns the gates' order and mechanics. These are
real adversarial reads, not gate checks. The integrator owns authoritative
dispositions.

Every review is critical: try to falsify the implementation with focused
failure-path or mutation probes, and hunt specifically for overtesting and
overengineering per this repo's principles (KISS/YAGNI, least code wins, tests
defend contracts and invariants rather than implementation trivia).

## Findings

Reviewers record findings using stable IDs (`R<round>-F<number>`). Each finding
names the affected code, supported-usage consequence, proposed severity, and
reproducible evidence. Separate observations from assumptions. Record successful
probes only when they resolve a finding or establish a material limitation.

The integrator maintains one finding ledger: ID, disposition, evidence link, and
verification result. Evidence stays in the reviewer's verdict; later records
link to it. Existing findings retain their IDs across heads. Reopen settled
findings only when changed code or new evidence invalidates the disposition.

Severity follows impact:

- **P1:** data loss, secret exposure, violated invariant, or materially unusable
  supported behavior.
- **P2:** another concrete defect in supported usage.
- **P3:** minor or theoretical impact.

## Corrections

The implementer may correct a finding on its branch or answer it with evidence,
but it cannot settle one alone. Its revision names every finding it corrected or
answered, and the review that raised them verifies them at the corrected head,
recording each id as `resolved`, `explanation accepted`, or `unresolved — <why>`.
An unresolved material disagreement stands for the integrator; no round is
opened to argue severity. A finding the implementer neither corrects nor answers
needs no corrections review: it stands as written, for the integrator to
disposition.

When two reviews are owed, both review the same head before any correction.
Then one batched revision carries the finding IDs, required outcomes and
verification. Include P3 corrections only when local and inexpensive; they must
not drive a redesign or another round.

The integrator chooses the disposition. Fix P1s and contained supported-usage
P2s. A branch-caused failure of a required check must be fixed. A non-blocking P2
may be deferred to a linked issue with its accepted consequence recorded; never
defer data loss, security exposure, or violated invariants. Accept P3s without
creating issues by default. Reject unsupported findings with a brief
evidence-based reason. A finding the integrator raises after the initial review
goes back to the implementer as a focused fix-up brief in its ruling.

## Verification and completion

The integrator verifies corrections through focused diff inspection and
relevant tests or failure-path probes. Tests defend the affected contract, not
the implementation mechanism.

Repeat a full review only when a correction introduces a concrete unresolved
risk or invalidates that review's earlier reasoning: the integrator records the
risk, the affected verdict and the review scope, and finishes `more-review`. A
new head, severity disagreement, or P3-only verdict is insufficient. A
corrections review is not a repeated challenge: it verifies the named findings
at the corrected head and nothing else.

Merge requires delivery-policy.md's gates, no open P1, and an explicit disposition for
every finding. Record carried-forward review evidence with a brief scope and
rationale. The final ruling links to the ledger and gate results without
repeating them.

If a confirmation review finds a new P1, or a correction wave does not reduce the
open P1 set, park for an owner decision. The integrator settles P2/P3
disagreements after one implementer response; escalate only a specific
unresolved decision.

Before a third correction head since opening or the latest owner decision, park
with one question identifying the mechanism preventing convergence. An owner
instruction to continue resets the count.
