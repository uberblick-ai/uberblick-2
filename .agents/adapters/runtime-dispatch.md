# Runtime dispatch

Invocation differences only. Neutral role and review protocols own assignment,
independence and outcomes. Every path below is the adopting project's own — the
parent's worktree, its private scratch, its role contracts and its runtime
adapters — so nothing here reaches into the checkout this workflow came from.

Grants are the project's, in both places they live. An entry-role session gets
exactly the sandbox, permission mode and tool approvals its project declared in
`.agents/launch.json`, passed through by the launcher, and each runtime's own
configuration stays the project's to write. The one grant this file supplies is
the internal adversary child's, in the commands below, and it is stated there
rather than implied: a project that wants a different one edits the transport it
adopted, and nothing here widens a grant its project declared elsewhere.

Implementation review is not dispatched from here. A reviewer is an entry role
that `ub agents launch implementation-reviewer [--model claude|codex]` starts
like any other, and it claims a durable request under
`.agents/protocols/review-protocol.md`; the runtime a round must run on is the
request's `Runtime:` line, not a caller's choice of command.

Two of those loops are therefore part of the operating set, beside the
implementer and integrator loops: `ub agents launch implementation-reviewer
--model claude` and `--model codex`. No role produces a round any more, and a
request names the runtime it needs, so a round whose runtime has no loop
running goes unanswered until an operator starts one — which the integrator
parks `needs-human` for rather than merging past.

Claude sessions launched by `ub agents launch` default
`CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS` to `0`, preventing print mode's independent
600-second background-wait cutoff. An explicit operator value is preserved.
This is transport configuration, not a child deadline: use finite child/waiter
deadlines, renew ownership and wait within the active parent session. For manual
headless Claude dispatch, set the same variable if it is not already inherited.

## Claude children

A Claude parent starts its internal child with the `Agent` tool
(`subagent_type: issue-adversary`, `model: opus`), or headlessly. That child
shares its launcher's authorship identity, which is why no child reviews a
diff: independence is proven from authorship, and a delegation never
manufactures it (owner decision, 2026-09-01).

```sh
# A headless Claude child — the project adapter selects the role.
( claude -p --agent <role> --model opus --permission-mode bypassPermissions < <prompt-file> > <scratch-log> 2>&1; echo $? > <scratch-log>.status )
```

Run it from the parent's own worktree and detached (a foreground shell call is
killed at ten minutes), with the prompt read from a file and the log kept in
private scratch. Read the child's result from its completed durable record;
inspect the private scratch log only when dispatch fails or no durable verdict
appears, so the child's reasoning transcript does not consume the parent
context.

## Issue adversary

For Claude, use either command above. For Codex, the repository's supervised
runner is an entry-role transport and is not an adversary entry point:

```sh
( codex exec -C <parent-worktree> -s workspace-write -c 'sandbox_workspace_write.network_access=true' - < <prompt-file> > <scratch-log> 2>&1; echo $? > <scratch-log>.status )
```

The prompt names the neutral adversary contract, exact issue, child run id and
parent run id. Use the parent worktree, not an empty scratch directory or the
read-only rescue helper. Run long-lived commands detached with their own deadline
and cleanup; remain in the assignment and renew the claim while waiting for the
durable verdict. A foreground tool timeout is not a child deadline.
