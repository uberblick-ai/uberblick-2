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

What this supports is exactly one arrangement: **one workspace, one trusted user,
multiple clients and machines; no login and no tenant isolation.** Everything
below is a consequence of that.

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
  `ub init` writes 32 random bytes to
  `$XDG_CONFIG_HOME/uberblick/credentials.json` (mode 0600). That file is the
  authority. Because mise tasks and `.mcp.json` inherit their environment from
  mise rather than from `ub`, `ub init` also writes a gitignored
  `mise.local.toml` **derived** from it: same value, one owner, rewritten
  whenever the two drift, and restored with the same value if you delete it.

So the precedence a mise task sees, highest first: a decryptable fnox secret,
then the derived `mise.local.toml`, then `mise.toml`'s own `[env]`. Note that
mise's `[env]` overrides an exported shell variable, so once `mise.local.toml`
exists, `HUB_AUTH_TOKEN=… mise run hub` no longer overrides it — use `fnox`, or
edit that file. `ub` itself resolves the other way round, environment first; see
"The `ub` command line" below.

The secret is never printed — not by `ub init`, not by `ub status`, not by an
error path. The most any of them says is where it came from.

## Running things

mise tasks are the only supported entry points. Do not invoke `pnpm` directly —
the tasks pin the toolchain and wrap commands in `fnox exec` so secrets are
present.

```
mise run setup        # one-command bootstrap: toolchain, dependencies, `ub init`
mise run init         # just the `ub init` step, idempotent

mise run hub          # Hocuspocus sync hub
mise run mcp          # MCP server, standalone smoke test only (see below)
mise run web          # Vite dev server
mise run build-web    # production web bundle in packages/web/dist
mise run dev          # hub + web in parallel
mise run lint         # Biome lint across the workspace (no formatter)
mise run typecheck    # tsc --noEmit across all packages
mise run test         # all test suites
mise run e2e          # browser proof points (Playwright, Chromium, on demand)
REVIEW_SHA=<commit> mise run review  # immutable Docker review of one commit
```

To run the hub and built web client on a remote Tailscale host, follow
[REMOTE.md](REMOTE.md). The remote deployment uses Docker Compose and Caddy for
TLS, WebSocket proxying, and SPA fallback.

`mise run e2e` is the only task that drives a browser. It starts its own hub on
an ephemeral port with a throwaway signing secret and a temp database, and its
own Vite dev server on an ephemeral port, so it needs no fnox key and cannot
collide with a running `mise run dev`. It covers exactly what jsdom cannot —
two live clients converging on one block, a rendered remote cursor, and a reload
that comes out of the IndexedDB cache while the hub is down. Everything else
belongs in `mise run test`.

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

## The MCP server, as a client sees it

`ub mcp install [target]` wires uberblick into an MCP client, so nobody has to
hand-edit JSON. It knows `claude`, `codex` and `cursor`; `--project` writes the
current directory's config and `--user` the per-user one; `--print` emits the
snippet and writes nothing, which is also the answer for a client it does not
know:

```
ub mcp install claude --project     # this checkout's .mcp.json
ub mcp install codex --user         # ~/.codex/config.toml
ub mcp install cursor --print       # the snippet, on stdout
```

Where the vendor ships its own installer — `claude mcp add`, `codex mcp add` for
its global config — that is what runs, because the vendor knows its own file
best; otherwise the documented config file is edited directly. The report names
which of the two happened. Either way the command reads the file first, so an
unrelated server in it is left alone — byte for byte, since both formats are
spliced as text rather than reparsed and re-emitted — a second run is a no-op
that says "already installed", and an `uberblick` entry it did not write is
reported next to what would replace it and left in place unless `--force` says
otherwise. A file it changes is copied to a timestamped `.bak` beside it first,
and it is read and written through one descriptor so the copy cannot be of a
version that has already been replaced. Nothing prompts, so the whole command
runs unattended.

Reports name files, never their contents: a conflicting entry is shown with its
command and the *names* of anything else it sets, with the values masked, and a
file that will not parse is reported by path alone. Config files are where API
tokens live.

