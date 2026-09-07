# Local development

Use the repository's `mise` tasks; their definitions are the command authority.
Document tasks rather than direct package-manager invocations.

- `mise run install`: install workspace dependencies.
- `mise run dev`: local development services.
- `mise run lint`, `mise run typecheck`, `mise run test`: final implementation checks.
- `mise run e2e`: browser proof when the outcome is browser-observable.
- `mise run review <sha>`: immutable review when delivery policy requires it.

Tasks needing configuration use `fnox exec -- ub env -- <command>`. Do not dump
resolved environment or credentials. Keep secrets in the supported credential
store; never commit plaintext tokens or create secret .env files. Read the corpus
Configuration and auth document when changing configuration behavior.

Run focused checks while editing, then the required checks on the final change.
A failing test is not automatically environmental: compare the relevant base
before attributing the failure. Record real limitations, not assumed passes.
