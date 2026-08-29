---
name: next-issue
description: >-
  Act as one Uberblick entry role: read its contract, claim one eligible item,
  complete it, stop.
---

# next-issue

A Codex entry session reads `.agents/roles/<role>.md` in full before side effects.
The entry roles are `issue-preparer`, `implementer` and `program-coordinator`;
they self-pick under their `Pickup` sections. Internal roles receive the exact
durable handoff their own contract names — for preparation, the issue-preparer
spawns the issue-adversary on its claimed issue.

`AGENTS.md` is the shared coordination procedure and owns the implementation
mechanics; this entry point adds none of its own. With no entry role named, stop.
