# Runtime dispatch

Invocation differences only. Neutral role and review protocols own assignment,
independence, grants and outcomes. These are the current repository transports;
this file does not implement independently queued review or portable grants.

## Implementation reviewer

One transport per *reviewer* runtime — the command
is chosen by the runtime the round must run on, not by the caller's, so a
same-runtime round (a `--model codex` integrator on a Codex-authored PR) uses the
same two commands. Both run from the parent's own worktree, named explicitly
for Codex instead of inherited from the shell, and detached (a foreground shell
call is killed at ten minutes), with the prompt read from a file and the log
kept in private scratch. Put a Codex reviewer's prompt at
`<scratch>/<child-run-id>.prompt`, then start the runner as one background Bash
call; it writes its own sibling `.log` and `.status` files and leaves the
borrowed parent worktree registered. An empty scratch directory is not a
substitute, even with `--skip-git-repo-check`: it holds neither the role
contracts nor current code, so bypassing the trust refusal only makes the round
fail later.

```sh
# A Codex reviewer — the repository runner supervises Codex and records the
# transport's log and exit status in private scratch.
node scripts/run-codex-role.mjs implementation-reviewer <child-run-id> <parent-worktree> <scratch>

# A Claude reviewer — the project adapter selects the role.
( claude -p --agent implementation-reviewer --model opus --permission-mode bypassPermissions < <prompt-file> > <scratch-log> 2>&1; echo $? > <scratch-log>.status )
```

Each is a fresh top-level session: `codex exec` always is, and a headless
`claude -p` carries its own `Claude-Session` trailer. A Claude parent may
instead start the reviewer with the `Agent` tool (`subagent_type:
implementation-reviewer`, `model: opus`). That child shares its launcher's
authorship identity, so it may review only a diff that identity did not
author — proven the way an integrator proves its own independence: no commit
in the head carries the launcher's `Claude-Session` trailer, and the launcher
launched no implementer whose commit is in the head. Under that proof the
`Agent` child is the Claude transport for a Codex-authored diff (owner
decision, 2026-09-01); without it, it is never a reviewer.

`codex exec` selects no `.codex/agents/*.toml` adapter, so the prompt tells a
Codex child to read the `implementation-reviewer` role contract; the Claude
adapter already does. Either assignment names the exact PR, head, child run id
and parent run id, and nothing else — the reviewer contract supplies the
critical brief. Read the verdict from the completed PR record; inspect the
private scratch log only when dispatch fails or no durable verdict appears, so
the child's reasoning transcript does not consume the parent context.

## Issue adversary

For Claude, use the command above with `issue-adversary` as the agent. For
Codex, the implementation-review runner is not an adversary entry point:

```sh
( codex exec -C <parent-worktree> -s workspace-write -c 'sandbox_workspace_write.network_access=true' - < <prompt-file> > <scratch-log> 2>&1; echo $? > <scratch-log>.status )
```

The prompt names the neutral adversary contract, exact issue, child run id and
parent run id. Use the parent worktree, not an empty scratch directory or the
read-only rescue helper. Run long-lived commands detached with their own deadline
and cleanup; remain in the assignment and renew the claim while waiting for the
durable verdict. A foreground tool timeout is not a reviewer deadline.
