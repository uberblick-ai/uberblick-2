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

| Package | Job | Ships in |
| --- | --- | --- |
| `packages/schema` | Yjs block model, Markdown import/export, block edits and the client-hub protocol and token contract. | Homebrew and the hub image. |
| `packages/hub` | Hocuspocus rooms and SQLite persistence, with local shared-secret admission in the core and GitHub sign-in, device credentials, memberships and operator setup wired by the release entry points. | The core in Homebrew; the core and team features in the hub image. |
| `packages/mcp-server` | MCP stdio server, local SQLite mirror with FTS5, tags, backlinks and block tools; shared clients for login, renewal and management, desktop storage and project configuration. | Homebrew. Its hub development preload runs only in a checkout. |
| `packages/web` | Vite, React and Tiptap/ProseMirror viewer/editor. | Homebrew's local web app and the hub web image. |
| `packages/cli` | The `ub` commands and local browser server. | Homebrew. |

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
`mise run dev`. Interactive projects use two workers and workload probes use one;
tests within a file stay serial
and share a harness, except proofs requiring fresh state per test. Only the
release-runtime, shared-controls and compiled-loopback fallback proofs build
their own bundles.

Browser tests cover what jsdom cannot: two live clients converging on one
block, a rendered remote cursor, and fresh and reloaded browsers receiving only
what their server sends. Other tests belong in `mise run test`. Arguments after
`--` pass unchanged to Playwright; for example:

```sh
mise run e2e -- --repeat-each=3 sidebar.spec.ts
```

Wait for saves and drawing through `e2e/settle.ts`. `waitForAcknowledged` names
the path being proved (`relay` or `upstream`); `waitForDraw` compares the source
and data revisions exposed by the block with the values the test wrote or read.
The status indicator's presentation delays and renderer requests do not prove
that a change arrived or drew. Use `expectMcp` to retry document and data
read-backs. Before asserting that stored state, drawn output or an open-page
count stayed unchanged, make a later positive change and observe it at the same
reader. State which path that barrier proves. A relay acknowledgement alone
does not prove arrival at an upstream MCP reader.

`mise run lint` uses TypeScript's parser to reject one-shot MCP read assertions
and open-page count assertions outside that helper, including local aliases.
Scripted `setNativeSelection` callbacks return the document positions they set;
typecheck rejects callbacks returning nothing. Use `setPointerSelection` only
for actual pointer input, whose positions come from the resulting native range.

The full suite runs in Chromium, which covers the desktop; a tagged device and
engine set also runs in WebKit at iPad (gen 7) size. WebKit needs host system libraries,
which CI installs separately. The task downloads engines without installing
system packages, and a missing library fails the full run. Use
`mise run e2e -- --project=chromium` for Chromium alone. Physical-device checks
for keyboard, native selection menu and composition are in the
[manual input checklist](packages/web/e2e/device-input.md).

CI runs two Chromium jobs, two WebKit iPad shards and the workload project
on separate Linux runners. Chromium uses a measured whole-file list in
`packages/web/e2e/chromium-group-one.txt` and its complement, so new specs run
without updating the list or workflow. Rebalance by measuring the longest
browser job's full duration over repeated CI runs, including setup and teardown.
The required `browser e2e` aggregate succeeds only
when every job succeeds, including every shard. The workload job uses
`--project=chromium-workload --no-deps` so it cannot rerun interactive tests.
A local `mise run e2e` runs all projects, with workload probes after the
interactive projects. Retries stay disabled, and sharding keeps each file's
tests together. Interactive projects retain a Playwright trace only for failed
tests, including browser contexts a test creates itself; passing tests discard
their recordings. Workload probes stay untraced so recording does not distort
their timings. A flaky test is quarantined instead: when a test fails on
`main` and no change explains the failure, mark it `test.fixme` (Playwright)
or `it.skip` (Vitest) in its own pull request, linking a new issue that fixes
or deletes it. `main` stays green, and the skip records the coverage it lost.
Phone-specific WebKit checks are deferred; retained narrow-width Chromium
checks still protect containment and responsive behavior.

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
  local workspace and an owner-only secret, and `ub status` names it in its short
  local report, with `pending.count` 0 in JSON.
- `list_docs` answers over a real `ub mcp serve` client using newline-delimited
  JSON-RPC on stdio and returns both starter documents.
- `ub open --no-browser` prints its web address and starts the local hub, which accepts the generated
  secret as checked through the `sync_status` MCP tool. Ctrl-C releases its hub
  and web ports.
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

## CI

