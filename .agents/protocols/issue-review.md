# Issue review — prepared contract

Read [the reviewer entry](../roles/reviewer.md) and shared core first. This
protocol applies only to an issue a preparer sent to review.

## Reviewing an issue contract

Run one proportional, code- and corpus-grounded challenge using
[issue-preparation.md](issue-preparation.md); the issue gets no second pass.
Reconstruct from the issue, its thread, relevant code and evidence; read the
live product documents its Pointers cite where intent matters. Challenge the
idea and product intent as well as feasibility and practicality: is the proposed
outcome useful and justified? Look for wrong assumptions, missing outcomes or
invariants, infeasible or over-prescribed scope, conflicts with current work
and unnecessary complexity. When warranted, offer materially better or smaller
alternatives with evidence and meaningful tradeoffs; do not force alternatives.

Apply [library and custom-mechanism choices](delivery-policy.md#library-and-custom-mechanism-choices);
an unresolved protected dependency choice is a maintainer boundary.

Honor settled authorization. New evidence may justify recommending a change
to settled intent or decisions, never silently redefining them or reflexively
reopening them. Changed outcomes or guarantees and unresolved maintainer choices use
[human-decisions.md](human-decisions.md), including its
[decided-record procedure](human-decisions.md#challenge-a-decided-record) where applicable.

Classify each finding:

- `correctable` — repository evidence or settled intent is sufficient for a
  meaning-preserving issue edit. Apply a correctable P3 to the body yourself
  and note it in the verdict; the preparer applies a correctable P1 or P2;
- `owner-boundary` — product or agent authority, safety, or the fundamental
  work shape needs a person's decision; escalate it yourself. A
  [visible edge case](review-protocol.md#findings) is never one: add it to the
  body as a known limit and continue.

Make no other issue edit, and do not turn implementation preferences into
requirements.

## Outcomes and handoff

- `approve` — no material findings, or only correctable P3s you applied.
- `changes` — a correctable P1 or P2.
- `needs-human` — an owner-boundary finding; escalate it yourself under
  [human-decisions.md](human-decisions.md).
- `defer` — no live document covering the judgment could be read under
  [AGENTS.md's read rules](../../AGENTS.md#read-for-the-action); name what was
  searched and the failure.

Post the verdict once as an issue comment. It opens with
`Verdict: <no findings | P1 <n>, P2 <n>, P3 <n>>`, then the findings;
the summary links it.
