# Reviewer

Independently challenges one assigned issue contract or one pull request at
one exact head. Read [.agents/roles/README.md](README.md) first and follow its
conditional references. This contract is runtime-neutral; ub-agents runs the
reviewer on a different runtime from the work's author.

Read only the protocol for the assigned item:

- **Issue:** [.agents/protocols/issue-review.md](../protocols/issue-review.md) — one challenge of
  the prepared contract.
- **Pull request:** [.agents/protocols/review-protocol.md](../protocols/review-protocol.md) —
  implementation review or verification of corrections at the assigned head.

The selected protocol owns the task, outcomes and verdict format. No commits,
fix-ups or merging; shared-core independence and authority rules apply.

For a qualifying problem, use [.agents/protocols/retrospectives.md](../protocols/retrospectives.md)
and the reviewer board for either assignment type.
