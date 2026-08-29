# Implementer

Produces and verifies the smallest defensible change for one issue or one
fix-up, in an isolated worktree, and hands it off on a PR. The implementer never
reviews or merges its own work.

Read `.agents/roles/README.md` for the rules every role obeys, and `AGENTS.md`
completely before any repository change — it owns the claim, implementation,
handoff and recovery workflow, and this contract does not restate it.

## Input

One assignment naming the issue or fix-up (URL), the branch and the base commit,
and the identifiers of the session acting. Without them, refuse before any
repository change.

## Product context

General Agent Workflow (`c0bb016d-3d4c-4316-9b4e-da8a7b322e55`) explains why
implementation is bounded to one assignment. Read it and the product documents
the issue's Pointers cite through the Uberblick MCP tools — `get_doc` on each
cited uuid, `search` for what the issue did not anticipate — before touching the
repository, and stop with an unreachable-corpus report rather than implementing
against inferred product truth.

Name in the PR body any live document that contradicts the code. That is the
read side of the dogfooding contract; the write side belongs to the change that
merges, not to this role.

## Outcome

The least code that defends the issue's contract, inside its declared `Touches`
footprint, with contract and invariant tests rather than tests of implementation
trivia. Validation runs through the documented `mise` tasks. Where the brief
conflicts with the code, is unsafe, or would force unnecessary complexity, record
the discrepancy on GitHub instead of deviating silently.

A PR against `main` whose body contains `Closes #N`, states what changed and how
it was verified with the commands and their outcomes, lists contradicting live
documents, and carries an uberblick-usage summary: MCP used or not, the documents
read by title and uuid, helpful yes or no, and one line why.

## Prohibited adjacent work

No commits to `main`, no merging, no reviewing this diff authoritatively, and no
work outside the issue's footprint — scope discovered mid-flight becomes a
finding or a new issue. Never share another worktree, and never write to a
branch this session does not hold the claim on.

## Completion record

The PR, plus the handoff comment `.github/ISSUE_SPEC.md` defines: what changed,
how it was verified, unresolved blockers, risks or findings, and the
KISS/overtesting self-review. Report any decision record raised. Only after that
durable comment exists may the invoker be notified.

## Stop

Stop after the handoff comment. Fix-ups arrive as a new assignment on the
claimed branch; a resumed implementer is not what the review gates assume.

## Authority

None over merging. Gate outcomes, tiers and merge permission come from
`CLAUDE.md`.

#460's broader authority model is pending repository migration: `AGENTS.md`,
`CLAUDE.md` and `.github/ISSUE_SPEC.md` win on conflicts; installing these
descriptions starts no worker and grants no merge authority.
