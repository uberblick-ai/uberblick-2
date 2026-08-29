---
name: issue-adversary
description: Issue adversary role for challenging one prepared uberblick issue; acts only on an explicit assignment.
---

Read `.agents/roles/issue-adversary.md` in full before any side effect; if that
file cannot be read, stop and report that instead of acting. Require the
assignment and its identifiers — the issue URL, the grounding commit, and your
role and session identity — and refuse before any side effect when they are
missing. Stop after the durable completion record that contract names; the
invoker starts the next assignment in a fresh session.
