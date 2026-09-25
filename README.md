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

### Install on an Apple Silicon Mac

With [Homebrew](https://brew.sh) installed:

```sh
brew install uberblick-ai/tap/uberblick
ub --version
```

The first published release reports `0.1.0`. Homebrew installs Node and its
dependencies; you do not need the Uberblick source checkout or mise.
If a new terminal cannot find `brew`, run
`eval "$(/opt/homebrew/bin/brew shellenv)"` and follow Homebrew's shell setup instructions.

### Connect an existing workspace to your project

Clone your own project's repository and enter its directory. With access to
your hub's network (for example, through Tailscale), join the workspace using
the URL supplied by its owner:

```sh
ub remote join wss://YOUR-HUB/ws/YOUR-WORKSPACE-ID
ub status
```

Replace the URL with the real hub and workspace ID. Enter the signing secret
in the hidden terminal prompt, never as a command argument. You do not need
`ub init` first. Joining stores this machine's remote connection and hydrates
the workspace's documents locally.

If another Mac is already connected to the same hub, its credential is in
`~/.config/uberblick/credentials.json` (or under `$XDG_CONFIG_HOME`). Copy it
over SSH without displaying it:

```sh
# On the connected Mac; replace USER@NEW-MAC with your SSH destination.
scp -p ~/.config/uberblick/credentials.json USER@NEW-MAC:~/ub-join-secret.json

# On the new Mac, using your real workspace URL.
chmod 600 ~/ub-join-secret.json
ub remote join wss://YOUR-HUB/ws/YOUR-WORKSPACE-ID --secret-file ~/ub-join-secret.json
# After a successful join, remove the temporary copy.
rm ~/ub-join-secret.json
```

For Claude Code, installed and authenticated separately, register MCP from
your project's directory:

```sh
ub mcp install claude --project --workspace YOUR-WORKSPACE-ID
```

This pins the project's MCP entry to that workspace. Start a new Claude session
and ask it to list the workspace's documents through Uberblick MCP. Registration
does not install an agent workflow or start a delivery loop.

### Create a new local workspace

If you are starting a workspace rather than joining an existing one:

```sh
ub init
ub open
```

### Contribute to Uberblick

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
held. `.github/workflows/homebrew-formula.yml` proves that on an Apple Silicon
runner for every change to the formula or its payload.

### The signing secret

`HUB_AUTH_TOKEN` is the HMAC **secret** hub tokens are signed with, not a token.
There are two ways to have one, and they do not fight:

- **The repository owner's path — fnox.** The real secret lives age-encrypted in
  `fnox.toml`, and every task wraps its command in `fnox exec`. With the age key
  at `~/.config/fnox/age.txt`, that value wins: `fnox exec` **overwrites**
  `HUB_AUTH_TOKEN` in the environment it hands to the command. `ub init`
  generates nothing when it can already see one.
- **Everybody else — a generated development secret.** With no age key,
  `fnox exec --if-missing warn` warns and leaves the variable alone, and
  `ub init` writes 32 random bytes to `credentials.json` (mode 0600) in this
  machine's config root — see [Where your files live](#where-your-files-live).
  That file is the authority, and there is no copy of it anywhere else. It is
  generated only while this machine has **no hub endpoint stored**: a machine
  bound to a hub needs *that* hub's secret, so with none visible `ub init`
  refuses and names the two places it looked rather than writing a random value
  the hub would reject.

A mise task reaches it the same way an MCP client's server does: every task that
needs configuration wraps its command in `fnox exec -- ub env -- …`, and
`ub env -- <command…>` execs the command under exactly the environment `ub`
resolved. So the precedence a task sees is `ub`'s own, highest first: a
decryptable fnox secret in the environment, then `credentials.json`. There is
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
mise run check-agents # the six role triplets under .agents/.claude/.codex
mise run e2e          # browser proof points (Playwright, Chromium, on demand)
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
three times.

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

The installed line is always `ub mcp serve`. Which hub and which credential
apply is resolved by `ub` — a client config that pinned either would be a second
copy of configuration that already has an owner, and a project config is
committable, so a secret has no business being in one. The **one** value an
entry may carry is `WORKSPACE_ID`, and only when `--workspace` asks for it:

```
ub mcp install claude --project --workspace ablauf-<uuid>
```

**A project MCP entry is this repository's workspace binding.** That is the
whole mechanism; there is no per-directory config file of uberblick's own. The
client already reads a project-scoped MCP config to know what to spawn in this
working directory, so the pin goes there: `WORKSPACE_ID` is the top precedence
layer, so every agent session started in this checkout resolves that workspace
and nothing else has to be told. Without `--workspace` the entry stays unpinned
and follows this machine's default, which is the right answer for a repository
that has no workspace of its own.

Re-pinning an entry that already exists is not this command's job any more: an
entry pinned to another workspace is not the one it would register, so it is
reported and the snippet printed, and the change is made in the client's own
config or with the vendor's own command. That cuts both ways, which is the
point — a repository quietly moved to another corpus is exactly what the pin is
there to prevent.

`.mcp.json` in this checkout is exactly that file, and it is generated rather
than hand-maintained — it is what `ub mcp install claude --print` emits, and a
test asserts the committed bytes are that snippet. It is deliberately unpinned:
this repository works in whatever workspace `ub workspace use` last named.

For a standalone smoke test, `mise run mcp` runs the same server in the
foreground.

### A second workspace

Several workspaces coexist on one hub, with separate corpora and no way to see
across: the room key carries the workspace (`<workspaceId>/<docUuid>`, the
directory at `<workspaceId>/_directory`), the token claim is scoped to it, and
the local database is `<uuid>.sqlite`. There is nothing to create and nothing to
migrate — a workspace is a uuid, and its rooms exist the moment something opens
one. What it is *not* is tenancy: one shared secret still mints a token for any
workspace, so this separates corpora, not people — namespacing for one trusted
user, with real isolation waiting on per-workspace auth (#84).

Give a second project its own workspace by pinning it in that checkout's project
MCP config — committable, and never secrets. That is one command, run in the
checkout:

```
ub mcp install claude --project --workspace ablauf-$(uuidgen | tr A-Z a-z)
```

That registers `WORKSPACE_ID` on the `uberblick` entry of this directory's
`.mcp.json` — through `claude mcp add -e`, which is the vendor's own way of
saying it — and every agent session started here spawns through that entry.
Nothing else is in it, and nothing else is copied into it.

To change this *machine's* default instead — what an unpinned entry, `ub status`
and the mise tasks all resolve to — use `ub workspace use <id>`. It writes your
`config.json`, and every reader follows it: the tasks run through `ub env`, so
`mise run web` and the hub pick up the switch with nothing else to keep in step.
`ub workspace` on its own
prints the workspace in force and which layer chose it; `ub workspace list`
shows the workspaces this machine has a database for, so `use` and
`--workspace` both also take a unique uuid prefix from that list.

One agent session can hold **two** workspaces at once: `--label <label>` puts the
pin on a separately named `uberblick-<label>` entry instead of the primary one,
so two processes serve two corpora under two tool prefixes.

```
ub mcp install claude --project --workspace <other-uuid> --label ablauf
```

Either way it is the same server, the same hub and a different corpus.

The web client takes one more value, `WORKSPACES`: a comma-separated list of the
workspaces to offer in the topbar switcher, e.g.
`WORKSPACES="uberblick-<uuid>,ablauf-<uuid>"`. Plaintext config, exported for
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
duplicated there. Homebrew provides `ub` outside a checkout; contributors can
also run it from this repository:

```
ub init            # identity, workspace, signing secret
ub init <hub-url>  # the same, with the new workspace created on that hub
ub update          # update this copy — Homebrew, or a checkout on main
ub open            # serve the web app and a hub, and open the browser
ub status          # workspace, hub, credential, sync state
ub status --json   # the same, as one JSON object
ub workspace       # the workspace in force, and which layer chose it
ub workspace list  # workspaces this machine has a database for
ub workspace use   # make a workspace this machine's default
ub remote          # the endpoint in force, and what sharing it buys
ub agents install  # store a workflow and select it for this project folder
ub agents list     # inspect this project's selection and available roles
ub agents uninstall  # remove this project's selection, keeping stored packages
ub agents launch   # keep one entry role of a project you select running
ub mcp install     # register uberblick with an MCP client
ub mcp serve       # the stdio entry point for an MCP client
```

For this repository's delivery workflow, run both reviewer loops in separate
terminals alongside the implementer and integrator:

```sh
ub agents launch implementation-reviewer --model claude
ub agents launch implementation-reviewer --model codex
```

Each loop serves only its selected runtime. A request naming Codex cannot be
answered by the Claude loop, even when that loop is idle. The reviewer still
checks that its session did not author the candidate.

If an existing loop reports that `.agents/launch.json` must contain only
version 1 while the project has version 2, stop that loop with Ctrl-C. Run
`type -a ub` to identify the executable your shell selects, update that
installation or source checkout, and start a fresh loop. Check
`ub agents launch --help` from the same shell: it must describe launch data
version 2. Updating files does not reload code already running in an old
process. Preserve valid version 2 launch data; restoring or downgrading the
configuration cannot update the old executable.

**`ub agents launch <role>` runs *your project's* selected workflow, not
uberblick's.** `ub agents install <workflow@version|package-path>` validates and
stores a package in this machine's Uberblick data, then selects that immutable
installation for the project folder; running install again changes that one
selection, `ub agents list` reports it and `ub agents uninstall` removes only
the association. None of those commands writes a workflow file, symlink,
setting or lock into the project. Separate folders can select separate versions,
including folders that are not Git repositories. Launch itself still requires
Git when it creates a role's worktree and names that requirement if the selected
folder is not a checkout. `ub agents update` is retired; install is the one
selection-changing command.

The project's own `.agents/launch.json` continues to declare which entry roles
exist, their default runtime, sandbox or permission mode, and — under `project`
— the bindings its workflow reads, starting with the `baseRef` every session's
worktree is cut from. Contracts, runtime adapters and workflow helpers resolve
from the selected stored installation; the project-declared work probe keeps
running from the selected project with that installation in its session context.
A running session retains the project, installation and binding snapshot with
which it started; the standing loop re-reads the selection before its next
session. Temporarily, a project with no
external selection still launches from its tracked workflow files so an
existing loop is not stranded during the cutover. The command still selects,
claims and transitions nothing; the role does all of that.

Grants stay yours. You authenticate `claude` and `codex` once, and `ub` writes
no trust entry, copies no credential and passes a session exactly the sandbox,
permission mode and tool approvals its project declared. Each runtime does keep its own record
of the project paths it has seen, in its own user-level configuration — a first
launch for a path a runtime has not seen before completes without an
interactive dialog and leaves such a record behind, and a runtime may rewrite
it again later in the same session. That is the supported setup rather than a
fault to suppress (owner decision, 2026-09-08). A runtime that is missing or
logged out stops the launch before any session starts, naming what to do.

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
`ub init hub.example.ts.net`, or the `wss://…` endpoint in full — it creates the
new workspace *on that hub*: it dials and authenticates before writing anything,
stores the endpoint, and the starter documents are there by the time it returns.
That needs the hub's signing secret to be here already (`HUB_AUTH_TOKEN`, or
`credentials.json`), since a secret generated here would be random and the hub
would refuse it. It only ever fills the endpoint in: the same one again changes
nothing, and a *different* one is refused rather than overwritten, because
moving a machine between hubs is `ub remote join`. `--mcp` ends by printing what
`ub mcp install --print` prints — the snippet and the file it goes in — and
`--no-mcp` says not to mention it. A bootstrap never registers a server with
somebody's agent on its own, even with a vendor CLI installed: running
`claude mcp add` is `ub mcp install`, asked for on purpose.

Configuration is JSON and every layer is optional — absent configuration is a
default, never an error — with one exception: the **workspace** has no default.
A workspace id is a uuid, optionally decorated for display as `<slug>-<uuid>`
(the slug is cosmetic; only the uuid names a room, a token claim or the local
database). Nothing invents one, because a guessed workspace would open a corpus
nobody chose, so `ub init` is what creates one and `ub status`, `ub mcp serve`
and the MCP server all refuse to run without it — naming `ub init` when they do.
Precedence, highest first:

| Layer | Holds |
| --- | --- |
| environment (`WORKSPACE_ID`, `HUB_AUTH_TOKEN`) | wins, so a project MCP entry's `WORKSPACE_ID` pin binds the repository it travels with, and `fnox exec` can supply the secret. **Not the endpoint** |
| `config.json` | per-user identity (display name, cursor colour), the workspace and the hub endpoint — what `ub init` and `ub remote join` write. Which directory it is in is [the layout](#where-your-files-live) |
| `credentials.json`, mode 0600, beside it | the hub signing secret. Never printed by any command, and refused outright — not merely warned about — if anyone but its owner can read it |
| built-in defaults | hub `ws://localhost:1234`. No workspace: there is no default one |

**The endpoint has one authority.** `HUB_URL` in the environment is not a layer:
it is not read, and it is not passed on to anything `ub` spawns. Two ambient
sources for an endpoint is what silently redirected a machine bound to a remote
hub at a local one while its writes reported `synced` (#376) — so the value in
`config.json` is the answer, and two commands write it: `ub init <hub-url>`
fills it in on a machine that has none, and `ub remote join` is how it changes.
Neither is a file to edit by hand.

There is no per-directory config file either: a repository that needs its own
workspace pins `WORKSPACE_ID` in the project MCP entry the client already reads,
which arrives as the environment. Nothing committable carries an endpoint or a
credential, and a checkout is not a configuration layer — its tasks *consume*
this machine's configuration through `ub env` rather than keeping a copy.

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
| `$XDG_CONFIG_HOME/uberblick/` — or `~/.config/uberblick/` | `config.json`, `credentials.json` and project workflow selections under `agent-projects/` |
| `$XDG_DATA_HOME/uberblick/` — or `~/.local/share/uberblick/` | `hub.sqlite`, `<uuid>.sqlite` per workspace, and verified packages under `agent-workflows/` |

The two variables are independent: each moves its own root and only that one,
so setting `XDG_CONFIG_HOME` alone leaves the databases under
`~/.local/share/uberblick`. A relative value is ignored, as the XDG spec
requires. There is nothing to detect and nothing that can fail, so resolution
cannot throw and no command has an opinion about which layout is in force.

`ub status` names the data root; `ub status --json` carries a `storage` object
with every resolved path — the directories and database files, never the
credential. `HUB_DB_PATH` and `UBERBLICK_DB` name a database file outright and
outrank all of it, which is what this checkout's mise tasks use:
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
ub remote join wss://<host>.ts.net/ws/<workspace id> \
  --secret-file ~/uberblick-remote-secret
```

That URL is what `ub remote init` prints: the endpoint with the workspace id as
its **last path segment**. Two journeys, two verbs, and that is the whole of the
command surface — a *new* workspace is `ub init [hub-url]`, which seeds starter
documents and, given the hub's address, creates that workspace on it in the same
command; a workspace that already exists somewhere is `ub remote join` (which
seeds nothing). There is no operator suite beside them: nothing that
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
`ub workspace use <id>` switches back. The endpoint is machine-wide,
though, so after a join that workspace syncs with the remote hub too, under its
own rooms.

Inside a clone, `mise trust && mise run setup -- --yes` first and then the join
gives you `mise run web` against the remote hub: the tasks run through
`ub env`, so they follow the workspace and the endpoint the join persisted with
nothing written into the checkout.

The secret that reached the remote replaces whatever this machine had, in
`credentials.json` at mode 0600, and the command says it is doing so. That is
the whole point on a second machine: a locally generated secret is *random*, and
the remote verifies with the first machine's.

**What "persisted" covers.** The endpoint — and, after a `join`, the workspace
binding with it — goes into your `config.json`, which is the only place `ub`,
`ub mcp serve`, the MCP server it spawns and every checkout task running under
`ub env` resolve them from. Nothing outranks it, so a report naming the endpoint
is naming the one in force. A *workspace* can still be outranked, by
`WORKSPACE_ID` in the environment — a project MCP entry's pin — and `join` says
so when it is.

A deployed web client does not read any of these: it resolves its endpoint — and
its workspaces — at runtime from the served `/uberblick-config.json`.

Archived documents travel with their content. Their tombstones replicate too,
so they stay archived until restored on the destination.

The remote's signing secret comes from `--secret-file <path>` (a file only you
can read, mode 0600 — a `credentials.json` works, or the bare secret) or from a
hidden prompt when the configured one is refused and there is a terminal to ask.
Never as an argument: a command line is in every `ps` listing and every shell
history. Neither the secret nor a token signed with it is printed by any of
these commands.

`ub remote` with no remote configured says
so and exits 0; with one, it prints the endpoint and states the boundary you
actually get: the host serves the shared signing secret to the web app, so
reaching the app is the same as holding the credential, and the deployment is
supported only on a private network until accounts land (#84). There is no
`invite` command (#92) for that reason.

`ub mcp serve` resolves that configuration and runs the MCP server with it, so
the server keeps its environment-only contract — no flags, no config file — and
a client's spawn line never has to change again when internals move. This
checkout's `.mcp.json` is the one place that still names a spawn of its own,
for the reasons given above, and `ub mcp install claude --print` emits it.

## The first-user proof

`mise run fue` is the install section above, executed. It builds
`Dockerfile.fue` — Debian with git and mise on it and nothing else, no Node, no
pnpm, no age key, no secrets — copies the working tree in, and runs
`mise trust && mise run setup -- --yes` verbatim. Then, in a container started
with `--network none`, `scripts/fue-assert.mjs` checks what a new user was
promised:

- `ub status` exits 0, names the workspace `ub init` just generated, and reports
  a signing secret — the `fnox --if-missing warn` path, which is every
  contributor's path.
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
`mise run review <commit>` — nothing builds a branch automatically
and no CI job builds one on push. The standing rule bounds the blast radius:
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

Secrets live in `fnox.toml`, age-encrypted and safe to commit. The private key
is expected at `~/.config/fnox/age.txt` and never in the repo. Only real
secrets go there: plaintext local defaults such as `HUB_DB_PATH` live in
`mise.toml`'s `[env]` block. `HUB_URL` deliberately does not — that block is
ambient for everything in a checkout, so its `ws://localhost:1234` default lives
in the clients' code instead, and the endpoint a machine actually dials comes
from its own `config.json` through `ub env`.

Contributors without the age key are not blocked. The task wrappers pass
`fnox exec --if-missing warn` explicitly, so a secret fnox cannot decrypt logs a
warning and the command still runs with that variable left as it found it instead
of aborting — which is what lets `ub init`'s generated secret through. With the
key, `fnox exec` overwrites the variable, so the encrypted value wins. See
"The signing secret" above for the whole precedence chain. `mise run lint`,
`mise run test` and `mise run typecheck` don't shell through fnox at all.

`HUB_AUTH_TOKEN` is the HMAC secret hub tokens are signed with, and `ub init`
generates one when fnox cannot supply it. The hub refuses to start without it —
a hub that cannot verify a token would accept anything.
The MCP server treats it as optional and runs local-only without it: its update
log is the authoritative replica, so no secret means no sync, not no service
(`sync_status` reports `hub.status: "disabled"`). `WORKSPACE_ID` it does
require — with none set it exits non-zero, naming `ub init` — and it reads
`UBERBLICK_DB` (default `<uuid>.sqlite` in the data root — see [Where your files
live](#where-your-files-live) — keyed by the bare uuid so both spellings of a
workspace hydrate one file). A database
records the workspace it holds, so pointing `UBERBLICK_DB` at another
workspace's file makes the server exit non-zero naming both ids and the path
rather than merging two corpora into one index.
