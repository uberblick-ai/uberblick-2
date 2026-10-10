# Uberblick user guide

Start with the [README](README.md) to install Uberblick and open your first local
workspace. This reference follows current repository code, which can be ahead
of the latest Homebrew release. Use `ub <command> --help` for the options in your
installed version.

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
its own file best, and the scope rides on the vendor's own flags. Codex has no
scope flag: which file it writes is the configuration directory it is handed,
so project scope points it at the project's `.codex`. Cursor, which ships no `mcp add`, gets
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
variables in its environment — no `HUB_*`, no `UBERBLICK_*`, no `WORKSPACE_ID`,
no `UB_WORKSPACE_ID` or `UB_HUB_URL` — because it has no use for them and `ub` may be run with a secret
exported.

The entry is always named `uberblick` and runs `ub mcp serve` with no `env`.
Install needs no workspace selection and never creates or changes
`.uberblick.json`. Project scope registers in the current directory, even when
the project's binding is in a parent directory. With no valid project binding,
it registers normally and warns that agents cannot start until you run
`ub workspace create <name>` or `ub workspace use <link|id>`. `--user` works
anywhere and follows each project's nearest `.uberblick.json`.

Terminal commands and MCP use the same [project binding](#configuration). The
report names the client command that ran, its target file and the binding path
the entry follows. Restart running agents after registration or a binding
change; they keep the workspace selected when they started. An already plain
entry is reported as already installed and runs no client command. An existing
`uberblick` entry with environment overrides or a different command is left
byte-for-byte unchanged, and install prints the plain entry with exit 1. Change
such an entry through the client's own config or management command.

## A second workspace

After first-time setup, create a separate project workspace:

```sh
ub workspace create "Project notes"
ub open
```

Creation needs no hub or login. It generates a fresh UUID, stores the supplied
name, seeds the starter documents and sidebar group, and selects it in the
current directory's `.uberblick.json` only after the seed succeeds. It also
creates an owner-only local signing secret when none is already supplied, so
agents started before `ub open` can sync with the hub it later starts. An
ancestor project's binding, other workspaces, stored logins and existing MCP
registrations are unchanged. A failed create leaves the previous binding
unchanged; re-running makes a complete new workspace and leaves any partial
replica alone.

`ub workspace` prints its help. `ub workspace status` shows the selected workspace,
its source, replica storage and sync state. `ub workspace list`
lists local workspace databases. Select a recorded replica with its id or a
unique prefix; its hub comes from this machine's record:

```sh
ub workspace use <id-or-prefix>
```

For promotion to a hub, membership requirements, fetching a shared link and
verification guarantees, follow [REMOTE.md](REMOTE.md#create-and-promote-a-project-workspace).

A session can use several corpora through separately named MCP entries written
in the client's own config. For example, a JSON client can follow the project
binding with `uberblick` and select another workspace with `research`:

```json
{
  "mcpServers": {
    "uberblick": { "command": "ub", "args": ["mcp", "serve"] },
    "research": {
      "command": "ub",
      "args": ["mcp", "serve"],
      "env": {
        "UB_WORKSPACE_ID": "11111111-1111-4111-8111-111111111111",
        "UB_HUB_URL": "https://research.example.test"
      }
    }
  }
}
```

`UB_WORKSPACE_ID` overrides the project binding for that entry only. It can stand
alone when this machine has a hub record for that workspace; otherwise add
`UB_HUB_URL`, or `local` for local-only use. Install leaves other named entries
untouched and never overwrites an existing `uberblick` configuration.

## The `ub` command line

Homebrew installs both `ub` and `uberblick` on PATH. The user commands include:

```sh
ub auth login      # sign in to the project's hub
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

No CLI command asks for a display name or colour. Creating or selecting a
workspace leaves existing presence settings alone. To join a workspace whose
binding is already committed, run `ub auth login`; to join one shared as a
link, sign in and run `ub workspace use <link>`. For remote authentication,
workspace access and switching an existing hub binding, see
[REMOTE.md](REMOTE.md#binding-a-computer-to-this-hubs-workspace).
Registering an agent remains an explicit `ub mcp install` step.

## Configuration

Workspace selection is explicit and atomic: workspace ID plus hub URL. Terminal
commands, `ub open`, `ub mcp serve` and checkout development tasks use one resolver:

1. `UB_WORKSPACE_ID` in the environment overrides the project binding and uses
   this machine's recorded hub for that workspace. Add `UB_HUB_URL` for an
   explicit hub, or `local` for local-only use; it is required until this machine
   has a record. A hub URL alone, or a blank or invalid value, is an error;
   values are never borrowed from the project file. These variables work with
   mise, direnv and per-entry MCP environments.
2. Otherwise, search from the current directory up to the filesystem root for
   the nearest `.uberblick.json`. An invalid nearest file fails; it never falls
   through to a parent. A file in a common ancestor intentionally covers its
   descendants, including a file placed in your home directory. To give a
   repository its own selection beneath an ancestor binding, create a closer
   `.uberblick.json` there explicitly; selection commands update the nearest file.
3. Without either, `ub status` reports **No workspace selected** without opening
   a database. Workspace-dependent commands refuse until a binding is chosen.

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
`ub workspace use` updates the nearest project file, or creates one in the
current directory. `ub workspace create` always writes in the current directory,
leaving an ancestor binding alone.

**Migration:** legacy `WORKSPACE_ID` / `HUB_URL` inputs and workspace/endpoint
fields in the user's `config.json` no longer select a workspace. Legacy environment
selectors without a valid new override are refused, even when a project file
exists, so an old named MCP pin cannot silently open another corpus. Existing
credentials, identity and document databases remain untouched. Add an explicit
project file with the existing workspace and hub, or use the environment override
described above. Existing MCP entries can follow the project binding by removing
their selectors, or select a separate workspace through the supported per-entry
override. Installation reports conflicting entries without overwriting them.
Before removing old settings, run `ub workspace use <workspace-id> --hub <hub-url|local>`
once. It preserves the old endpoint's device-admission mode in private,
endpoint-keyed metadata, including when the new project uses a different hub.
After giving existing projects their bindings, finish migration by removing only
the obsolete `workspace` and `hubUrl` keys from
`$XDG_CONFIG_HOME/uberblick/config.json` (normally
`~/.config/uberblick/config.json`). Keep other fields, `credentials.json`, project
files and databases. New unbound directories can then use `ub workspace create <name>` to create a
fresh workspace, including starter documents; existing project bindings remain.
Temporary environment overrides are never implicitly saved by setup commands.

The private `credentials.json` remains owner-only and holds local development
signing secrets plus separate device logins keyed by hub origin. No credential
belongs in a project file or MCP entry. `HUB_AUTH_TOKEN` still overrides the
stored local development signing secret; remote sync resolves its saved login
from the private store. Remote login renewal, revocation and browser credential
isolation are described in [REMOTE.md](REMOTE.md#binding-a-computer-to-this-hubs-workspace).

`ub open` creates a missing signing secret only for a local workspace whose hub
it starts here. A remote hub, including a device-authenticated hub on localhost,
needs no local secret. Neither command replaces a secret already on file or
supplied through `HUB_AUTH_TOKEN`. A credentials file readable by others is
refused because its secret may have leaked: delete the file, run `ub open` to
make a new one, then restart running agents. If the file held hub logins, sign
in again with `ub auth login`. `ub workspace create` still creates its workspace
in this state, but makes no secret. Neither command changes the exposed file's
permissions or contents.

## Where your files live

**One layout, on every platform**, resolved rather than configured, and nothing
in it for you to create: `ub workspace create` makes the directories it needs. There is no
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