The installed line is always `ub mcp serve`, with no arguments and no
environment. Which workspace, which hub and which credential apply is resolved
by `ub` — a client config that pinned any of them would be a second copy of
configuration that already has an owner.

**This checkout is the exception, and `.mcp.json` records it.** A fresh clone has
no installed `ub` on its PATH, and the owner's real secret only becomes visible
through `fnox exec`, so the committed `.mcp.json` registers a spawn that runs the
server out of the checkout instead — through mise, wrapped in `fnox exec`, with
the package manager's own output silenced. The exact spawn is config, and
`.mcp.json` is where it lives; read it there rather than copying it into a shell.

It is still generated rather than hand-maintained: everything after `--` replaces
the command `ub mcp install` registers, so regenerating the file means passing
that recorded spawn back to `ub mcp install claude --project --force -- …`. A
test asserts that the committed file is exactly what doing so produces.

What that spawn is careful about, since none of it is obvious:

- Secrets come from `fnox exec`, which supplies `HUB_AUTH_TOKEN`. A missing key
  is a warning, not an error, on purpose: a contributor without the age key still
  gets a working server — offline-first, with `sync_status` reporting `disabled`.
- Package-manager lifecycle output is suppressed. stdout is the JSON-RPC
  transport, so a banner on it would corrupt the session.
- `HUB_URL` is left unset, so the server falls back to `ws://localhost:1234` —
  the same default mise's `[env]` carries. No hub address is pinned here.

For a standalone smoke test, `mise run mcp` runs the same thing in the
foreground.

`mise run import-seed` is the one-time import of `docs-seed/` into the system.
After it, the product docs live in the documents, and are read and written
through the MCP tools rather than by editing the seed files.

## The `ub` command line

`ub` is what a *user* of uberblick runs. The contributor verbs — dev, lint,
typecheck, test, e2e, review — stay mise tasks and are deliberately not
duplicated there. Distribution comes later, so until then run it out of the
checkout:

```
node packages/cli/bin/ub.mjs init            # identity, workspace, signing secret
node packages/cli/bin/ub.mjs status          # workspace, hub, credential, sync state
node packages/cli/bin/ub.mjs status --json   # the same, as one JSON object
node packages/cli/bin/ub.mjs remote          # the endpoint in force, and what sharing it buys
node packages/cli/bin/ub.mjs mcp install     # register uberblick with an MCP client
node packages/cli/bin/ub.mjs mcp serve       # the stdio entry point for an MCP client
```

Inside a checkout prefer `mise run init` over calling `ub init` directly: the
task wraps it in `fnox exec`, which is how a decryptable secret becomes visible
to it in the first place. Every question `ub init` asks has a flag (`--name`,
`--color`, `--workspace`, `--yes`), and a non-interactive stdin takes the
defaults rather than blocking, so it needs no TTY. `--mcp` runs `ub mcp install`
with its defaults when `ub init` finishes, and `--no-mcp` says not to mention it;
a refusal there is a warning rather than a failed bootstrap, because everything
`ub init` was asked to settle has been settled by then.

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
| environment (`WORKSPACE_ID`, `HUB_URL`, `HUB_AUTH_TOKEN`) | wins, so `HUB_URL=… ub mcp serve` keeps working |
| `./uberblick.json` | binds one checkout to one workspace. Committable, so never secrets — and never the hub the stored secret is sent to |
| `$XDG_CONFIG_HOME/uberblick/config.json` | per-user identity (display name, cursor colour), the workspace and the hub endpoint — what `ub init` writes |
| `$XDG_CONFIG_HOME/uberblick/credentials.json`, mode 0600 | the hub signing secret. Never printed by any command, and refused outright — not merely warned about — if anyone but its owner can read it |
| built-in defaults | hub `ws://localhost:1234`. No workspace: there is no default one |

The stored signing secret is scoped to hubs *you* chose: if the hub URL in force
came from a committable `./uberblick.json`, the secret in `credentials.json` is
not attached to it and `ub` says so — a clone must not be able to point your
credential at its author's endpoint. Exporting `HUB_AUTH_TOKEN`, or setting
`HUB_URL` yourself, is the explicit opt-in and always applies.

