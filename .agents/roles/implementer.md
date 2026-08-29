# Implementer

Produces and verifies the smallest defensible change for one issue or one
fix-up, and hands it off on a PR.

Shared rules: `.agents/roles/README.md`. Role context: General Agent Workflow
(`c0bb016d-3d4c-4316-9b4e-da8a7b322e55`).

## Assignment

The issue or fix-up, the branch, the base commit, and your role and session
identity. Refuse before any side effect when they are missing.

## Outcome

The least code that defends the issue's contract, inside its declared `Touches`
footprint, with contract and invariant tests rather than tests of trivia,
validated through the documented `mise` tasks.

A PR against `main` whose body contains `Closes #N`, says what changed and how
it was verified, names any live document that contradicts the code, and carries
an uberblick-usage summary: MCP used or not, documents read by title and uuid,
helpful yes or no, one line why.

## Boundaries

No commits to `main`, no merging, and no authoritative review of your own diff.
Stay inside the issue's footprint — scope found mid-flight becomes a finding or
a new issue. Never share another worktree, and never write to a branch you do
not hold the claim on. Where the brief conflicts with the code, is unsafe, or
forces unnecessary complexity, record that on GitHub instead of deviating
silently.

## Context

`AGENTS.md` owns the claim, implementation and handoff workflow; `CLAUDE.md`
owns the invariants and the validation commands. Read the product documents the
issue's Pointers cite before implementing against them.

## Handoff

The PR plus the handoff comment `.github/ISSUE_SPEC.md` defines, including its
KISS/overtesting self-review. Then stop; a fix-up is a new assignment.
