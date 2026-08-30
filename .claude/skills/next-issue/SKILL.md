---
name: next-issue
description: >-
  Start one fresh session of an Uberblick entry role with its queue assignment,
  then return. It selects nothing and claims nothing.
---

# next-issue — launch one role, once

`/next-issue <role>` starts exactly one fresh session of one role and returns.
This is the interim launcher for the contracts in `.agents/roles/`; the future
`ub launch <role>` replaces this file without changing them.

The continuous entry roles are `issue-preparer`, `implementer` and `integrator`.
`program-coordinator` remains directly callable for an explicitly requested
program issue, but is not a delivery loop. `issue-adversary` and
`implementation-reviewer` are exact-key internal roles launched by the parent
that owns their result; neither searches or claims a top-level queue. This
launcher selects no target. If the invocation names none of the four directly
callable roles, say so and return.

## What this does

1. **Prove the workflow revision before reading or launching it.** Require the
   checkout to be on `main`, then run `git fetch origin main` and
   `git merge --ff-only origin/main` before reading a role, procedure or queue.
   If the checkout is not on `main`, or the fast-forward is refused, report that
   and stop; never launch a role from workflow files that are not proven current.
2. **Create one stable run id, then start one session of the named role.** Use
   `claude-<role>-<UTC timestamp>-<short random suffix>` or an equivalently
   collision-resistant value. Create it before launch, pass it verbatim, and
   never substitute the Agent tool's internal id or the launcher session id.
   Start the Claude `Agent` tool with `subagent_type` set to the role slug (its
   adapter under `.claude/agents/`) and `model: opus`. That is this launcher's
   only path; launching a Codex session arrives with `ub launch <role>`, and
   the `.codex/agents/` adapters stay the definitions a Codex session discovers
   for itself.
3. **Hand it the queue assignment**, and nothing more:

   > Claim and complete one eligible item for the `<role>` role per
   > `.agents/roles/<role>.md`. Identifiers: role `<role>`, run id `<the stable
   > run id created above>`, launched by session `<this session's id>`.

   Add the MCP route: the registered uberblick server, or — where none is
   registered — the throwaway `ub mcp serve` stdio client from #77 and #134, run
   in a scratch directory outside the committed worktree. For an integrator or
   implementation-reviewer launch, explicitly state that the child shares this
   launching session's authorship identity and must apply the role's durable
   trailer/claim independence check before claiming; its fresh run id does not
   create independence.
4. **Announce and return.** Name the role launched and repeat that exact stable
   run id in your visible output, then stop.

Everything else belongs to the role: this file observes no GitHub state, selects
nothing, claims nothing, and performs no gate, review, disposition or merge. It
never resumes a role after its handoff, and it carries no continuation — another
fresh invocation belongs to its caller.

## Hard rules

- **This file stays under 200 lines.** An addition pays with a deletion, or
  moves its detail to a companion file beside this one.
- The coordinator's own repo edits (skill or docs changes, commits) happen in
  its own worktree (EnterWorktree), never in the shared launcher checkout. Keep
  that launcher checkout on clean `main`; role implementation still uses the
  isolated worktree its contract requires.

The roles' mechanics live beside this file and are read by the role that owns
them, never here: `preflight.md` (issue preparer and its adversary),
`review-protocol.md` and `integration.md` (implementation reviewer and
integrator).
