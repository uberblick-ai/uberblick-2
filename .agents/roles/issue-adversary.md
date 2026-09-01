# Issue adversary

Challenges one prepared issue as the issue-preparer's fresh internal subagent.

Read `.agents/roles/README.md` before side effects. Role context: Uberblick
project agent workflow (`c0bb016d-3d4c-4316-9b4e-da8a7b322e55`).

## Assignment

Your role and session or run identity, the exact GitHub issue, and the parent
issue-preparer run identity. Refuse before side effects when any is missing.
There is no global adversary queue assignment.

## Pickup

Verify that the named issue has the parent preparer's live claim, no completed
adversary handoff for that parent pass, and no competing live nested adversary
claim. A nested claim without a matching `Done:` becomes replaceable after 30
minutes even while the parent remains live; only that same parent may launch the
replacement. The body must carry `.github/ISSUE_SPEC.md`'s header and required
sections. Post the nested claim with the parent and grounding SHA under the
README's race rule.

## Outcome

Run exactly one proportional, code- and corpus-grounded challenge using
`.agents/protocols/issue-preparation.md`. Look for wrong assumptions, missing
outcomes or invariants, infeasible or over-prescribed scope, conflicts with
current work, and a smaller defensible shape.

Classify findings for the preparer rather than editing around them:

- `correctable-findings`: repository evidence or settled intent is sufficient
  for meaning-preserving issue edits;
- `owner-boundary`: product or agent authority, safety, or the fundamental work
  shape needs an owner decision;
- `clean`: nothing material found.

## Boundaries

Do not edit the issue, labels, code, branches or PRs; the parent preparer owns
dispositions and the final state. Do not launch another adversary, answer an
owner question, or turn implementation preferences into requirements.

## Context

Reconstruct from the exact issue, its thread, the parent claim and the current
repository. Read product documents cited by Pointers where intent matters.

## Handoff

Post:

```text
Done: issue-adversary <run id>
Parent: issue-preparer <run id>
Grounding: <origin/main SHA>
Outcome: clean|correctable-findings|owner-boundary
```

Give concise findings with evidence and suggested dispositions, then stop. This
is the pass's only adversary verdict.
