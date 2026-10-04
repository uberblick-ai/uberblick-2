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

One command for both installation kinds, and which one it updates comes from
where that `ub`'s own files live — never from the directory you are standing
in, so a Homebrew `ub` typed inside a checkout still updates Homebrew's copy.
A copy installed from the `uberblick-ai/tap` Homebrew tap is handed to
Homebrew, exactly as below. A checkout **on `main`** is fast-forwarded to
`origin/main` and its dependencies and web app are refreshed to match, so it is
runnable at the new head with nothing left to run by hand; a checkout on any
other branch is not updated. Nothing is ever stashed, discarded, rebased or
switched: git decides whether the fast-forward is safe — divergence, or
uncommitted changes an incoming commit would overwrite, are its refusal to
make — and when it refuses you get git's own reason and an unchanged checkout.
Unpushed commits on `main` are not a refusal: that checkout already contains
`origin/main`, so it goes straight to the refresh and keeps them.

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

### The signing secret

`HUB_AUTH_TOKEN` is the HMAC **secret** loopback hub tokens are signed with.
Remote hubs and clients use stored device logins; this secret grants no remote
access and is never sent to a remote hub.

The repository holds no copy of it. Unless a secret is already supplied,
`ub init` writes 32 random bytes to `credentials.json` (mode 0600) in this
machine's config root — see [Where your files live](#where-your-files-live).
It is generated only while this machine has **no hub endpoint stored**: a
machine bound to a loopback hub needs that hub's secret. Remote bindings instead
use the login established by `ub auth login`.

A mise task reaches it the same way an MCP client's server does: every task that
needs configuration wraps its command in `fnox exec -- ub env -- …`, and
`ub env -- <command…>` execs the command under the configuration `ub`
resolved and passes the signing secret only for loopback endpoints. Device
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

To run the hub and built web client on a remote Tailscale host, follow
[REMOTE.md](REMOTE.md). The remote deployment uses Docker Compose and Caddy for
TLS, WebSocket proxying, and SPA fallback.

`mise run e2e` is the only task that drives a browser. It starts its own hub on
an ephemeral port with a throwaway signing secret and a temp database, and its
own Vite dev server on an ephemeral port, so it needs no fnox key and cannot
collide with a running `mise run dev`. It covers exactly what jsdom cannot —
two live clients converging on one block, a rendered remote cursor, and fresh
and reloaded browsers receiving only what their server sends. Everything else
belongs in `mise run test`. Arguments after `--` go to Playwright unchanged; for
example, `mise run e2e -- --repeat-each=3 outline.spec.ts` runs only that spec
three times. The full suite runs in Chromium; a tagged device and engine set
also runs in WebKit at iPhone, iPad and 13-inch MacBook sizes. WebKit requires
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

This repository's MCP entries deliberately select a pinned installed client
through a host launcher, as described below. The generic `ub mcp install
claude --print` snippet still uses `ub mcp serve`. The repository entries carry
no credential. Existing custom launchers must provide a complete binding when upgrading to this configuration model.

For a standalone smoke test of checkout source, `mise run mcp` runs it in the
foreground. Use separate candidate configuration and data when the corpus hub
still runs an older protocol.

### Keep the corpus client independent of the checkout

Mise prepends `node_modules/.bin` inside this checkout. Bare `ub` there executes
the checkout's CLI source, including in agent workers; it can switch protocols
when the operator pulls main. Keep the existing corpus installation on its
compatible installed client while testing a new hub and client separately.
Merging source does not authorize upgrading that installation.

The repository's `.mcp.json`, `.codex/config.toml` and both ub-agents runtime
definitions invoke `$HOME/.local/bin/uberblick-corpus-mcp`. It selects a bundled,
installed snapshot of the pre-switch operator revision
`b574609cd5d8456a3e11ba10e3d6eeaaf1770d82`, with protocol 1 and the current
corpus interfaces. The published Homebrew `0.2.0` client has protocol 1 but
omits current decision tools and authority fields; using it would regress those
contracts. Its existing installation stays untouched.

Build the pinned snapshot with the existing payload builder, then install it
and the reviewed launcher **before** the new MCP definitions become active.
Run this from the reviewed correction checkout. In an agent session the
temporary source and build output belong in private run scratch:

```sh
set -eu
corpus_sha=b574609cd5d8456a3e11ba10e3d6eeaaf1770d82
corpus_version=0.2.0-corpus.b574609
corpus_build=$(mktemp -d "${UB_AGENTS_SCRATCH:-${TMPDIR:-$PWD}}/uberblick-corpus-${UB_AGENTS_RUN:-attended}-XXXXXXXX")
mkdir "$corpus_build/source"
git archive "$corpus_sha" | tar -x -C "$corpus_build/source"
mise exec -- pnpm --dir "$corpus_build/source" install --frozen-lockfile
UBERBLICK_PAYLOAD_OUTPUT_DIR="$corpus_build/output" mise exec -- \
  node "$corpus_build/source/scripts/build-install-payload.mjs" "$corpus_version"
corpus_install="$HOME/.local/share/uberblick-corpus-clients/$corpus_sha"
# Refuse to replace an installation already used by running sessions.
mkdir -p "$(dirname "$corpus_install")"
mkdir "$corpus_install"
tar -xzf "$corpus_build/output/uberblick-$corpus_version.tar.gz" \
  --strip-components=1 -C "$corpus_install"
mkdir -p "$HOME/.local/bin"
install -m 755 bin/corpus-mcp.sh "$HOME/.local/bin/uberblick-corpus-mcp"
"$HOME/.local/bin/uberblick-corpus-mcp" --check
rm -rf "$corpus_build"
```

