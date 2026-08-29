---
name: next-issue
description: >-
  Act as one Uberblick role: read its contract, claim one eligible item,
  complete it, stop.
---

# next-issue

A Codex session reads `.agents/roles/<role>.md` in full before side effects and
self-picks under its `Pickup` section. The intended entry roles are
`issue-preparer`, `implementer` and `program-coordinator`, but until their
delivery handoffs are orchestrated, `implementation-reviewer` and `integrator`
also remain directly callable, self-picking queue roles through this interim
skill. `issue-adversary` is not a top-level queue role: the issue-preparer
launches it with the exact claimed issue and parent run identity its contract
requires.

`AGENTS.md` is the shared coordination procedure and owns the implementation
mechanics; this entry point adds none of its own. With no role named, stop.
