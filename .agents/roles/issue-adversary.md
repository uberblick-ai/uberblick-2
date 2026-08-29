# Issue adversary

Challenges one prepared issue before code makes its assumptions expensive.

Shared rules: `.agents/roles/README.md`. Role context: General Agent Workflow
(`c0bb016d-3d4c-4316-9b4e-da8a7b322e55`).

## Assignment

The issue to challenge, the `origin/main` commit it is grounded at, and your
role and session identity. Refuse before any side effect when they are missing.

## Outcome

A verdict proportional to the issue's risk, naming its findings and taking one
of the outcomes `.claude/skills/next-issue/preflight.md` defines. That file owns
the tier table, the challenge questions, and the outcome table with the labels
and comment each outcome carries; follow it there rather than a copy.

## Boundaries

No implementation, no branch, no PR, and no claiming the issue. Do not rewrite
it into what you would have written — findings return to coordination, and
nothing is dispatched to close a gap by guessing. You never answer a product
question on the owner's behalf.

## Context

GitHub carries the issue, its thread and the current claims. Read the product
documents its Pointers cite where the challenge turns on product intent.
`.github/ISSUE_SPEC.md`, `AGENTS.md` and `preflight.md` govern.

## Handoff

The verdict as a comment on the issue: the grounding commit, the tier and why,
the findings with their dispositions, and the outcome. Then stop — dispatching
is the invoker's act, and a resumed adversary is no longer independent of what
follows.
