# Uberblick user guide

Start with the [README](README.md) to install Uberblick and open your first local
workspace. This guide covers the shipped CLI and its local files; each command's
`--help` gives its options.

## Updating

```sh
ub update
```

`ub update` updates only a copy installed from the `uberblick-ai/tap` Homebrew
tap. It identifies the installation from where that `ub`'s own files live, so a
Homebrew `ub` typed inside a checkout still updates Homebrew's copy.

Running these Homebrew commands directly is the same thing: the first refreshes
the tap, the second replaces the installed copy with the newest published release.

```sh
brew update
brew upgrade uberblick-ai/tap/uberblick
```

`ub --version` then prints the new version, and `ub` and `uberblick` stay on
PATH where they were. The upgrade replaces only what Homebrew installed:
everything under [Where your files live](#where-your-files-live) —
configuration, credentials, workspaces and their databases — is untouched, and
`ub status` still reports the same workspace with the documents it already held.
For a source checkout, follow [contributor updating](CONTRIBUTING.md#updating).

## The MCP server, as a client sees it

`ub mcp install [client]` wires Uberblick into an MCP client, so nobody has to
hand-edit JSON. It knows `claude`, `codex` and `cursor`; project scope is the
default, `--project` selects it explicitly, and `--user` selects per-user config.
`--print` emits the snippet and runs nothing, which is also the answer for a
client it does not know:

```sh
ub mcp install claude
ub mcp install codex --user
ub mcp install cursor --print
```

**It edits no config file.** Where the vendor ships its own installer —
`claude mcp add`, `codex mcp add` — that is what runs, because the vendor knows
its own file best, and the scope and any `--workspace` pin ride on the vendor's
own flags (`-e KEY=value`, `--env KEY=VALUE`). Codex has no scope flag: which
file it writes is the configuration directory it is handed, so project scope
points it at the project's `.codex`. Cursor, which ships no `mcp add`, gets
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
files are where API tokens live. The vendor is spawned without Uberblick's own
variables in its environment — no `HUB_*`, no `UBERBLICK_*`, no `WORKSPACE_ID` —
because it has no use for them and `ub` may be run with a secret exported;
the pin it does need rides in its argv.

The installed line is always `ub mcp serve`. Each new entry pins the complete
selected binding as `UB_WORKSPACE_ID` and `UB_HUB_URL`, including `local` for a
local-only workspace. Credentials stay in the private user store. With no
selection, installation fails rather than creating an entry that follows an
unrelated machine default.

```sh
ub mcp install claude --workspace research-<uuid> --hub https://hub.example.test
```

Terminal commands and MCP use the same [project binding](#configuration).
Explicit installer overrides require both `--workspace` and `--hub`.

Re-pinning an entry that already exists is not this command's job: an
entry pinned to another workspace is not the one it would register, so it is
reported and the snippet printed, and the change is made in the client's own
config or with the vendor's own command. A project moved to another corpus
does not silently redirect an agent's existing registration.

## A second workspace

After first-time setup, create a separate project workspace:

```sh
ub workspace create "Project notes"
ub open
```

Creation needs no hub or login. It generates a fresh UUID, stores the supplied
name, seeds the same starter documents and sidebar group as `ub init`, and
selects it in the current directory's `.uberblick.json`. An ancestor project's
binding, other workspaces, stored logins and existing MCP registrations are
unchanged. `ub init` remains first-time setup; in v0.4.0, creation alone does
not make the local signing secret that `ub open` needs to start a hub.

`ub workspace` prints its help. `ub workspace status` shows the selected workspace,
its source, replica storage and sync state. `ub workspace list`
lists local workspace databases. Select a recorded replica with its id or a
unique prefix; its hub comes from this machine's record:

```sh
ub workspace use <id-or-prefix>
```

For promotion to a hub, membership requirements, fetching a shared link and
verification guarantees, follow [REMOTE.md](REMOTE.md#create-and-promote-a-project-workspace).

A session can use several corpora through separately named MCP entries, on the
same or different hubs:

```sh
ub mcp install claude --workspace <first-uuid> --hub https://first.example.test --label product
ub mcp install claude --workspace <second-uuid> --hub https://second.example.test --label research
```

Each entry carries its own complete binding. Installing an existing name never
overwrites its configuration; use the vendor's management command to replace it.

## The `ub` command line

Homebrew installs both `ub` and `uberblick` on PATH. The user commands include:

```sh
ub init            # identity, workspace, signing secret
ub init <hub-url> --workspace <uuid>  # seed a workspace the stored login permits
ub update          # update the Homebrew installation
ub open            # serve the web app and a hub, and open the browser
ub status          # workspace, hub, account, connection, pending work, last sync, local log, failures
ub status --json   # full report, including rooms, configuration and storage paths
ub workspace       # print workspace help
ub workspace status  # selected workspace, its source, storage and sync state
ub workspace list  # workspaces this machine has a database for
ub workspace use <id-or-prefix>  # select a replica with its recorded hub
ub workspace create "Project notes"
ub workspace promote http://localhost:8080
ub workspace use <link>  # fetch, verify and bind a shared workspace; sign in first
ub mcp install claude  # register Uberblick with an MCP client
ub mcp serve       # the stdio entry point for an MCP client
```

Every question `ub init` asks has a flag (`--name`, `--color`, `--workspace`,
`--yes`), and a non-interactive stdin takes the defaults rather than blocking,
so it needs no TTY. Given a hub — `ub init hub.example.ts.net`, or the `wss://…`
endpoint in full — it initializes the selected workspace on that hub: it dials
and authenticates before writing anything, stores the endpoint, and the starter
documents are there by the time it returns. For remote authentication, workspace
access and switching an existing hub binding, see
[REMOTE.md](REMOTE.md#binding-a-computer-to-this-hubs-workspace).
`--mcp` ends by printing the snippet and destination that `ub mcp install --print`
prints; `--no-mcp` suppresses that hint. A bootstrap never registers a server
with somebody's agent on its own, even with a vendor CLI installed: running
`claude mcp add` is `ub mcp install`, asked for on purpose.

## Configuration

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
it does not configure an external upstream. Without that secret, sync is disabled
and status reports `hub.status: "disabled"`.
The JSON status keeps the internal transport endpoint separate from the selected
binding. The string `"local"` in a project file is rejected; use JSON null.
A hub address is normalized to its sync endpoint; a workspace ID can have a
display slug, but only its UUID identifies data. The file contains no credentials
and may be committed when its selection is appropriate for everyone using the
project. `ub status` shows the workspace, hub and selection source.
`ub init` and `ub workspace use` update the nearest project file, or create one
in the current directory.

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
from the private store. Remote login renewal, revocation and browser credential
isolation are described in [REMOTE.md](REMOTE.md#binding-a-computer-to-this-hubs-workspace).

## Where your files live

**One layout, on every platform**, resolved rather than configured, and nothing
in it for you to create: `ub init` makes the directories it needs. There is no
workspace directory to make — a workspace is a UUID, and its replica is a file
named after the bare UUID, so a display slug does not select another file.

| Where | What |
| --- | --- |
| `$XDG_CONFIG_HOME/uberblick/` — or `~/.config/uberblick/` | `config.json`, `credentials.json` and machine-local `workspaces.json` hub records |
| `$XDG_DATA_HOME/uberblick/` — or `~/.local/share/uberblick/` | `hub.sqlite` and `<uuid>.sqlite`, one per workspace |

Earlier builds stored agent workflows in `agent-projects/` and `agent-workflows/`
under those roots. Nothing reads them any more, and they are safe to delete.

The two variables are independent: each moves its own root and only that one,
so setting `XDG_CONFIG_HOME` alone leaves the databases under
`~/.local/share/uberblick`. A relative value is ignored, as the XDG spec
requires. Resolution cannot throw and no command has an opinion about which
layout is in force.

`ub status --json` carries a `storage` object with every resolved path — the
directories and database files, never the credential. `HUB_DB_PATH` and
`UBERBLICK_DB` name a database file outright and outrank those defaults.
A replica database records the workspace it holds: pointing `UBERBLICK_DB`
at another workspace's file makes the server exit non-zero naming both IDs and
the path, rather than merging two corpora into one index.
