# uberblick

A local-first, CRDT-backed collaborative document system. MCP-first: agents are
primary readers and writers; the web UI is a viewer/editor. Yjs CRDTs, a
Hocuspocus sync hub with SQLite persistence, an MCP server with a local SQLite
mirror (FTS5, tags, backlinks), and a Tiptap/ProseMirror web client.

## Packages

| Package                    | What it is                                                            |
| -------------------------- | --------------------------------------------------------------------- |
| `packages/schema`          | The keystone. Yjs block model, markdown import/export, block edits.   |
| `packages/hub`             | Hocuspocus sync hub, SQLite persistence. Binds `HUB_HOST`:`PORT` (default `127.0.0.1:1234`). |
| `packages/mcp-server`      | MCP stdio server, local SQLite mirror, block-scoped tools.            |
| `packages/web`             | Vite + React + Tiptap viewer/editor.                                  |
| `packages/cli`             | The `ub` command line: config resolution, `ub status`, `ub mcp serve`. |

All five are private workspace packages and resolve to their TypeScript sources
(`exports` → `./src/index.ts`). Nothing imports build output: `tsx`, `vite` and
`vitest` compile TypeScript directly, and `tsc` is only ever a typechecker here
(`build` and `typecheck` both run `tsc --noEmit`). There is no `dist/` in any
resolution path.

## Getting it running