### Going remote: local first, then a hub, then a second computer

The normal journey is local first and remote later, and `ub remote` is the part
that keeps a corpus from being left behind when the endpoint changes. Documents
a browser created live only in the local hub until an MCP session pulls them
down, so simply changing `HUB_URL` strands them.

**On the remote host** — a Linux box in your tailnet — bring the hub and the web
client up from a plain checkout, as [REMOTE.md](REMOTE.md) describes. That host
runs `sh remote-compose.sh up --build --detach` and nothing else; every command
below runs on one of *your* computers, not there. The hub it starts is empty.

**On the computer that already has your documents**, with `mise run hub` still
running so the browser-created ones can be collected:

```
node packages/cli/bin/ub.mjs remote promote wss://<host>.ts.net/ws
```

That reads the whole local workspace through the local hub into the update log,
looks at the target with a throwaway client that writes nothing, uploads, and
then opens the target *again* as a fresh client and compares what it finds with
what you hold — in both directions, tombstones included, and by content rather
than by name. Only if that matches is the endpoint persisted. "Verified" here
means the hub acknowledged the writes and a fresh client read them back; it does
not mean the hub has flushed them to disk.

It refuses if the local hub is not running, because documents a browser made
live only there until an MCP session pulls them down. It refuses if the target
accepted the connection but never finished serving its directory — what such a
hub holds is unknown, which is not the same as holding nothing. And it refuses
without writing anything if the target holds documents this workspace has never
heard of, naming both counts. A shared uuid is not that: it is one document's
lineage on two hubs, which Yjs merges, so rerunning finishes an interrupted
promotion rather than colliding with it.

**On a second computer**, from a fresh clone with nothing in its workspace:

```
mise trust && mise run setup -- --yes --workspace <workspace id>
node packages/cli/bin/ub.mjs remote join wss://<host>.ts.net/ws \
  --secret-file ~/uberblick-remote-secret
mise run web            # the web client alone; the hub is the remote one
```

The workspace id is the one the first machine's `ub status` prints, decorated or
bare. Give it: a workspace id is a uuid and `ub init` with none in force
generates a *new* one, so a machine that invented its own would join the remote
hub and find nothing of yours on it — the rooms are keyed by a different id.

`ub init` writes configuration and imports no documents, so a fresh checkout's
workspace really is empty and `join` has nothing to duplicate — do not run
`mise run import-seed` there, the product documents arrive over the wire. `join`
hydrates the full remote directory and every live document into the local update
log, verifies it by the same read-back, and only then persists the endpoint. An
unreachable or auth-rejecting remote leaves your configuration exactly as it
was. It refuses a local workspace holding documents the remote has never heard
of, naming both counts.

Unlike `promote`, `join` does **not** require a local hub — a second computer
has none. It says so instead, and says the part that matters: the check that
decides whether this workspace is empty could then see only the update log. A
checkout whose documents only ever reached a local hub that is switched off
reads as empty from here, so `join` would accept it, pull down the remote corpus
and repoint every client away from the hub holding its work. If this machine has
a local hub with documents on it, start it and rerun instead.

The secret that reached the remote replaces whatever `ub init` generated here,
in `credentials.json` at mode 0600, and the command says it is doing so. That is
the whole point on a second machine: `ub init` invents a *random* secret, and
the remote verifies with the first machine's.

**What "persisted" covers, and what outranks it.** The endpoint goes into
`$XDG_CONFIG_HOME/uberblick/config.json`, which is where `ub`, `ub mcp serve`
and the MCP server it spawns resolve it. That file is the *third* layer:
`HUB_URL` in the environment beats it, and so does a `hubUrl` in a committable
`./uberblick.json`. When either does, these commands say which one wins rather
than reporting a switch that did not happen — `ub remote set` exits non-zero,
and after a bridge the report says the documents moved but names the endpoint
still in force. Writing the higher layer instead is not the fix: `./uberblick.json`
is committable, and the stored signing secret is deliberately withheld from a
repository-chosen hub, so clients pointed there would dial it with no credential
at all.

