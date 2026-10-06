# Local development

The commands that build, run and validate a change:

| Command | Use |
| --- | --- |
| `mise trust` | prepare a new worktree to run the project's tasks |
| `mise run setup` | fresh checkout: pinned toolchain, dependencies, then `ub init` |
| `mise run install` | install dependencies in an already set-up worktree |
| `mise run dev` | local development services |
| `mise run lint`, `mise run typecheck`, `mise run test` | the final checks on an implementation |
| `mise run e2e` | the browser proof, owed when the outcome is browser-observable |
| `mise run review <sha>` | the immutable review, when delivery policy requires it |
| `mise run ci <sha>` | local CI: the immutable review and e2e at a pushed commit, then `gh signoff` |

Prefer these to direct package-manager invocations, and run a command that needs
the project's configuration through `fnox exec -- ub env -- <command>`. Do not
dump resolved environment or credentials. Keep secrets in the supported
credential store; never commit plaintext tokens or create secret .env files.

Run focused checks while editing, then the required checks on the final change.
Always pass the intended SHA to `mise run review`; omitting it reviews the
runner checkout's HEAD. A failing test is not automatically environmental:
compare the relevant base before attributing the failure. Record real
limitations, not assumed passes.
