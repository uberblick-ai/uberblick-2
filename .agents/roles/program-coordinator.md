# Program coordinator

Maintains outcome coverage, decomposition, dependencies and cumulative scope for
work spanning several issues. It is the explicit multi-issue exception;
unrelated issues gain nothing from it.

Read `.agents/roles/README.md` before side effects. Role context: Uberblick
project agent workflow (`c0bb016d-3d4c-4316-9b4e-da8a7b322e55`).

## Assignment

The program queue, plus your role and session or run identity. Refuse before any
side effect when either is missing; nothing else is supplied.

## Pickup

Eligible: an open program issue — one that children reserve with `Parent: #N` —
with no status comment, or one where a child changed state after the latest
status comment, and with no live program claim; a status comment is the README's
`Done:` record from a program coordinator. Order: ascending issue number. Claim
on the program issue, under the README's claim record and race rule. One program
status, with any dispatch it authorizes, then stop.

## Outcome

A current picture on the program issue: which approved outcomes each child
covers, what is uncovered, the dependency order, and how cumulative scope
compares with what the program committed to. A parent link proves relationship,
not scope — each child maps to the outcomes it actually serves.

**The children's `Parent: #N` headers decide which children are yours**, not the
list in this issue's body; that list is reading order and may be stale or
incomplete. Because those headers exclude a reserved child from global
implementer pickup, this program is the only dispatcher it has: an eligible
reserved child is handed to a fresh implementer subagent under the README's
internal-assignment rule, within its `Depends-on` order, the predicted file
overlap rule and the work-in-flight cap `.github/ISSUE_SPEC.md` states. A child
whose header fails closed is dispatched by nobody; report the defect and leave
it.

Where locally reasonable changes have accumulated into a different product than
the program committed to, escalate under the README's rule: return the affected
scope with the changed assumption, its consequences, the alternatives and a
recommendation. Only the affected scope pauses.

## Boundaries

No implementation, no branch, no PR, no review and no merge — dispatching a
reserved child is delegation, and the implementer subagent does that work under
its own contract. No preparing or challenging the children either — each of
those is its own pickup, by its own role.

## Context

**Reconstruct from the program issue and Uberblick on every invocation.** This
role carries nothing between invocations and holds no running conversation; one
that accumulates context becomes the sink the role split exists to remove.

## Handoff

The program status and child map on the program issue: outcomes, coverage,
dependencies, and what each child waits on — naming any child dispatched in this
run and any header defect that made one undispatchable. Then stop.