A deployed web client does not read any of these: it resolves its endpoint at
runtime from the served `/uberblick-config.json`. A checkout's `mise run web`
still takes `HUB_URL` from mise's environment, so point a development build at a
remote hub with `HUB_URL=… mise run web`.

Archived documents travel as directory state — a tombstone replicates and stays
a tombstone — but their content is not moved: "every live document" is what a
bridge is for.

The remote's signing secret comes from `--secret-file <path>` (a file only you
can read, mode 0600 — a `credentials.json` works, or the bare secret) or from a
hidden prompt when the configured one is refused and there is a terminal to ask.
Never as an argument: a command line is in every `ps` listing and every shell
history. Neither the secret nor a token signed with it is printed by any of
these commands.

`ub remote set <url>` is the third verb, and it moves nothing — the right one
only when there is nothing to move. `ub remote` with no remote configured says
so and exits 0; with one, it prints the endpoint and states the boundary you
actually get: the served web bundle carries the shared signing secret, so
reaching the app is the same as holding the credential, and the deployment is
supported only on a private network until accounts land (#84). There is no
`invite` command (#92) for that reason.

`ub mcp serve` resolves that configuration and runs the MCP server with it, so
the server keeps its environment-only contract — no flags, no config file — and
a client's spawn line never has to change again when internals move. This
checkout's `.mcp.json` is the one place that still names a spawn of its own,
for the reasons given above, and `ub mcp install` generates it.

## Review isolation

`mise run review` resolves `REVIEW_SHA` to a commit, extracts that commit with
`git archive` into a temporary directory, builds it with the `Dockerfile.review`
of freshly fetched `origin/main`, and runs the lint, typecheck, and test gates
in a disposable container. The build context is exactly this: every committed
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
preceding inspection ceremony: `REVIEW_SHA=<commit> mise run review`. It is not
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
`REVIEW_SHA=<commit> mise run review` — nothing builds a branch automatically
and no CI job builds one on push. The standing rule bounds the blast radius:
never pass build secrets, host mounts, privileged mode, or the Docker socket,
so a hostile build has no credentials of ours to exfiltrate.

## Toolchain choices

**Node 26** (`engines.node: ">=26"`, `mise` `node = "26"`). One runtime version
across the repo; it gives us stable native `fetch`/WebStreams, and `tsx` is the
only TypeScript loader we need.

**SQLite: `node:sqlite` in the MCP server, better-sqlite3 under the hub.** The
MCP server's local mirror uses Node's built-in `node:sqlite` — same file format,
same synchronous API shape, nothing to compile at install time. The hub reaches
SQLite through `@hocuspocus/extension-sqlite`, which brings better-sqlite3 with
it, so the native module is still in the tree (pinned to `^12`: that is the line
publishing prebuilt binaries for Node 26's ABI, and older majors fall back to
compiling from source, which needs a C++ toolchain on every machine and in CI).
pnpm 10 blocks install scripts by default, so `better-sqlite3` (and `esbuild`)
are listed under `onlyBuiltDependencies` in `pnpm-workspace.yaml`; bumping the
major means re-checking that prebuilds exist for the Node we pin.

**One copy of yjs.** `yjs`, `y-protocols` and `y-prosemirror` keep module-level
state and use `instanceof` across the doc boundary, so a duplicate silently
corrupts documents. They are pinned to one exact version each via the
`catalog:` entries **and** `overrides` in `pnpm-workspace.yaml`, and `yjs` is a
`peerDependency` of `@uberblick/schema` (never a hard dependency) so the app
package owns the instance. Check with `mise exec -- pnpm why yjs`.

## Secrets

Secrets live in `fnox.toml`, age-encrypted and safe to commit. The private key
is expected at `~/.config/fnox/age.txt` and never in the repo. Only real
secrets go there: plaintext local defaults such as `HUB_URL`
(`ws://localhost:1234`) live in `mise.toml`'s `[env]` block.

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
`UBERBLICK_DB` (default `$XDG_DATA_HOME/uberblick/<workspaceUuid>.sqlite`, keyed
by the bare uuid so both spellings of a workspace hydrate one file).
