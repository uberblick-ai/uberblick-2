# Contributing to Uberblick

Issues, comments and pull requests from outside the team are welcome. Use the
bug-report form for a reproducible defect and the product-change form for a
proposed outcome. Report vulnerabilities through [SECURITY.md](SECURITY.md).

Only a maintainer with `maintain` or `admin` repository access starts or queues
an issue or an outside pull request in the agent workflow, by applying the
appropriate trigger label. Submitting a form or pull request does not start
agent work. This public repository uses
[ub-agents' approval policy](https://github.com/uberblick-ai/ub-agents/blob/main/docs/approvals.md):
outside edits and feedback need maintainer clearance before becoming agent
input, and an outside pull request's current head needs approval too.
Maintainers can clear current input with `ub-agents approve <number>`; approval
alone does not replace the initial start. Reapplying a trigger label does not
approve a pull request head. Agents can review an approved fork head, but cannot
revise a fork pull request.

Uberblick ships no agent launcher. This repository's delivery loops use
[ub-agents](https://github.com/uberblick-ai/ub-agents), a separate tool configured
by [ub-agents.yaml](ub-agents.yaml). [AGENTS.md](AGENTS.md) governs agents' use of
GitHub input; the [workflow reference](.agents/protocols/workflow.md) owns labels
and delivery transitions.

## Packages

| Package | What it is |
| --- | --- |
| `packages/schema` | The keystone: Yjs block model, Markdown import/export and block edits. |
| `packages/hub` | Hocuspocus sync hub with SQLite persistence; binds `HUB_HOST`:`PORT`, default `127.0.0.1:1234`. |
| `packages/mcp-server` | MCP stdio server, local SQLite mirror with FTS5, tags and backlinks, and block-scoped tools. |
| `packages/web` | Vite, React and Tiptap/ProseMirror viewer/editor. |
| `packages/cli` | The `ub` command line: configuration resolution, `ub status` and `ub mcp serve`. |

All five are private workspace packages and resolve to their TypeScript sources
(`exports` → `./src/index.ts`). Nothing imports build output: `tsx`, `vite` and
`vitest` compile TypeScript directly. `tsc` is only a typechecker here: `build`
and `typecheck` both run `tsc --noEmit`. No resolution path uses `dist/`.

## Contributor setup

With `git` and [mise](https://mise.jdx.dev) installed, run from a fresh clone:

```sh
mise trust && mise run setup
```

`mise run setup` installs only the pinned toolchain and frozen dependencies.
It creates no workspace or signing secret and takes no initialization flags.
The committed project binding selects the team's hub. Run `ub auth login` to
sign in with access to that workspace; setup itself works without a login.

Mise refuses an untrusted configuration with an `[env]` block as a hard error,
which is why the first command is `mise trust`.

Entering the checkout prints a short quick-start, check tasks and a pointer to
`mise tasks`. This project hook needs [mise activated in your
shell](https://mise.jdx.dev/getting-started.html): shims put `node` and `pnpm` on
PATH but do not run hooks. `mise run welcome` prints the same quick-start on
demand, whether mise is activated or not. It stays silent when stdout is not a
terminal, `CI` is set, or `MISE_QUIET=1`.

Both CLI names, `ub` and `uberblick`, work. `mise.toml` adds the checkout's
`node_modules/.bin` to `[env] _.path`; `mise run install`, including through
setup, links the declared CLI binaries there. With mise activated they resolve
inside the checkout; changing out of it removes that checkout's binaries from
PATH. Without activation or in CI, use `mise x -- ub status`. Setup must run
before the first use because there are no linked binaries before installation.

For a separate local workspace, run `ub workspace create <name>` in a fresh
directory outside this checkout. It seeds the starter documents and creates a
local signing secret if none is already supplied. Joining a shared workspace
uses `ub auth login` and `ub workspace use <link>` instead, as described in the
[user guide](USER_GUIDE.md#the-ub-command-line).

## Updating

Follow [Local development](.agents/development.md) to update a source checkout
and build the web bundle for checkout `ub open`. The default source bundle is
`packages/web/dist`. If it is missing or speaks another sync protocol, `ub open`
exits 1 before starting a hub or creating a database file, naming the build task.
[RELEASING.md](RELEASING.md) owns client and hub release publishing;
[REMOTE.md](REMOTE.md) owns deployed hub launch and updates.

## The signing secret

`HUB_AUTH_TOKEN` is the HMAC secret used to sign loopback hub tokens. It grants
no remote access and is never sent to a remote hub; remote access is described
in [REMOTE.md](REMOTE.md).

The repository holds no copy. Unless a secret is already supplied,
`ub workspace create` writes 32 random bytes to owner-only `credentials.json`
(mode 0600), at the [user guide's configuration root](USER_GUIDE.md#where-your-files-live).
`ub open` creates it only if still missing, and only for a local workspace whose
hub it starts here. A remote or device-authenticated hub, including one on
localhost, creates none. The dev hub creates no secret: on a local binding,
run `ub workspace create` or `ub open` first, or export `HUB_AUTH_TOKEN`.

Development processes resolve the project binding and credentials through the
same resolver as `ub`. The MCP task runs `ub mcp serve`, which resolves them
for its child. The signing secret is used only for local admission. Stored login
or a verified device-authenticated binding selects device credentials even at
a loopback endpoint. Device credentials remain in the credential store, never
child environments. The [user guide](USER_GUIDE.md#configuration) owns the
secret's environment-over-file precedence.

The secret is never printed by a command or an error path. At most, they say
where it came from. A credentials file others can read is refused because its
secret may have leaked. Delete it, run `ub open` to make a new one, then restart
running agents. If it held hub logins, sign in again with `ub auth login`.
`ub workspace create` still creates a workspace in this state but makes no
secret; it leaves the file and its permissions alone.

## Running things

Mise tasks are the only supported entry points; use the commands in
[Local development](.agents/development.md), rather than direct package-manager
invocations. `mise tasks` lists the full catalog.
Additional tasks include `mise run hub`, `mise run web`, `mise run mcp` for a
standalone MCP smoke test, and `mise run build-install-payload -- 0.1.0` for
`dist/uberblick-0.1.0.tar.gz`.

`mise run dev` runs hub and web only. An MCP client normally spawns the MCP
server over JSON-RPC stdio, so it does not belong in the development service
loop. Nothing in `packages/mcp-server` may write to stdout except the MCP
transport; use the stderr helpers in `src/log.ts`. `biome.jsonc` enforces this
with `noConsole` as an error under `packages/mcp-server/src`.

The `dev` task starts its two processes explicitly. Mise's `depends` would
serialize long-running tasks under `MISE_JOBS=1`, preventing web from starting.

After pulling a token-format change, restart long-running MCP servers, redeploy
the web bundle and reload open tabs. An older client minting tokens without
`typ`, `kid` and `exp` is refused as an ordinary authentication failure; there
is no compatibility branch, and a redeploy cannot replace JavaScript already
loaded in a tab. The deployed-hub wire-compatibility rule belongs to
[REMOTE.md](REMOTE.md#updating-the-host--deliberately).

### Browser tests

`mise run e2e` is the only task that drives a browser. It builds one shared app
bundle per run, including filtered runs, and each harness starts its own hub
and real `ub open` on ephemeral ports with private state. Compiled fallbacks
are also run-owned: no fnox key is needed, and the harness cannot collide with
`mise run dev`. Specs run across two workers; tests within a file stay serial
and share a harness, except proofs requiring fresh state per test. Only the
release-runtime, shared-controls and compiled-loopback fallback proofs build
their own bundles.

Browser tests cover what jsdom cannot: two live clients converging on one
block, a rendered remote cursor, and fresh and reloaded browsers receiving only
what their server sends. Other tests belong in `mise run test`. Arguments after
`--` pass unchanged to Playwright; for example:

```sh
mise run e2e -- --repeat-each=3 outline.spec.ts
```

The full suite runs in Chromium; a tagged device and engine set also runs in
WebKit at iPhone and 13-inch MacBook sizes. WebKit needs host system libraries,
which CI installs separately. The task downloads engines without installing
system packages, and a missing library fails the full run. Use
`mise run e2e -- --project=chromium` for Chromium alone. Physical-device checks
for keyboard, native selection menu and composition are in the
[manual input checklist](packages/web/e2e/device-input.md).

### Repository MCP and workspace configuration

This repository's `.mcp.json` and `.codex/config.toml` run `ub mcp serve` through
mise. Codex workers configured in `ub-agents.yaml` receive the same entry as
runtime overrides. The checkout's `.uberblick.json` selects its workspace;
these entries carry no credential. `mise run mcp` runs checkout source in the
foreground for a standalone smoke test.

The web dev server takes `WORKSPACES`, a comma-separated list such as
`WORKSPACES="uberblick-<uuid>,research-<uuid>"`, for the topbar switcher. Export
this plaintext setting only for the run that needs it (`WORKSPACES=… mise run
web`), because IDs vary by machine. It is a menu, not authority: switching
navigates to `/<workspace>`, and a link to an unlisted workspace still opens
it. Without it, the switcher is a plain workspace label.

`WORKSPACE_ID` and `WORKSPACES` answer only for the development server.
[REMOTE.md](REMOTE.md#pointing-the-client-at-another-hub) owns the deployed
client's runtime configuration and container recreation.

The project's documents live in its live Uberblick workspace rather than the
repository. MCP `list_docs` enumerates them and the tools read and write them.
There is no corpus import command or snapshot to keep in step.

The checkout's `[env] HUB_DB_PATH` in `mise.toml` selects a checkout-local hub
database, so `mise run hub` does not open a packaged installation's database.
The [user guide](USER_GUIDE.md#where-your-files-live) owns the general storage
layout and explicit database overrides.

### Test deadlines

`UB_TEST_MAX_WAIT_MS` is a test seam, not a configuration layer. It caps the
hub connect and sync budgets, port-owner probe, hub-clock observation and
claim-state read; device-recovery pacing is capped too. It is a ceiling, never
a floor: unset or unusable it changes nothing, and it cannot lengthen a
default. As environment it reaches spawned children, which is why it is a
variable rather than an option. It does not shorten unrelated deadlines such
as GitHub approval or lock waits. The header of
[`packages/cli/src/budget.ts`](packages/cli/src/budget.ts) owns the exact contract
and explains which waits may be capped.

## The first-user proof

`mise run fue` executes the checkout setup above. It builds `Dockerfile.fue`:
Debian with git and mise, no Node, pnpm, age key or secrets. It copies the
working tree and runs `mise trust && mise run setup` verbatim. In a
container started with `--network none`, `scripts/fue-assert.mjs` then checks:

- Setup leaves the committed binding alone and creates no private workspace or
  signing secret. `ub workspace create` in a fresh directory creates a new
  local workspace and an owner-only secret, and `ub status` names it.
- `list_docs` answers over a real `ub mcp serve` client using newline-delimited
  JSON-RPC on stdio and returns both starter documents.
- `ub open --no-browser` starts the local hub, which accepts the generated
  secret. Ctrl-C releases its hub and web ports.
- `mise run dev` brings up a hub accepting this machine's credential and a web
  server answering `/`, the redirect's workspace and the workspace address
  itself, using an explicit local workspace environment pair so the committed
  remote binding remains unchanged. An open port alone would not prove authentication.
- Ctrl-C stops everything: `dev` exits 130 and frees both ports.

The cold runtime is about 70 seconds. Only installation has network; assertions
run offline to prove local-first operation. Nothing is stubbed, so removing a
setup step fails the build at that step, and a failure names the first broken
promise in one line.

It runs on demand, not in per-PR CI. As with the review image, it receives no
secrets, host mounts, privileged mode or Docker socket. Its working-tree build
context is filtered by `Dockerfile.fue.dockerignore`, more strictly than the
review `.dockerignore`: all local databases and configurations are excluded so
existing state cannot stand in for what initialization should create.

## Local CI

CI runs on a maintainer's machine from an `origin/main` checkout after the
commit is pushed. Use the command in [Local development](.agents/development.md).
It first runs the isolated lint, typecheck and test review below in a Linux
container without network. Passing posts a green `signoff` commit status through
[gh-signoff](https://github.com/basecamp/gh-signoff); merge requires that status.
It then runs browser e2e on the host unless only documentation or agent process
changed, reporting the advisory `signoff/e2e` status. A failed step posts red.
Install the extension once:

```sh
gh extension install basecamp/gh-signoff
```

GitHub Actions retains release publishing and the Linux Homebrew upgrade proof
after packaging changes. The latter runs after merges changing the formula or
its payload, and on demand from the Actions tab, through
`.github/workflows/homebrew-formula.yml`.

## Review isolation

Local CLI startup and collision tests use allocated ports. The literal default-web-port
startup proof runs with `CI=true` in the mandatory container review, where networking
is isolated from the developer host. A local `mise run test` leaves that proof to
`mise run review <commit>`; do not set `CI=true` for a host run while the default port
is occupied. Product startup still uses its documented default and refuses collisions.

`mise run review <commit>` resolves its argument (default `HEAD`), extracts
that commit with `git archive`, and builds it with freshly fetched
`origin/main`'s `Dockerfile.review`. A disposable container runs lint,
typecheck and tests. The context contains every committed file at the reviewed
SHA except `.gitattributes`, plus main's `.dockerignore`. It cannot include a
changing checkout, untracked files, local `node_modules`, `.git` or plaintext
secrets, and no `export-ignore` may hold back a committed file.

All temporary state lives under one directory removed by one success/failure
trap. Synthesized trees live in a scratch repository there. The only mark left
on the original repository is the required fetch, on a private ref deleted by
the same trap. The image `uberblick-review:<full-sha>` is retained for focused
failure-path probes in the same environment.

### The trust boundary

**Main owns the recipe; the reviewed commit owns file contents.** The effective
Dockerfile and ignore policy are read from the fetched `origin/main` commit
object into a private temporary directory. The branch's `Dockerfile.review`
is never read and its `.dockerignore` never applies. The reviewed tree is
copied into a scratch Git directory borrowing only this repository's objects.
Every `.gitattributes` is stripped, `core.attributesFile` is emptied, and system
attributes are disabled: otherwise `export-ignore` could drop a failing test or
`export-subst` rewrite content. `GIT_NO_REPLACE_OBJECTS` prevents a replacement
ref from making one SHA read another commit.

This is why the gate is one command, without a preceding inspection ceremony.
The reviewed code is still active: its manifests and lockfile are its own,
and their install scripts run during the build.

**The runner is as trustworthy as its checkout.** Before building, it fetches
`origin/main` and refuses unless HEAD equals that commit and `mise.toml`,
`Dockerfile.review` and `.dockerignore` are unmodified against it. Those three
paths are checked, rather than the whole tree; the build still reads them from
the commit. Stay on main and pass a fetched review SHA. Checking out the review
branch already hands it your mise configuration, Git hooks and `node_modules`
before Docker is involved.

**Build has network; verification does not.** The pinned package manager and
lockfile need npm registry access, so build uses Docker's default network and
branch-chosen install scripts execute there. Verification runs with
`--network none --cap-drop ALL --security-opt no-new-privileges`.
`docker build --network=none` fails at package-manager installation. Building
requires an explicit review invocation, including via local CI; a push alone
never builds a branch. Pass no build secrets, host mounts, privileged mode or
Docker socket, so a hostile build receives none of our credentials.

## Toolchain choices

**Node 26** (`engines.node: ">=26"`, mise `node = "26"`) is the single runtime
version. It supplies stable native `fetch` and WebStreams; `tsx` is the only
TypeScript loader needed.

**SQLite uses `node:sqlite` everywhere.** The MCP mirror and hub persistence
use ordinary SQLite files and a synchronous API, with nothing to compile at
installation. The hub's former `@hocuspocus/extension-sqlite` dependency brought
the better-sqlite3 native addon. The hub already had to subclass its two-column
adapter, so now owns it in `packages/hub/src/persistence.ts`. Tables, queries
and Yjs v1 bytes are unchanged, so existing databases open in place.
`packages/hub/test/fixtures/extension-sqlite.sqlite` is a compatibility input.
No native addon builds in the tree; `pnpm-workspace.yaml`'s
`onlyBuiltDependencies` contains only `esbuild`.

**One copy of Yjs.** `yjs`, `y-protocols` and `y-prosemirror` keep module-level
state and use `instanceof` across document boundaries; duplicates can silently
corrupt documents. Exact versions are pinned through both `catalog:` entries
and `overrides` in `pnpm-workspace.yaml`. `@uberblick/schema` declares `yjs` as
a peer dependency, so the app package owns the instance. Check with
`mise exec -- pnpm why yjs`.

## Secrets

Encrypted secrets would live in age-encrypted `fnox.toml`; it holds none today.
The private key belongs at `~/.config/fnox/age.txt`, never in the repository.
Only actual secrets go there. Plaintext local defaults such as `HUB_DB_PATH`
belong in `mise.toml`'s `[env]`. `HUB_URL` deliberately does not: that block is
ambient for the checkout, so the `ws://localhost:1234` default lives in client
code, while explicit project/environment binding through the shared resolver
selects the endpoint actually dialed.

Development tasks read the private credential store directly and need no age key. See
[The signing secret](#the-signing-secret) for precedence. User credential handling
and database identity safeguards are in the [user guide](USER_GUIDE.md).
