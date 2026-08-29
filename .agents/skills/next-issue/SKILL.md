---
name: next-issue
description: >-
  Act as one named Uberblick role: read its contract, claim one eligible item,
  complete it, stop.
---

# next-issue

A Codex session launched as a role reads `.agents/roles/<role>.md` in full,
including its `Pickup` section, before any side effect. That contract owns the
role's queue: which items are eligible, their order, the claim record, the race
rule, and the single outcome it stops after. No target is handed to you.

`AGENTS.md` is the shared coordination procedure and owns the implementation
mechanics; this entry point adds none of its own. With no role named, stop.