For users on an Apple Silicon Mac or Linux x86_64, install with
[Homebrew](https://brew.sh). Follow Homebrew's shell setup instructions so
`brew` and the commands it installs are on `PATH`. With the default prefix,
the setup line is:

```sh
# Apple Silicon macOS
eval "$(/opt/homebrew/bin/brew shellenv)"
# Linux x86_64
eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv)"
```

Run the line for your platform, then install Uberblick:

```sh
brew install uberblick-ai/tap/uberblick
ub --version
```

`ub --version` prints the installed release version. Homebrew installs the CLI
and web editor; no source checkout is needed.

### Contributor setup

From a fresh clone, with only `git` and [mise](https://mise.jdx.dev) installed:

```
mise trust && mise run setup -- --yes
mise run dev                          # hub + web on http://localhost:5173
```

`mise run setup` installs the pinned toolchain and the frozen lockfile, then runs
`ub init` — which settles your awareness identity (display name and cursor
colour), the workspace (a fresh uuid, optionally given a display slug), and a
development signing secret for the local hub.
`--yes` takes every default and never prompts, so it is safe unattended; drop it
to be asked. Run it again any time: it is idempotent, and it will not replace a
secret that already exists. `mise run init` re-runs just the `ub init` step.

`mise trust` first because mise refuses to read a config file with an `[env]`
block it has not been told to trust — and it is a hard error, not a warning.
`ub init` runs `mise trust` on the file it writes for the same reason.

Entering the checkout prints a short quick-start — the two commands above, the
check tasks, and `mise tasks` for the rest. It is a `mise` project hook, so it
needs [mise activated in your
shell](https://mise.jdx.dev/getting-started.html): shims put `node` and `pnpm`
on PATH but never run hooks, so with shims alone nothing is printed and nothing
is missing. `mise run welcome` prints the same thing on demand, activated or
not. It stays silent when stdout is not a terminal, when `CI` is set, and when
`MISE_QUIET=1`.

What this supports is exactly one arrangement: **one workspace, one trusted user,
multiple clients and machines; no login and no tenant isolation.** Everything
below is a consequence of that.

### Updating

```sh
ub update
```

`ub update` updates only a copy installed from the `uberblick-ai/tap` Homebrew
tap. It identifies the installation from where that `ub`'s own files live, so a
Homebrew `ub` typed inside a checkout still updates Homebrew's copy.

The Homebrew commands are these two, and running them directly is the same
thing — the first refreshes the tap, the second replaces the installed copy
with the newest release published to it ([RELEASING.md](RELEASING.md) is how a
version gets there):

```sh
brew update
brew upgrade uberblick-ai/tap/uberblick
```

`ub --version` then prints the new version, and `ub` and `uberblick` stay on
PATH where they were. The upgrade replaces only what Homebrew installed:
everything under [Where your files live](#where-your-files-live) —
configuration, credentials, workspaces and their databases — is untouched, and
`ub status` still reports the same workspace with the documents it already
held. `.github/workflows/homebrew-formula.yml` proves installation and upgrade
on a Linux x86_64 runner after every merge that changes the formula or its
payload, and on demand from the Actions tab.

To update a source checkout, run these commands from the checkout:

```sh
git pull
mise run setup
```

The checkout's `ub update` exits 1 without changing files and names these
commands, on any branch. `mise run setup` refreshes the toolchain and dependencies
and runs `ub init`; it does not build the web app. If you use `ub open` from
source, run `mise run build-web` to build `packages/web/dist`. When that default
bundle is missing or speaks another sync protocol, `ub open` exits 1 naming
`mise run build-web`, before starting a hub or creating a database file. It never
builds the app itself.

### The signing secret

`HUB_AUTH_TOKEN` is the HMAC **secret** loopback hub tokens are signed with.
Remote hubs and clients use stored device logins; this secret grants no remote
access and is never sent to a remote hub.

The repository holds no copy of it. Unless a secret is already supplied,
`ub init` writes 32 random bytes to `credentials.json` (mode 0600) in this
machine's config root — see [Where your files live](#where-your-files-live).
It is generated only while this machine has **no hub endpoint stored**: a
machine bound to a loopback-only hub needs that hub's secret. Deployed Docker
hubs use the login established by `ub auth login`, including through a proxy
published on host loopback.

A mise task reaches it the same way an MCP client's server does: every task that
needs configuration wraps its command in `fnox exec -- ub env -- …`, and
`ub env -- <command…>` execs the command under the configuration `ub`
resolved and passes the signing secret only for local admission. A stored
login or a verified device-authenticated binding selects device credentials
even for a loopback endpoint. Device
credentials stay in the credential store, never child environments. So the
precedence a task sees is `ub`'s own, highest first: an explicitly supplied
secret in the environment, then `credentials.json`. There is
deliberately no bare `ub env` — printing that environment would print the
secret.

The secret is never printed — not by `ub init`, not by `ub status`, not by an
error path. The most any of them says is where it came from.

## Running things

mise tasks are the only supported entry points. Do not invoke `pnpm` directly —
the tasks pin the toolchain and wrap commands in `fnox exec -- ub env --`, so
the secret and this machine's own configuration are both present.

```
mise run setup        # one-command bootstrap: toolchain, dependencies, `ub init`
mise run init         # just the `ub init` step, idempotent
mise run welcome      # the quick-start the `enter` hook prints

mise run hub          # Hocuspocus sync hub
mise run mcp          # MCP server, standalone smoke test only (see below)
mise run web          # Vite dev server
mise run build-web    # production web bundle in packages/web/dist
mise run build-install-payload -- 0.1.0  # dist/uberblick-0.1.0.tar.gz
mise run dev          # hub + web in parallel
mise run lint         # Biome lint across the workspace (no formatter)
mise run typecheck    # tsc --noEmit across all packages
mise run test         # all test suites
mise run e2e          # browser proof points (Chromium and tagged WebKit, on demand)
mise run fue          # the documented install path, executed on a clean machine
mise run review <commit>  # immutable Docker review of one commit
```

To run the released Docker hub on Linux or Docker Desktop on macOS, follow
[REMOTE.md](REMOTE.md). It defaults to HTTP on host loopback without Tailscale.
Other computers connect over HTTPS for a public DNS name or, as the recommended
optional network layer, Tailscale. Caddy serves the app and proxies sync and
sign-in; the hub requires device credentials on every deployment route.

`mise run e2e` is the only task that drives a browser. It builds one shared app
bundle per run, including filtered runs, and each harness starts its own hub and
real `ub open` on ephemeral ports with private state. The compiled fallbacks are
run-owned too, so it needs no fnox key and cannot collide with a running
`mise run dev`. Spec files run across two workers; tests in a file stay serial
and share a harness, except proofs that require fresh state per test. Only
release-runtime, shared-controls and the compiled-loopback fallback proof build
their own bundles. It covers exactly what jsdom cannot —
two live clients converging on one block, a rendered remote cursor, and fresh
and reloaded browsers receiving only what their server sends. Everything else
belongs in `mise run test`. Arguments after `--` go to Playwright unchanged; for
example, `mise run e2e -- --repeat-each=3 outline.spec.ts` runs only that spec
three times. The full suite runs in Chromium; a tagged device and engine set
also runs in WebKit at iPhone and 13-inch MacBook sizes. WebKit requires
host system libraries, which CI installs separately; the task downloads engines
without installing system packages. A missing library fails the full run.
`mise run e2e -- --project=chromium` runs Chromium alone. Real-device checks for
the keyboard, native selection menu and composition are in the
[manual input checklist](packages/web/e2e/device-input.md).

`mise run dev` deliberately runs **hub + web only**. The MCP server speaks JSON-RPC
over stdio and is normally spawned by its client (Claude Code and friends, via
`.mcp.json`), so it has no place in the dev loop; `mise run mcp` exists for
smoke tests. Nothing in `packages/mcp-server` may write to stdout except the MCP
transport — use the stderr helpers in `src/log.ts`. `biome.jsonc` makes that a
build failure rather than a convention: `noConsole` is an error under
`packages/mcp-server/src`, so `mise run lint` rejects a stray `console.log`
there.

`dev` starts both processes explicitly rather than through mise's `depends`,
because `depends` on two long-running tasks serializes under `MISE_JOBS=1` and
the web server would never start.

**After pulling a change to the token format, restart what is already running.**
Hub tokens gained `typ`, `kid` and `exp`, and there is no compatibility branch:
a client from before that change mints a token the hub refuses, and the refusal
reads as an ordinary auth failure. Restart any long-running `ub mcp serve` and
redeploy the web bundle — and reload any tab still open on it, because a
redeploy does not replace the JavaScript a tab already loaded.

## The MCP server, as a client sees it

`ub mcp install [client]` wires uberblick into an MCP client, so nobody has to
hand-edit JSON. It knows `claude`, `codex` and `cursor`; `--project` means the
current directory's config and `--user` the per-user one; `--print` emits the
snippet and runs nothing, which is also the answer for a client it does not
know:

```
ub mcp install claude --project     # runs `claude mcp add --scope project`
ub mcp install codex --user         # runs `codex mcp add`
ub mcp install cursor --print       # the snippet, on stdout
```

**It edits no config file.** Where the vendor ships its own installer —
`claude mcp add`, `codex mcp add` — that is what runs, because the vendor knows
its own file best, and the scope and any `--workspace` pin ride on the vendor's
own flags (`-e KEY=value`, `--env KEY=VALUE`). Codex has no scope flag: which
file it writes *is* the configuration directory it is handed, so `--project`
points it at this checkout's `.codex`. Cursor, which ships no `mcp add`, gets
the snippet and the path to paste it into, on exit 0, with nothing written — so
does a target whose vendor CLI is not installed. A client `ub` has never heard of
gets the same snippet and that client's own MCP configuration as the
destination: there is no path to invent for a client nobody has described.
Before it delegates, the command reads the target file for one answer: an entry
that is already ours is a no-op that says "already installed", an entry somebody
else wrote under the name `uberblick` is left exactly as it was with the snippet
printed instead, a file that is there and cannot be read is refused by path —
nothing is handed to a vendor CLI over a file whose contents nobody knows — and
anything else is added.
There is no `--force`, no backup and no rewrite — the file this command does not
write is the file it cannot damage. Nothing prompts, so the whole command runs
unattended.

Reports name files, never their contents: a conflicting entry is reported by
path with nothing of it quoted back, and a vendor CLI's own output is not
relayed, because a client's diagnostics quote the config they just read. Config
files are where API tokens live. The vendor is spawned without uberblick's own
variables in its environment — no `HUB_*`, no `UBERBLICK_*`, no `WORKSPACE_ID` —
because it has no use for them and `ub` is habitually run with a secret
exported; the pin it does need rides in its argv.

The installed line is always `ub mcp serve`. Each new entry pins the complete
selected binding as `UB_WORKSPACE_ID` and `UB_HUB_URL`, including `local` for a
local-only workspace. Credentials stay in the private user store. With no
selection, installation fails rather than creating an entry that follows an
unrelated machine default.

```
ub mcp install claude --project
ub mcp install claude --project --workspace research-<uuid> --hub https://hub.example.test
```

Terminal commands and MCP use the same [project binding](#configuration).
Explicit installer overrides require both `--workspace` and `--hub`.

Re-pinning an entry that already exists is not this command's job any more: an
entry pinned to another workspace is not the one it would register, so it is
reported and the snippet printed, and the change is made in the client's own
config or with the vendor's own command. That cuts both ways, which is the
point — a repository quietly moved to another corpus is exactly what the pin is
there to prevent.

This repository's `.mcp.json` and `.codex/config.toml` run `ub mcp serve`
through mise, and the Codex agent workers in `ub-agents.yaml` receive the same
entry as runtime overrides. The checkout's `.uberblick.json` selects the
workspace, and the entries carry no credential.

For a standalone smoke test of checkout source, `mise run mcp` runs it in the
foreground.

### A second workspace

Create a separate project workspace without changing the one you already use:

```sh
ub workspace create "Project notes"
ub open
```

Creation needs no hub or login. It generates a fresh UUID, stores the supplied
name, seeds the same starter documents and sidebar group as `ub init`, and
selects it in the current directory's `.uberblick.json`. An ancestor project's
binding, other workspaces, stored logins and existing MCP registrations are
unchanged. `ub init` remains first-time setup.

To share that workspace, run `ub workspace promote <hub>`. Promotion reuses the
stored login or runs GitHub approval when needed. Your account must currently
be a member or administrator of at least one workspace on the hub; signing in
alone grants no creation rights.
The first login on a fresh hub claims its default workspace and qualifies.
Promotion uploads the same UUID and history, including archived documents,
name and sidebar, verifies them through a fresh authenticated client, then
connects the project and prints a complete `ub workspace use` link.

Several workspaces coexist on one hub with separate corpora. A deployed hub
admits a device credential only for a workspace with current membership.
Selection alone grants no access. Use an existing workspace with
`ub workspace use <link>` after signing in to its hub; it requires no prior
local workspace and never starts a sign-in itself.

`ub workspace` prints its help. `ub workspace status` shows the selected workspace,
its source, replica storage and sync state. `ub workspace list`
lists local workspace databases. Select a recorded replica with its id or a
unique prefix; its hub comes from this machine's record. A link fetches and
verifies the workspace before recording its hub and binding the project:

```
ub workspace use <id-or-prefix>
ub workspace use https://hub.example.test/<workspace-id>
```

A session can use several corpora through separately named MCP entries, on the
same or different hubs:

```
ub mcp install claude --project --workspace <first-uuid> --hub https://first.example.test --label product
ub mcp install claude --project --workspace <second-uuid> --hub https://second.example.test --label research
```

Each entry carries its own complete binding. Installing an existing name never
overwrites its configuration; use the vendor's management command to replace it.

The web client takes one more value, `WORKSPACES`: a comma-separated list of the
workspaces to offer in the topbar switcher, e.g.
`WORKSPACES="uberblick-<uuid>,research-<uuid>"`. Plaintext config, exported for
the run that needs it (`WORKSPACES=… mise run web`) since the ids are a uuid per
machine, and it is a *menu*, not an authority: switching workspaces is
navigating to `/<workspace>`, and a link into an unlisted workspace still opens
it. With none set, the switcher is the plain workspace label it has always been.

Both `WORKSPACE_ID` and `WORKSPACES` are the *dev server's* answer only. A
deployed client reads its workspaces at runtime from the served
`/uberblick-config.json`, beside its hub endpoint — see REMOTE.md — so giving a
deployment its workspaces is an environment variable and a container recreate,
never a bundle rebuild.

The project's own documents live in the live uberblick workspace, not in this
repository. `list_docs` enumerates them and the MCP tools read and write them;
there is no corpus import command and no snapshot to keep in step.

## The `ub` command line

`ub` is what a *user* of uberblick runs. The contributor verbs — dev, lint,
typecheck, test, e2e, review — stay mise tasks and are deliberately not
duplicated there. Homebrew installs `ub` on PATH; contributors run the checkout's
copy through mise:

```
ub init            # identity, workspace, signing secret
ub init <hub-url> --workspace <uuid>  # seed a workspace the stored login permits
ub update          # update the Homebrew installation
ub open            # serve the web app and a hub, and open the browser
ub status          # workspace, hub, stored account, connection, pending work, last sync, local log, failures
ub status --json   # full report, including account, rooms, configuration and storage paths
ub workspace       # print workspace help
ub workspace status  # the workspace in force, its selection source, storage and sync state
ub workspace list  # workspaces this machine has a database for
ub workspace use <id-or-prefix>  # select a replica with its recorded hub
ub workspace create "Project notes"
ub workspace promote http://localhost:8080
ub workspace use <link>  # fetch, verify and bind a shared workspace; sign in first
ub mcp install     # register uberblick with an MCP client
ub mcp serve       # the stdio entry point for an MCP client
```

`ub` ships no agent launcher. This repository's own delivery loops run with
[ub-agents](https://github.com/uberblick-ai/ub-agents), a separate tool.

Both declared names work — `ub` and `uberblick`. What puts them on PATH is mise:
`mise.toml` adds the checkout's `node_modules/.bin` to `[env] _.path`, and
`mise run install` (so also `mise run setup`) is what links the cli package's
declared bins there. So with [mise activated in your
shell](https://mise.jdx.dev/getting-started.html) the commands resolve inside
the checkout and nowhere else — `cd` out and `ub` is gone again. Without
activation, or in CI, prefix them: `mise x -- ub status`. And before the first
install there is nothing to link, so `mise run setup` comes first.

Inside a checkout prefer `mise run init` over calling `ub init` directly: the
task wraps it in `fnox exec`, which is how a decryptable secret becomes visible
to it in the first place. Every question `ub init` asks has a flag (`--name`,
`--color`, `--workspace`, `--yes`), and a non-interactive stdin takes the
defaults rather than blocking, so it needs no TTY. Given a hub —
`ub init hub.example.ts.net`, or the `wss://…` endpoint in full — it initializes the
selected workspace on that hub: it dials and authenticates before writing anything,
stores the endpoint, and the starter documents are there by the time it returns.
For a remote hub, run `ub auth login <hub>` first and name a workspace you
can access with `--workspace <uuid>`; a random new UUID has no membership and
is refused before anything is written. Loopback hubs retain signing-secret
authentication. It only ever fills the endpoint in: the same one again changes
nothing, and a *different* one is refused rather than overwritten, because
moving a project between hubs is `ub workspace use <link>`. `--mcp` ends by printing what
`ub mcp install --print` prints — the snippet and the file it goes in — and
`--no-mcp` says not to mention it. A bootstrap never registers a server with
somebody's agent on its own, even with a vendor CLI installed: running
`claude mcp add` is `ub mcp install`, asked for on purpose.

### Configuration

Workspace selection is explicit and atomic: workspace ID plus hub URL. Terminal
commands, `ub open`, `ub env` and `ub mcp serve` use one resolver:

1. Both `UB_WORKSPACE_ID` and `UB_HUB_URL` in the environment override the whole
   project binding. A missing, blank or invalid half is an error; values are never
   borrowed from another layer. Set `UB_HUB_URL=local` for local-only use. These
   variables work with mise, direnv and per-entry MCP environments.
2. Otherwise, search from the current directory up to the filesystem root for
   the nearest `.uberblick.json`. An invalid nearest file fails; it never falls
   through to a parent. A file in a common ancestor intentionally covers its
   descendants, including a file placed in your home directory. To give a
   repository its own selection beneath an ancestor binding, create a closer
   `.uberblick.json` there explicitly; selection commands update the nearest file.
3. Without either, `ub status` reports **No workspace selected** without opening
   a database. Workspace-dependent commands refuse until a binding is chosen.
   `ub env -- <command>` can still run non-workspace commands, with no workspace
   or hub selection exported.

```json
{
  "workspaceId": "11111111-1111-4111-8111-111111111111",
  "hubUrl": "https://hub.example.test"
}
```

Use JSON `null` for local operation on this computer. This may connect to the
embedded loopback development hub when its local signing secret is available;
it does not configure an external upstream. Without that secret, sync is disabled.
The JSON status keeps the internal transport endpoint separate from the selected
binding. The string `"local"` in a project file is rejected; use JSON null.
A hub address is normalized to its sync
endpoint; a workspace ID can have a display slug, but only its UUID identifies
data. The file contains no credentials and may be committed when its selection
is appropriate for everyone using the project. `ub status` shows the workspace,
hub and selection source. `ub init` and `ub workspace use`
update the nearest project file, or create one in the current directory.

**Migration:** legacy `WORKSPACE_ID` / `HUB_URL` inputs and workspace/endpoint
fields in the user's `config.json` no longer select a workspace. Legacy environment
selectors without a complete new pair are refused, even when a project file
exists, so an old named MCP pin cannot silently open another corpus. Existing
credentials, identity and document databases remain untouched. Add an explicit
project file with the existing workspace and hub, or set both new environment
variables. Existing MCP entries must be updated to include both variables;
installation reports conflicting entries without overwriting them.
Plain `ub init` refuses an unbound project with legacy machine selection rather
than creating a different workspace. Explicitly select the intended pair first.
Before removing old settings, run `ub workspace use <workspace-id> --hub <hub-url|local>`
once. It preserves the old endpoint's device-admission mode in private,
endpoint-keyed metadata, including when the new project uses a different hub.
After giving existing projects their bindings, finish migration by removing only
the obsolete `workspace` and `hubUrl` keys from
`$XDG_CONFIG_HOME/uberblick/config.json` (normally
`~/.config/uberblick/config.json`). Keep other fields, `credentials.json`, project
files and databases. New unbound directories can then use `ub init` to create a
fresh workspace, including starter documents; existing project bindings remain.
Temporary environment overrides are never implicitly saved by setup commands.

The private `credentials.json` remains owner-only and holds local development
signing secrets plus separate device logins keyed by hub origin. No credential
belongs in a project file or MCP entry. `HUB_AUTH_TOKEN` still overrides the
stored local development signing secret; remote sync resolves its saved login
from the private store.

One further variable is a test seam, not a configuration layer:
`UB_TEST_MAX_WAIT_MS` caps four deadlines `ub` spends probing something
remote — the hub connect and sync budgets, the port-owner and hub-clock
probes — so a suite that spawns `ub` as a real process does not sit out
budgets sized for a person on a tethered laptop. It is a ceiling, never a
floor: unset or unusable it changes nothing, and it cannot lengthen any
default. Being ordinary environment it reaches everything `ub` spawns,
children included — the reason it is a variable and not an option. Those four
are not every remote deadline `ub` owns, and no value of this variable
shortens unrelated deadlines such as GitHub approval and lock waits.
`packages/cli/src/budget.ts`'s header is the account of which deadlines this
variable may cap and which it must not.

### Where your files live

**One layout, on every platform**, resolved rather than configured, and nothing
in it for you to create: `ub init` makes the directories it needs, and there is
no workspace directory for you to make — a workspace is a uuid, and its replica
is a file named after it.

| Where | What |
| --- | --- |
| `$XDG_CONFIG_HOME/uberblick/` — or `~/.config/uberblick/` | `config.json` and `credentials.json` |
| `$XDG_DATA_HOME/uberblick/` — or `~/.local/share/uberblick/` | `hub.sqlite` and `<uuid>.sqlite`, one per workspace |

Earlier builds stored agent workflows in `agent-projects/` and `agent-workflows/`
under those roots. Nothing reads them any more, and they are safe to delete.

The two variables are independent: each moves its own root and only that one,
so setting `XDG_CONFIG_HOME` alone leaves the databases under
`~/.local/share/uberblick`. A relative value is ignored, as the XDG spec
requires. There is nothing to detect and nothing that can fail, so resolution
cannot throw and no command has an opinion about which layout is in force.

`ub status --json` carries a `storage` object with every resolved path — the
directories and database files, never the credential. `HUB_DB_PATH` and
`UBERBLICK_DB` name a database file outright and outrank all of it, which is what
this checkout's mise tasks use:
`[env] HUB_DB_PATH` points at a checkout-local file, so `mise run hub` never
opens a packaged install's database.

### Going remote: local first, then a hub, then a second computer

A published Docker hub runs on Linux or Docker Desktop on macOS, including
Apple Silicon through `linux/amd64` emulation. Follow [REMOTE.md](REMOTE.md) to
start a release on host loopback and claim its default workspace before wider
exposure. The operator updates the release deliberately while retaining its
volumes. Existing checkout hosts can
[switch to a release](REMOTE.md#switch-an-existing-checkout-host-to-a-release).

From the project directory:

```sh
ub workspace create "Project notes"
ub workspace promote http://localhost:8080
ub open
```

Promotion includes login when needed and connection after verification; there
is no separate use command on this machine. The authenticated account must currently
be a member or administrator of at least one workspace on the hub. It becomes
the promoted workspace's first and only member, as administrator. The reservation
itself leaves the default workspace, its claim state and other memberships
unchanged. On a fresh hub, the sign-in requested by promotion can claim the
default workspace through the normal first-login flow.

Promotion refuses a workspace already bound to a hub and any destination UUID
with existing documents or memberships. The only exception is its own recorded
attempt. If interrupted, rerun the same command on the same machine: its saved
attempt and the hub's atomic grant receipt allow it to resume. The local
workspace stays usable and the project binding stays local until a fresh client
has verified every document, including archived content, plus settings and
sidebar history. Close other clients while promoting so edits do not outpace
the verified snapshot. Verification is a fresh read of acknowledged hub state,
not a guarantee that the hub has flushed all documents to disk.

On another computer, use the full connection URL promotion printed:

```sh
ub auth login https://hub.example.com
ub workspace use wss://hub.example.com/ws/<workspace-id>
ub open
```

For other computers, configure HTTPS as described in the
[route table](REMOTE.md#choose-how-clients-reach-the-hub); Tailscale is optional.
Using a link fetches and verifies the existing workspace. It seeds nothing and keeps
other local workspaces separate. Existing replicas of the same UUID reconcile
as CRDTs. Use verifies the full directory, every archived document and one live
sample before binding; promotion verifies all live documents as well.

The link form reports `fetched`, `using`, and `wrote`, followed by the previous
selection and a switch-back command when the binding changed, then
`open it with: ub open`. The id form starts with `using` and omits the open hint.
`--verbose` adds the document list, verification details and config paths;
`--json` prints only the binding, previous binding and fetched documents on stdout.

Both commands persist a complete binding in `.uberblick.json`. Existing MCP
registrations retain their pinned workspace and hub; install a new named entry
for the new selection. A complete environment binding still takes precedence.
For a GitHub-enabled hub behind a loopback proxy, private user configuration
remembers device admission per endpoint, including after logout. The project
binding and MCP entries contain only the workspace and hub selection.
Local-only browser and MCP use need no promotion or GitHub login.

Stored device credentials stay private. `ub open` serves the local replica with
a separate loopback browser key; it never gives the browser an upstream key.
MCP and `ub open` renew the saved login and recover after later login or grants.
Revocation stops sharing while downloaded documents remain locally usable.
Neither promotion nor using a link sends a signing secret to a deployed hub.

## The first-user proof

`mise run fue` is the install section above, executed. It builds
`Dockerfile.fue` — Debian with git and mise on it and nothing else, no Node, no
pnpm, no age key, no secrets — copies the working tree in, and runs
`mise trust && mise run setup -- --yes` verbatim. Then, in a container started
with `--network none`, `scripts/fue-assert.mjs` checks what a new user was
promised:

- `ub status` exits 0 and names the workspace `ub init` just generated, and
  `ub status --json` reports a signing secret — the `fnox --if-missing warn`
  path, which is every contributor's path.
- `list_docs` answers over `ub mcp serve`, spoken as a real client speaks it:
  newline-delimited JSON-RPC on stdio. An empty corpus passes; so does one with
  starter documents in it.
- `mise run dev` — the command a new user is actually given, not the two halves
  it is made of — brings up a hub that accepts this machine's own credential (the
  port alone would pass with a secret nothing can authenticate with) and a web
  server that answers `/` with the app, is served the workspace `/` redirects
  into, and answers the workspace address itself rather than a 404.
- Ctrl-C then stops everything it started: `dev` exits 130 and both ports come
  free, which is what its `trap 'kill 0'` is there for.

Two properties make it worth its runtime, about 70 seconds cold. The install
half is the only thing with network, so everything asserted is asserted offline:
local-first is tested by taking the wire away. And nothing is stubbed — delete a
step from `mise run setup` and the build fails at it, which is exactly what
should happen when the documented path and the real one drift apart. Failure
prints one line naming the first broken step.

It runs on demand, like `mise run e2e`, and never in per-PR CI. Same standing
rule as the review image: no secrets, no host mounts, no privileged mode, no
Docker socket. The build context is the working tree filtered by
`Dockerfile.fue.dockerignore`, which is stricter than the review runner's
`.dockerignore` — every local database and every local config file is excluded,
because a proof that runs on state `ub init` was supposed to create proves
nothing.

## Local CI

CI runs on a maintainer's machine, not on GitHub. From a checkout at
`origin/main`, after the commit is pushed:

```sh
mise run ci <sha>
```

It runs the isolated review below (lint, typecheck and the test suite in a
Linux container without network). When that passes, it marks the commit with
a green `signoff` commit status through
[gh-signoff](https://github.com/basecamp/gh-signoff), and that status is what
merging requires. It then runs browser e2e on the host, unless only
documentation or agent process changed, and reports it as the advisory
`signoff/e2e` status. A failed step posts a red status. Install the extension
once with `gh extension install basecamp/gh-signoff`.

GitHub Actions keeps only what cannot run locally: release publishing, and the
Linux Homebrew upgrade proof after a merge that touches packaging.

## Review isolation

`mise run review <commit>` resolves its commit argument (default `HEAD`),
extracts that commit with `git archive` into a temporary directory, builds it
with the `Dockerfile.review` of freshly fetched `origin/main`, and runs the lint,
typecheck, and test gates in a disposable container. The build context is exactly
this: every committed
file of the reviewed SHA except its `.gitattributes` files, plus main's
`.dockerignore`. It cannot pick up a changing checkout, untracked files, local
`node_modules`, `.git`, or plaintext secrets, and no `export-ignore` anywhere
can quietly hold a file back from it. Everything temporary lives under one
directory that a single trap removes on success and on failure — the trees the
runner synthesizes are written in a scratch repository inside it, so the only
mark a review leaves on your own repository is the fetch it needed, on a private
ref that the same trap deletes. The resulting image is tagged
`uberblick-review:<full-sha>` and retained so a reviewer can run focused
failure-path probes against the exact same environment.

### The trust boundary

**Main owns the recipe; the reviewed commit owns the file contents.** The
Dockerfile and the effective ignore policy come from the fetched `origin/main`
commit — read out of the commit object into a private temporary directory, not
off the checkout — so a branch's own `Dockerfile.review` is never read and its
`.dockerignore` never applies. The context is archived from a copy of the
reviewed tree with every `.gitattributes` stripped, out of a scratch git
directory that borrows this repo's objects and nothing else, with
`core.attributesFile` emptied and the system attributes file switched off —
`git archive` obeys attributes from all four of those places, an `export-ignore`
in any of them would quietly drop a failing test, and `export-subst` would
rewrite file contents. `GIT_NO_REPLACE_OBJECTS` is set for the same reason: a
`refs/replace/*` entry would let a SHA name one commit and read another.
That is the whole reason the gate is one command with no
preceding inspection ceremony: `mise run review <commit>`. It is not
a claim that the reviewed code is inert — the manifests and lockfile it ships
are its own, and their install scripts run in the build stage below.

**The runner is exactly as trustworthy as the checkout it runs from**, so the
task checks that checkout before it builds anything: it fetches `origin/main`
and refuses unless HEAD is that commit and `mise.toml`, `Dockerfile.review`,
and `.dockerignore` are unmodified against it. Those three paths are the check —
not the whole tree, which is why the build reads them back from the commit
rather than from the files it just compared. Reviewing a PR still never requires
checking the branch out — `git archive` needs the commit *fetched*, not checked
out, so stay on `main` and pass the SHA. Check out a branch you are reviewing
and you have already handed it your `mise.toml`, your git hooks and your
`node_modules`, long before Docker is involved.

**The build stage has network; the verification stage does not.** Installing
the pinned package manager and the lockfile's dependencies needs the npm
registry, so `docker build` runs on Docker's default network — and the lockfile
it installs from is still the branch's, so branch-chosen install scripts run
there. The verification container that runs the gates is the isolated half:
`--network none --cap-drop ALL --security-opt no-new-privileges`. Restricting
the build itself is not on the table: `docker build --network=none` fails at
the package-manager install. A build only ever happens on an explicit
`mise run review <commit>`, which local CI runs — nothing builds a branch
automatically on push. The standing rule bounds the blast radius:
never pass build secrets, host mounts, privileged mode, or the Docker socket,
so a hostile build has no credentials of ours to exfiltrate.

## Toolchain choices

**Node 26** (`engines.node: ">=26"`, `mise` `node = "26"`). One runtime version
across the repo; it gives us stable native `fetch`/WebStreams, and `tsx` is the
only TypeScript loader we need.

**SQLite: `node:sqlite`, everywhere.** Both stores — the MCP server's local
mirror and the hub's document persistence — use Node's built-in `node:sqlite`:
ordinary SQLite files, a synchronous API, and nothing to compile at install
time. The hub used to reach SQLite through `@hocuspocus/extension-sqlite`,
which brought the better-sqlite3 native addon with it; the extension was a
two-column adapter the hub already had to subclass, so it now owns that adapter
(`packages/hub/src/persistence.ts`) and the addon is gone. Same table, same
queries, same Yjs v1 bytes, so databases written by the extension open in place
— `packages/hub/test/fixtures/extension-sqlite.sqlite` is one of them, kept as a
test input. Nothing in the tree builds a native addon now; `onlyBuiltDependencies`
in `pnpm-workspace.yaml` is down to `esbuild`.

**One copy of yjs.** `yjs`, `y-protocols` and `y-prosemirror` keep module-level
state and use `instanceof` across the doc boundary, so a duplicate silently
corrupts documents. They are pinned to one exact version each via the
`catalog:` entries **and** `overrides` in `pnpm-workspace.yaml`, and `yjs` is a
`peerDependency` of `@uberblick/schema` (never a hard dependency) so the app
package owns the instance. Check with `mise exec -- pnpm why yjs`.

## Secrets

Encrypted secrets would live in `fnox.toml`, age-encrypted; it holds none today,
and the loopback signing secret lives in each machine's `credentials.json`. The
private key is expected at `~/.config/fnox/age.txt` and never in the repo. Only real
secrets go there: plaintext local defaults such as `HUB_DB_PATH` live in
`mise.toml`'s `[env]` block. `HUB_URL` deliberately does not — that block is
ambient for everything in a checkout, so its `ws://localhost:1234` default lives
in the clients' code instead, and the endpoint a machine actually dials comes
from its explicit project/environment binding through `ub env`.

Contributors without the age key are not blocked. The task wrappers pass
`fnox exec --if-missing warn` explicitly, so a secret fnox cannot decrypt logs a
warning and the command still runs with that variable left as it found it instead
of aborting. See
"The signing secret" above for the whole precedence chain. `mise run lint`,
`mise run test` and `mise run typecheck` don't shell through fnox at all.

`HUB_AUTH_TOKEN` is the HMAC secret loopback hub tokens are signed with, and
`ub init` generates one when the machine has none. A loopback-only hub requires
it. Remote hubs require GitHub sign-in configuration and admit only device
credentials with membership, including the Docker proxy's host-loopback
route. The MCP server
keeps its local replica usable when its remote login is absent or refused,
reports the needed action, and resumes sharing after login with access. A
local-admission binding without a secret reports `hub.status: "disabled"`. `WORKSPACE_ID` it does
require — with none set it exits non-zero, naming `ub init` — and it reads
`UBERBLICK_DB` (default `<uuid>.sqlite` in the data root — see [Where your files
live](#where-your-files-live) — keyed by the bare uuid so both spellings of a
workspace hydrate one file). A database
records the workspace it holds, so pointing `UBERBLICK_DB` at another
workspace's file makes the server exit non-zero naming both ids and the path
rather than merging two corpora into one index.