Every push to `main` and every pull request runs `.github/workflows/ci.yml`
on GitHub: lint, typecheck, tests and browser e2e on Linux, and on macOS the
suites whose behaviour can differ by OS (`mise run test-os`). The checks
`lint, typecheck and tests`, `macOS tests` and `browser e2e` are required to
merge; the main ruleset accepts them only from GitHub Actions.
On `main` the same run records whether `main` itself is clean. A pull
request's run uses that pull request's own recipe, so a change to what CI runs
is reviewed as a change to the merge rules.

Linux unit tests run in four independent jobs: `cli tests`, `mcp-server tests`,
`web tests` and `hub, schema and scripts tests`. A failing job leaves the others
running. `lint, typecheck and site` runs those three checks together, continuing
after a failure. The required `lint, typecheck and tests` aggregate succeeds only
when that job and all four Linux unit-test jobs succeed; failure, cancellation
or a skipped job fails the aggregate. A new workspace package must be assigned
to a Linux job or the script contract tests fail.

Unit-test jobs keep their dot logs and upload
`vitest-Linux-<group>-<run>-attempt-<n>` (`cli`, `mcp-server`, `web` or
`hub-schema-scripts`) and `vitest-macOS-<run>-attempt-<n>` artifacts, including
on test failure. Each package's JUnit XML gives the test file (the suite name),
full test name, result,
duration and failure details. Shared package runs also include
`package-times.json` with package wall times.
Rerunning failed or selected jobs (`gh run rerun <run> --failed` or `--job <job-id>`)
keeps earlier attempts' reports beside the new reports. A failed Linux package
job reruns with its aggregate, leaving successful jobs alone. Uploads are best
effort and cannot change a job's conclusion. "Re-run all jobs" deletes
earlier attempts' reports. A process killed before reporting, or a job timeout,
can leave a missing report; check its log for the cause.
Reports live in the Actions runner's temporary directory; local runs, including
`CI=true mise run ci`, create no reports in the checkout.

Each failed browser suite uploads `packages/web/test-results/` as
`playwright-<job>-<run>-attempt-<n>`, with its failure traces and other test output.
This includes the workload job's output, without traces. Green browser jobs
upload nothing. Uploads are best effort and cannot change the job's result or
the required `browser e2e` result. Rerunning failed or selected jobs keeps earlier
attempts' artifacts beside the new ones; "Re-run all jobs" deletes earlier
attempts' artifacts. A job timeout or cancellation can prevent an upload.

`pnpm test` and `pnpm run test:os` share one worker budget across concurrent
packages. Each command divides a budget of three times the machine's available
cores among its slots: up to four concurrent suites for `pnpm test`, and two for
`pnpm run test:os`. The shared Linux hub/schema job uses the same budget with
two slots. `pnpm --filter <package> test`, including each standalone Linux
package job, uses that package's standalone worker setting. Local
`mise run test`, `mise run ci` and `mise run review` retain the full suites.

Merging also requires CodeQL code scanning results: a pull request that introduces
a security alert at high or above cannot merge. Lower-severity and non-security
alerts do not block merging. CodeQL runs on GitHub, outside `ci.yml` and
`mise run ci`. Only a maintainer decides whether to dismiss an alert.

`.github/workflows/dependency-review.yml` fails a pull request that adds or
upgrades to a dependency, runtime or development, with an advisory at high or
above. It compares the pull request with its base, so advisories already on
`main` do not block it. It is not a required check. Dependabot
(`.github/dependabot.yml`) opens one grouped pull request for open security
fixes, a weekly one for npm minor and patch updates, and a monthly one for
action pins. It skips the exact pins `pnpm-workspace.yaml` explains. Its pull
requests come from an outside author, so a maintainer merges them by hand once
the required checks pass.

`mise run ci` runs the same commands locally, in the workflow's order, under
`CI=true`, and names every check that failed. It is a convenience, not a
substitute for the required checks. Its tests are the full suite on every
platform, its browser run covers every project CI shards, and it refuses to
start while `ub open` holds the default port. `mise run ci --skip-e2e` stops before the
browser suite.

GitHub Actions also retains release publishing and the Linux Homebrew upgrade
proof after packaging changes. The latter runs after merges changing the formula
or its payload, and on demand from the Actions tab, through
`.github/workflows/homebrew-formula.yml`.

## Review isolation

Local CLI startup and collision tests use allocated ports. The literal default-web-port
startup proof runs with `CI=true` in GitHub CI and in the container review, where the
default port is free. A local `mise run test` leaves that proof to them; do not set
`CI=true` for a host run while the default port is occupied. Product startup still
uses its documented default and refuses collisions.

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

This is why the review is one command, without a preceding inspection ceremony.
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
requires an explicit review invocation; a push alone never builds a branch
here. Pass no build secrets, host mounts, privileged mode or
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
