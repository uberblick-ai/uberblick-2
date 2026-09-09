# Local development

The commands that build, run and validate a change are the project's own, so
this file names their roles and never their spellings. Resolve one before you
run it — `node scripts/agent-binding.mjs project.commands.test` — and run what
it prints, as it prints it: a declared command is complete, wrapper and all.

- `trust`: prepare a new worktree to run this project's commands, where the
  project declares one.
- `install`: install dependencies. `dev`: local development services.
- `lint`, `typecheck`, `test`: the final checks on an implementation.
- `e2e`: the browser proof, owed when the outcome is browser-observable.
- `review`: the immutable review, with the intended SHA as its argument, when
  delivery policy requires it.
- `housekeeping`: the host cleanup an integrator runs after a durable outcome.

Prefer these declared commands to direct package-manager invocations, and run a
command that needs the project's configuration through its declared `env`
prefix where there is one. Do not dump resolved environment or credentials.
Keep secrets in the supported credential store; never commit plaintext tokens
or create secret .env files. Where a `project.context` binding names the
document that governs the behavior you are changing, read that document first.

Run focused checks while editing, then the required checks on the final change.
Always pass the intended SHA to the `review` command; omitting it reviews the
runner checkout's HEAD. A failing test is not automatically environmental:
compare the relevant base before attributing the failure. Record real
limitations, not assumed passes.
