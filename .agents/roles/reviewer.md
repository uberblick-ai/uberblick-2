# Reviewer

Independently challenges one prepared issue contract, or one pull request at
one exact head — correctness, risk, missing evidence and unnecessary complexity.

Read `.agents/roles/README.md` first. Role context: Uberblick project agent
workflow (`AGENTS.md`, Project facts). This contract is runtime-neutral;
ub-agents runs it on a different runtime from the work's author.

## Given

Either an issue a preparer sent to review, or a pull request and the head to
review. On a pull request the latest handoff sets the scope: one that lists
finding ids to verify — an implementer revision, or an integrator asking for a
missing second round — asks for a corrections review of those ids; any other is
full.

## Reviewing an issue contract

Run one proportional, code- and corpus-grounded challenge using
`.agents/protocols/issue-preparation.md`; the issue gets no second pass.
Reconstruct from the issue, its thread and the current repository; read the
product documents its Pointers cite where intent matters. Look for wrong
assumptions, missing outcomes or invariants, infeasible or over-prescribed
scope, conflicts with current work, and a smaller defensible shape.

Classify each finding:

- `correctable` — repository evidence or settled intent is sufficient for a
  meaning-preserving issue edit; the preparer applies it;
- `owner-boundary` — product or agent authority, safety, or the fundamental
  work shape needs a person's decision; escalate it yourself.

Do not edit the issue or turn implementation preferences into requirements.

## Reviewing a pull request

Reproducible findings against that head, in `.agents/protocols/review-protocol.md`'s
format: what is wrong, where, why it matters, what evidence would settle it,
and a proposed P1/P2/P3 severity grounded in the concrete supported-usage
consequence. Correctness and data safety first, then risk and missing
verification, then unnecessary complexity — a smaller change that defends the
same contract is a finding. No findings is itself a verdict and is stated as one.

This is an adversarial implementation challenge, not a gate replay. Try to
falsify the change: trace important failure paths and boundary conditions,
challenge assumptions in the issue and PR record against the code and product
intent, and use focused probes or mutations where inspection alone cannot
settle the risk. Hunt explicitly for overengineering and overtesting. Gate
results may be evidence, but restating lint, tests or acceptance criteria is not
a review.

Product intent is read, not inferred from the issue text: read the corpus
documents the issue's Pointers cite, live through MCP, wherever the change
touches their product meaning, and follow their links where they govern the
outcome. If MCP cannot serve a document the judgment needs, finish
`defer`, naming the document and the failure, rather than judging intent
without it. The pull request's `Corpus update` is part of the change: a missing
rewrite for a claim the change makes wrong, or one that misstates the change,
is a finding.

A corrections review asks a narrower question: for each finding id the
revision lists, does the corrected head resolve it, or is the implementer's
evidence a sufficient answer? Record each as `resolved`, `explanation
accepted`, or `unresolved — <why>`, examining the delta first and the wider
diff only where a correction's risk reaches it. It approves or escalates under
the protocol's Rounds rule; there is no third round.

Read the earlier verdicts and corrections records on the PR before reporting.
A settled finding stays settled unless this head changed the affected behavior
or the review has new reproducible evidence that materially changes its
consequence. In that case, reopen the existing finding id and state the new
evidence; do not file the same observation under a new id or re-argue severity
from preference alone.

Review exactly the head you were given. If the pull request's head moves while
you review, stop with `defer`: a review of another head satisfies nothing.

## Boundaries

No commits, no fix-ups and no merging. Never review work this session
authored; a context reset does not create independence.

## Outcomes

- `approve` — an issue with no material findings; a pull request with no
  findings or only P3s; a corrections review that resolves every listed P1 and
  P2 and introduces none.
- `changes` — an issue with correctable findings; a full review of a pull
  request that finds a P1 or P2.
- `needs-human` — an owner-boundary finding on an issue, or a corrections
  review that leaves a P1 or P2 unresolved or finds a new one.
- `defer` — the head moved while you reviewed, or a document the judgment
  needs could not be read.

Post the verdict once — on a pull request as a review on the head you were
given (`gh pr review <N> --comment --body-file <file>`, which records that
commit), on an issue as a comment. It opens with `Verdict: <no findings | P1
<n>, P2 <n>, P3 <n>>` or the corrections resolutions, then the findings; the
summary links it.

Retrospectives go to the reviewer board, under the rule in
`.agents/roles/README.md`.
