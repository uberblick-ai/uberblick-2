---
name: next-issue
description: >-
  Start one fresh session of a named Uberblick role with its queue assignment,
  then return. It selects nothing and claims nothing.
---

# next-issue — launch one role, once

`/next-issue <role>` starts exactly one fresh session of one role and returns.
This is the interim launcher for the contracts in `.agents/roles/`; the future
`ub launch <role>` replaces this file without changing them.

The roles are `issue-preparer`, `issue-adversary`, `implementer`,
`implementation-reviewer`, `integrator` and `program-coordinator`. If the
invocation names none of them, say so and return.

## What this does

1. **Self-update the checkout** when it is on `main`: `git fetch origin main`
   and `git merge --ff-only origin/main`, so the next read of these files tracks
   current `main`. A refused fast-forward is reported and skipped, never forced.
2. **Start one session of the named role.** Claude: the `Agent` tool with
   `subagent_type` set to the role slug — its adapter under `.claude/agents/` —
   and `model: opus`. Codex: the matching `.codex/agents/` adapter through the
   Herdr skill.
3. **Hand it the queue assignment**, and nothing more:

   > Claim and complete one eligible item for the `<role>` role per
   > `.agents/roles/<role>.md`. Identifiers: role `<role>`, run id `<the
   > launched agent's id>`, launched by session `<this session's id>`.

   Add the MCP route: the registered uberblick server, or — where none is
   registered — the throwaway `ub mcp serve` stdio client from #77 and #134, run
   in a scratch directory outside the committed worktree.
4. **Announce and return.** Name the role launched and its run id in your
   visible output, then stop.

Everything else belongs to the role: this file observes no GitHub state, selects
nothing, claims nothing, and performs no gate, review, disposition or merge. It
never resumes a role after its handoff, and it carries no continuation — another
fresh invocation belongs to its caller.

## Hard rules

- **This file stays under 200 lines.** An addition pays with a deletion, or
  moves its detail to a companion file beside this one.
- The coordinator's own repo edits (skill or docs changes, commits) happen in
  its own worktree (EnterWorktree), never in the shared checkout — multiple
  sessions share it and it may sit on any branch.
- Edit issue/PR bodies only via `--body-file` with a file written by the Write
  tool. Never build the file with shell redirection (`>` — noclobber has
  silently emptied issue bodies before), and verify body length after editing.

The roles' mechanics live beside this file and are read by the role that owns
them, never here: `preflight.md` (issue adversary), `review-protocol.md`,
`integration.md` and `dev-stack.md` (implementation reviewer and integrator).
