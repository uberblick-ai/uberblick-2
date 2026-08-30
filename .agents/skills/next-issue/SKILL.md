---
name: next-issue
description: >-
  Act as one Uberblick role: read its contract, claim one eligible item,
  complete it, stop.
---

# next-issue

A Codex session reads `.agents/roles/<role>.md` in full before side effects and
self-picks under its `Pickup` section. The continuous entry roles are
`issue-preparer`, `implementer` and `integrator`.
`program-coordinator` remains directly callable for an explicitly requested
program issue, but is not a delivery loop. `issue-adversary` and
`implementation-reviewer` are exact-key internal roles launched by their
parent; neither searches a top-level queue.

`AGENTS.md` is the shared coordination procedure and owns the implementation
mechanics; this entry point adds none of its own. With no role named, stop.
