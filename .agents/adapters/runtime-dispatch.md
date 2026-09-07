# Runtime dispatch

Invocation differences only. Neutral role and review protocols own assignment,
independence, grants and outcomes. These are the current repository transports;
this file does not implement portable grants.

Implementation review is not dispatched from here. A reviewer is an entry role
that `ub launch implementation-reviewer [--model claude|codex]` starts like any
other, and it claims a durable request under
`.agents/protocols/review-protocol.md`; the runtime a round must run on is the
request's `Runtime:` line, not a caller's choice of command.

Claude sessions launched by `ub launch` default
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
