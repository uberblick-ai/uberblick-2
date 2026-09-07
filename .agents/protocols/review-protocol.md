# Review protocol — independent rounds, and what happens once a review returns

Read this whenever a PR owes a review, carries a request to answer, or has a
finding to handle. delivery-policy.md's "Reviews owed" table is the authority on
how many challenges a candidate owes and who requests each; this file owns the
durable request, the wait, the reviewer's records and the correction cycle.
`integration.md` beside it owns the gates' order and mechanics. These are real
adversarial reads, not gate checks. The integrator owns authoritative
dispositions and any risk-scoped final-head round.

No role starts a reviewer as its own child. The role that owes a round posts a
request on the PR; a separately launched `implementation-reviewer` session
selects that request from GitHub, claims it under `.agents/roles/README.md`'s
claim and race rules, and answers it there. Both sides work from the durable
record, so neither waits on the other's runtime to deliver a result.

## The review request

One comment on the PR, posted by the role that owes the round — the implementer
before its handoff, the integrator for the second owed challenge and for a
risk-scoped round of its own:

```text
Review-request: implementation-reviewer
Round: <n>
Head: <candidate sha>
Runtime: <claude|codex>
Requester: <implementer|integrator> <claude|codex> <run id>
Scope: full | corrections <finding ids>
```

`Runtime:` is the runtime the round must run on — the other runtime from the
diff's author for the first challenge, the author's runtime for the second — and
a reviewer session on any other runtime leaves the request alone rather than
consuming it. A `Round: 2` of delivery-policy.md's required pair also carries one
`Boundary:` line naming which listed boundary fires, or the concrete unresolved
risk; a package path is neither, and without that line the round is not
requested. `Scope: corrections` names the finding ids the requester corrected or
answered and asks for nothing else.

A request is current while it is the newest `Review-request:` on the PR, carries
no `Superseded:` line, and its `Head:` is still the PR's head. Anything else is
spent. A moved head therefore supersedes its own request: a requester that
changes the head posts a fresh request rather than retargeting the old one, and
a requester that no longer wants the round edits its own request to append
`Superseded: <reason>`. A reviewer never consumes a spent request, and a verdict
at a head the PR has moved past does not satisfy the round that head owed.

## Waiting for a verdict

The requester stays in its own assignment, renewing its claim on README's
cadence, and waits on inexpensive GitHub reads: re-read the PR thread every few
minutes for a reviewer record naming this request and head. Nothing is
delegated, so no result has to survive another runtime. A helper may do that
polling and renewal; it reads GitHub and renews, and it never interprets a
finding or chooses a disposition.

The wait ends when

- the verdict for this request appears — read it from the PR, never from a
  private transcript;
- the request is spent, or ownership is lost: a valid takeover of the
  requester's own claim, or a head that moved for a reason this role did not
  make. Stop, leaving the durable record as it stands;
- a permission or authentication failure blocks the reads. Stop with the role's
  `Blocked` line naming the refused command;
- it goes unanswered: no reviewer claim on the request about 90 minutes after
  it was posted, or a reviewer claim that went stale under README without a
  verdict. Record `Waiting: unanswered — <what was observed>` on the request at
  once rather than at the end of the run, and hand off. The round is still owed,
  and the integrator's gate is what sees that.

## Claiming and answering a request

A reviewer claims the request on the PR under README's claim grammar and race
rule, naming the head it will review and the request it answers:

```text
Claim: implementation-reviewer <run id>
Head: <candidate sha>
Request: <request comment URL>
```

Two sessions never own one request: the earliest valid claim wins and a loser
withdraws in one line. A reviewer that stops without a verdict is recovered
through README's staleness and takeover rules, not through a second
coordination authority. The reviewer reviews that head only and records its
result in one comment:

```text
Done: implementation-reviewer <run id>
Head: <candidate sha>
Request: <request comment URL>
Verdict: <no findings | P1 <n>, P2 <n>, P3 <n>>
```

followed by the findings, or by the resolutions a `corrections` scope asked for.
A head that moves during the review is drift: report it and stop rather than
retargeting; a review at the new head is a new request and a new pickup.

Every review is critical: try to falsify the implementation with focused
failure-path or mutation probes, and hunt specifically for overtesting and
overengineering per this repo's principles (KISS/YAGNI, least code wins, tests
defend contracts and invariants rather than implementation trivia).

## Findings and corrections

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

The implementer may correct a finding on its branch or answer it with evidence,
but it cannot settle one alone. Every finding it corrected or answered goes back
in a `Scope: corrections` request at the corrected head, and the reviewer that
takes it records each named id as `resolved`, `explanation accepted`, or
`unresolved — <why>`. An unresolved material disagreement stands for the
integrator; no round is opened to argue severity. A finding the implementer
neither corrects nor answers needs no corrections round: it stands as written,
for the integrator to disposition.

When two challenges are owed, both are collected on the same head before any
ordinary correction, so the implementer corrects nothing at that stage: it hands
off the first verdict at the frozen head and the integrator requests the second
there. Only a P1 breaks the freeze, and its corrected head re-establishes the
evidence delivery-policy.md requires. Then one batched fix-up brief carries the
finding IDs, required outcomes and verification. Include P3 corrections only
when local and inexpensive; they must not drive a redesign or another round.

The integrator chooses the disposition. Fix P1s and contained supported-usage
P2s. A branch-caused failure of a required check must be fixed. A non-blocking P2
may be deferred to a linked issue with its accepted consequence recorded; never
defer data loss, security exposure, or violated invariants. Accept P3s without
creating issues by default. Reject unsupported findings with a brief
evidence-based reason. A finding the integrator raises after the initial review
becomes a focused correction request on the PR, which a fresh implementer
session takes as its own pickup.

## Verification and completion

The integrator verifies corrections through focused diff inspection and
relevant tests or failure-path probes. Tests defend the affected contract, not
the implementation mechanism.

Repeat a *challenge* only when a correction introduces a concrete unresolved
risk or invalidates that challenge's earlier reasoning. Record the risk,
affected verdict, and review scope, then post a fresh full-scope request at the
new head. A new head, severity disagreement, or P3-only verdict is insufficient.
A `corrections` round is not a repeated challenge: it verifies the named
findings at the corrected head and nothing else. Replacement reviews examine the
delta first and use the runtime of the verdict they replace.

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