This local artifact is named `0.2.0-corpus.b574609`; it is not a published
release. On both supported platforms, the launcher calls that snapshot's
`bin/ub` in the directory above and verifies the version before starting MCP.
For another installation directory, set `UB_CORPUS_CLIENT` to its absolute
executable in the actual launcher environment; the same version is required.
No pin failure falls back to PATH, a moving Homebrew link or checkout source.
`--check` prints only the executable and version and reads no workspace or
credentials. The bundles contain their dependencies and load no checkout code.
The host still needs Node 26 or newer, as the ordinary installed client does.

Claude workers receive the MCP definition inline, and Codex workers receive
explicit runtime overrides. This also covers older PR worktrees whose own MCP
files still name bare `ub`; the host launcher exists outside every checkout.
The runner reloads configuration at its next execution boundary. Existing
workers keep their running MCP processes; do not interrupt them for this pin.

Verify the actual MCP child in a newly started worker, including a private
worktree: it must execute the snapshot's `packages/cli/lib/mcp.mjs`, and
`sync_status` must report the existing hub and compatible protocol. A login-shell
`which ub` or the launcher's `--check` alone does not prove worker resolution.
`tools/list` must include `find_decisions` and the current decision-authority
schemas. Run existing-installation commands such as `open` with the same
explicit snapshot executable, rather than bare `ub` inside mise. None of this
changes the selected workspace, credentials or data directory. [REMOTE.md](REMOTE.md#keep-an-existing-installation-while-testing-a-candidate)
gives the separate candidate rehearsal and later coordinated upgrade.

### A second workspace

Several workspaces coexist on one hub, with separate corpora and no way to see
across: the room key carries the workspace (`<workspaceId>/<docUuid>`, the
directory at `<workspaceId>/_directory`), the token claim is scoped to it, and
the local database is `<uuid>.sqlite`. There is nothing to create and nothing to
migrate — a workspace is a uuid, and its rooms exist the moment something opens
one. A loopback hub trusts its local signing secret. A remote hub admits only
a device credential naming the workspace with current membership, and closes
sessions when that credential is revoked or membership is removed.

Bind a project to an existing workspace with `ub remote join <workspace-url>`.
For a local workspace use `ub init`; remote membership must already exist.
These commands write `.uberblick.json` for the project, and never grant access
merely by selecting a UUID. Client-side creation of another remote workspace is
separate work.

`ub workspace` prints the current binding and its source. `ub workspace list`
lists local workspace databases. Selecting another known workspace requires an
explicit hub, so the selection cannot inherit an unrelated endpoint:

```
ub workspace use <uuid> --hub https://hub.example.test
ub workspace use <local-uuid> --hub local
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
ub update          # update this copy — Homebrew, or a checkout on main
ub open            # serve the web app and a hub, and open the browser
ub status          # workspace, hub, connection, pending work, local log, failures
ub status --json   # full report, including rooms, configuration and storage paths
ub workspace       # the workspace in force, and which layer chose it
ub workspace list  # workspaces this machine has a database for
ub workspace use <id> --hub <url|local>  # select a complete project binding
ub remote          # the endpoint in force, and what sharing it buys
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
moving a machine between hubs is `ub remote join`. `--mcp` ends by printing what
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
   through to a parent.
3. Without either, `ub status` reports **No workspace selected** without opening
   a database. Workspace-dependent commands refuse until a binding is chosen.

```json
{
  "workspaceId": "11111111-1111-4111-8111-111111111111",
  "hubUrl": "https://hub.example.test"
}
```

Use JSON `null` for a local-only hub. A hub address is normalized to its sync
endpoint; a workspace ID can have a display slug, but only its UUID identifies
data. The file contains no credentials and may be committed when its selection
is appropriate for everyone using the project. `ub status` shows the workspace,
hub and selection source. `ub init`, `ub remote join` and `ub workspace use`
update the nearest project file, or create one in the current directory.

**Migration:** legacy `WORKSPACE_ID` / `HUB_URL` inputs and workspace/endpoint
fields in the user's `config.json` no longer select a workspace. Existing
credentials, identity and document databases remain untouched. Add an explicit
project file with the existing workspace and hub, or set both new environment
variables. Existing MCP entries must be updated to include both variables;
installation reports conflicting entries without overwriting them.

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
shortens the others: `ub remote init`, for one, budgets a deployment's first
answer at 90 s and gives each of its two HTTP probes 10 s.
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

The normal journey is local first and remote later, and `ub remote` is the part
that keeps a corpus from being left behind when the endpoint changes. Documents
a browser created live only in the local hub until an MCP session pulls them
down, so an endpoint changed without them strands them.

**On the remote host** — a Linux box in your tailnet — one command from your own
machine stands the hub and the web client up:
`ub remote init <ssh-target>`, which [REMOTE.md](REMOTE.md) describes in full. It
clones `main` onto the host and builds from it; **the host never updates
itself** — `ub remote update <ssh-target>` deploys `origin/main` onto it when you
mean to, and a change to wire semantics must update the clients in the same
sitting. It ends by printing this machine's endpoint and the join URL, and
persists the endpoint here.

**On every computer**, including this one, one command binds a machine to the
workspace, whatever is on it already:

```
ub auth login <host>.ts.net
ub remote join wss://<host>.ts.net/ws/<workspace id>
```

That URL is what `ub remote init` prints: the endpoint with the workspace id as
its **last path segment**. `ub init [hub-url]` seeds starter documents; remote
initialization requires membership for the selected UUID. `ub remote join`
uses a workspace that already exists and seeds nothing. There is no operator suite beside them: nothing that
repoints the clients without moving anything. The id has to travel,
because a workspace id is a uuid and `ub init` generates a *new* one: a machine
that invented its own would join the remote hub and find nothing of yours on it,
the rooms being keyed by a different id. Carrying it in the URL is what makes it
one paste instead of two.

`join` binds this machine to the workspace the URL names **regardless of local
state** — no prior `ub init` is needed, and one that has run is not in the way.
It hydrates the full remote directory and every live and archived document room
into that workspace's replica. A fresh client then verifies the full directory,
every archived room, and one sampled live room before the endpoint and binding
are persisted. A replica this machine already holds for that id is attached
rather than replaced: the two reconcile as CRDTs — what the local log holds goes
up, what the hub holds comes down, and nothing on either side is discarded —
which is how the machine that ran `ub remote init` joins its own populated
workspace. An unreachable or auth-rejecting remote leaves your configuration
exactly as it was, and a URL missing its workspace id, or carrying something
that is not one, is refused before anything is written, with the expected form
in the message.

A workspace on this machine under a *different* id stays. It is never merged
into the joined one and never moved: `ub workspace list` shows both, and
`ub workspace use <id> --hub <url|local>` selects its complete binding. A remote
workspace is accessible only when the device credential and current membership
allow its UUID.

Run `ub open` to edit from this computer's browser after signing in and joining.
The MCP server and `ub open` use this hub's stored login, renew it without new
GitHub approval, and resume after restart. Device credentials never reach the
browser; `ub open` serves a separate loopback key. `mise run dev` stays a local
development path and does not sync its browser with a remote hub.

**What "persisted" covers.** The complete binding goes into the project's
`.uberblick.json` only after the existing verification succeeds. A complete
environment pair can override it; commands report that selection source. No
workspace or endpoint is borrowed from machine-wide defaults.

A deployed web client does not read any of these: it resolves its endpoint — and
its workspaces — at runtime from the served `/uberblick-config.json`.

Archived documents travel with their content. Their tombstones replicate too,
so they stay archived until restored on the destination.

Remote commands accept no signing secret and send no GitHub token. A missing
login names `ub auth login`; rejected renewal asks for sign-in again; missing
workspace access names its administrator. Running MCP and `ub open` processes
recover after a later login or membership grant without restart. Revocation or
membership removal stops live sync while local documents and edits stay usable.
Downloaded data cannot be erased by revocation.

`ub remote` with no remote configured says so and exits 0; with one, it prints
the endpoint and the device-login boundary. The host's web page receives no
credential and shows no documents until direct browser sign-in is available.
Use `ub auth login` and `ub open` on a computer. [REMOTE.md](REMOTE.md) gives
the coordinated hub/client upgrade order; an old signing secret in the host's
`.env` grants nothing.

`ub mcp serve` resolves that configuration and runs the MCP server with it, so
the server keeps its environment-only contract — no flags, no config file.
Generic registration uses that command. This repository's MCP definitions
select the compatible installed client through the corpus launcher above.

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
credentials with membership. The MCP server
keeps its local replica usable when its remote login is absent or refused,
reports the needed action, and resumes sharing after login with access. A local
loopback binding without a secret reports `hub.status: "disabled"`. `WORKSPACE_ID` it does
require — with none set it exits non-zero, naming `ub init` — and it reads
`UBERBLICK_DB` (default `<uuid>.sqlite` in the data root — see [Where your files
live](#where-your-files-live) — keyed by the bare uuid so both spellings of a
workspace hydrate one file). A database
records the workspace it holds, so pointing `UBERBLICK_DB` at another
workspace's file makes the server exit non-zero naming both ids and the path
rather than merging two corpora into one index.
