# Remote deployment over Tailscale

This deployment runs one hub and one prebuilt web client on a Linux host that
is already in a private Tailscale network. Caddy serves the single-page app,
serves the client's runtime configuration at `/uberblick-config.json`, proxies
`/ws` to the hub, and asks the host's Tailscale daemon for the HTTPS
certificate. The hub is not published directly.

> the served bundle contains the shared write-token signing secret — this deployment is supported only on a private Tailscale network until server-minted sessions exist; an unguessable public hostname is not a security boundary.

Server-minted sessions are the planned replacement; see
[Hosted future](CLAUDE.md#hosted-future-directional--shapes-cheap-now-choices-only).

## Host prerequisites

- A Linux host with Docker Engine and Docker Compose 2.6.0 or newer —
  `ub remote init` clones the repository onto it, and only the by-hand procedure
  below needs a checkout you made yourself. Compose 5 also satisfies this
  requirement; check with `docker compose version --short`. Compose 2.5 added
  build secrets, and 2.6 is the minimum that also supports the
  environment-backed secret source and top-level project name used here.
- Tailscale installed on the host and connected to the private tailnet. MagicDNS
  and HTTPS must be enabled for the tailnet. Enabling HTTPS publishes the
  machine names used in certificates to a public certificate transparency log;
  Tailscale documents that tradeoff in
  [Enabling HTTPS](https://tailscale.com/docs/how-to/set-up-https-certificates).
- TCP port 443 free on the host's Tailscale IPv4 address.
- `git` on the host, and SSH access to it (Tailscale SSH is enough).
- For the update timer: lingering enabled for the SSH user
  (`loginctl enable-linger <user>`), or passwordless `sudo` so `ub remote init`
  can enable it. Without either, init refuses before it clones anything —
  `--no-auto-update` installs the stack without the timer.

`ub remote init` runs from your own machine, which must itself be on the tailnet
(it is what verifies the deployment afterwards) and must hold a GitHub login with
admin rights on this repository and a `repo`-scoped token, so it can register the
host's deploy key while the repository is private (`gh auth login --scopes repo`).

Caddy supports Tailscale certificates without an ACME challenge when it can
reach the local Tailscale daemon. The compose file bind-mounts the standard
`/var/run/tailscale/tailscaled.sock` and runs Caddy as root inside its container,
which is one of the access modes documented by
[Caddy certificates on Tailscale](https://tailscale.com/docs/integrations/web-servers/caddy/caddy-certificates).

## Stand it up

One command, from your own machine — the one that already holds the signing
secret, SSH access to the host and a GitHub login:

```sh
ub remote init uberblick@box.tailnet.ts.net
```

It does, over that one SSH target, what the rest of this document describes by
hand:

1. Checks the host — Docker Compose 2.6+, `git`, and `tailscale status --json`
   for the MagicDNS name and `tailscale ip -4` for the address. Detection
   failing is a prompt or `--host <fqdn> --ip <v4>`, never a guess, and it says
   which of the three it was: tailscale absent, tailscaled not up, or the local
   API refused because the SSH user is not the tailscale operator (fixed on the
   host with `tailscale set --operator=<user>`).
2. Generates an ed25519 deploy key **on the host** — it never leaves it — and
   registers its public half read-only with `gh repo deploy-key add`, titled
   `uberblick-<hostname>-<short-fingerprint>`. A key already registered is
   detected by the key itself, never by its title, so a second run adds nothing.
3. Clones `main` into `~/uberblick-remote` (`--dir` to change) with
   `core.sshCommand` set on the clone, so the updater needs no environment of
   its own. An existing checkout is fast-forwarded instead.
4. Writes the host's `.env` — `TAILSCALE_HOST`, `TAILSCALE_IP` and
   `HUB_AUTH_TOKEN` from your local signing secret — **over stdin**. The secret
   is never an argument on either side, never echoed, and never reaches a shell
   history.
5. Runs `sh remote-compose.sh up --build --detach`, then verifies from your
   machine: it polls `https://<host>/` for up to 90 seconds — the first request
   is what makes Tailscale issue the certificate, so an immediate check is a
   false negative — and confirms `/ws` upgrades to a WebSocket. A failure exits
   non-zero with the last hub and Caddy log lines, and persists nothing.
6. Installs a systemd **user** timer, `uberblick-update.timer`, which runs
   `remote-update.sh` from the checkout every five minutes.
7. Prints the URL. If this workspace holds no documents it points your clients
   at the new hub (`ub remote set`); if it holds documents it switches nothing
   and prints the `ub remote promote` command instead.

Every step is idempotent: re-running `ub remote init` against a host it already
stood up adds no second deploy key, re-clones nothing, and leaves the timer as
it is.

### The host tracks `main` itself

Nothing is deployed *from* your checkout. The host fetches `origin/main` every
five minutes and, when it differs from the last **successfully deployed**
commit, resets to it and rebuilds — `remote-update.sh`, versioned in this
repository next to `remote-compose.sh`, so the updater updates itself.

**Anyone who can merge to `main` can execute code on this host within five
minutes.** That is the accepted tradeoff for a host whose whole purpose is to
follow `main`, and it is why `--no-auto-update` exists: it installs the stack
with no timer, and

```sh
ub remote update uberblick@box.tailnet.ts.net
```

then deploys on demand, reporting either "up to date" or the commit it moved to.
It runs that same script on the host, so the two can never drift apart, and a
`flock` outside the checkout keeps an on-demand run from colliding with a timer
tick.

The updater compares against `refs/uberblick/deployed`, which moves only after a
build exits 0 — never against `HEAD`. A commit whose build fails is therefore
retried on the next tick rather than remembered as deployed, which is what keeps
one bad commit from wedging the host with its containers on the old code.
`git reset --hard` discards host-local edits to **tracked** files, deliberately —
the host mirrors `main` and is not a place to edit — and prints what it
discarded. The host's `.env` is untracked and survives; nothing runs `git clean`.

## What the command does, by hand

The manual procedure, kept as the reference for what `ub remote init` automates
and for repairing a host by hand. From the repository checkout on the remote
host:

```sh
cp remote.env.example .env
tailscale ip -4
```

Edit `.env` and set the three required values (`WEB_HUB_URL` is optional; see
[Pointing the client at another hub](#pointing-the-client-at-another-hub)):

- `TAILSCALE_HOST` is the host's full `*.ts.net` MagicDNS name, with no scheme
  or trailing slash.
- `TAILSCALE_IP` is the IPv4 address printed by `tailscale ip -4`. Compose binds
  port 443 only to this address, not to the host's public or LAN interfaces.
- `HUB_AUTH_TOKEN` is the existing shared signing secret used by the local MCP
  clients that will sync to this hub. On a trusted machine with the repository's
  age key, `fnox get HUB_AUTH_TOKEN` prints that value so it can be transferred
  to the host's ignored `.env`. Never copy the age key to the host. The secret
  must consist only of letters, digits, `.`, `_`, and `-`; `remote-compose.sh`
  refuses other characters because the shell and Compose parse `.env`
  differently.

The wrapper reads `.env`, derives a SHA-256 cache key from `HUB_AUTH_TOKEN`
without printing or passing the token as a Docker build argument, then invokes
Compose. Always use it for this deployment: BuildKit deliberately excludes
secret contents from cache keys, so the derived non-secret build argument is
what forces a web rebuild after token rotation.

Validate the configuration without rendering its secret values, build the web
bundle, and start both services:

```sh
sh remote-compose.sh config --quiet
sh remote-compose.sh up --build --detach
sh remote-compose.sh ps
sh remote-compose.sh logs --tail=100 hub caddy
```

Open `https://<TAILSCALE_HOST>` from a second computer on the same tailnet. In
the browser developer tools, `https://<TAILSCALE_HOST>/uberblick-config.json`
must return `{"hubUrl":"wss://<TAILSCALE_HOST>/ws"}` and the collaboration
WebSocket must be that same address; a `ws://localhost` request means the
document did not arrive and the client fell back to the value compiled into the
bundle. The directory should hydrate after the socket connects.

Do not run `docker compose config` without `--quiet`: the rendered
configuration contains `HUB_AUTH_TOKEN` in the hub environment.

### Pointing the client at another hub

The hub endpoint is **not** baked into the bundle. The client fetches
`/uberblick-config.json` from the origin it was served from and takes `hubUrl`
from it; the compiled-in value is only the fallback for when no such document
is deployed. Caddy renders that document from the `HUB_URL` it is given, which
`docker-compose.yml` fills from `WEB_HUB_URL` in `.env`, defaulting to
`wss://<TAILSCALE_HOST>/ws`.

So retargeting the client is an edit to that document, not a rebuild — set
`WEB_HUB_URL` in `.env` and recreate the Caddy container:

```sh
sh remote-compose.sh up --detach caddy
```

The document is served with `Cache-Control: no-store`, so the next page load
picks up the change. It carries the endpoint and nothing else: the client reads
`hubUrl` and ignores every other key, so there is no field a token could be
added to. `hubUrl` must be a plain `ws://` or `wss://` address — one carrying
userinfo, a query string or a fragment is refused, and the client falls back to
the endpoint compiled into the bundle rather than dialling it.

`HUB_AUTH_TOKEN` is still compiled into the bundle, so rotating it does need
`sh remote-compose.sh up --build --detach`. Removing it from the bundle
entirely is separate work (#84).

## Two-computer verification protocol

Use computers A and B on the same tailnet. Before starting, open the remote URL
on both, choose the same document, and give each browser a distinct awareness
name/color if prompted.

1. **Live edit and cursor:** type a distinctive sentence on A. Confirm it
   appears on B without reloading and that B renders A's remote cursor or
   selection.
2. **Local MCP to remote browser:** on the computer that launches the MCP
   client, export `HUB_URL=wss://<TAILSCALE_HOST>/ws` before launching that
   client. Its configured `HUB_AUTH_TOKEN` must equal the value in the remote
   `.env`. Use `edit_block` on the open document and confirm the edit appears
   live on B. `sync_status` must report the remote URL and a connected hub.
3. **Offline convergence:** disconnect A from the network, then edit the same
   document on A and B (use different blocks for an unambiguous merge). Restore
   A's network. Confirm both browsers converge to the same text and neither
   edit disappears.
4. **Hub restart durability:** make one more edit and wait until it appears on
   both computers. On the host run `sh remote-compose.sh restart hub`, then
   reload B. Confirm the document and the last edit remain.
5. **Named-volume durability:** record a distinctive document title, then run
   `sh remote-compose.sh down` followed by
   `sh remote-compose.sh up --detach`. Reload B and confirm the title remains
   and the directory hydrates. Do not pass `--volumes` to `down`; that flag
   intentionally deletes the named SQLite volume.

Record the host name, date, browser/OS pairs, and pass/fail result for every
step in issue #98. The physical two-computer checks are deployment evidence;
they are not replaced by the repository's local test suite.

## Operations

```sh
sh remote-compose.sh logs --follow hub caddy
sh remote-compose.sh restart hub
sh remote-compose.sh down
sh remote-compose.sh up --detach
```

The update timer is a systemd user unit on the host:

```sh
systemctl --user status uberblick-update.timer
journalctl --user -u uberblick-update.service --since -1h
systemctl --user disable --now uberblick-update.timer
```

The hub handles Compose's `SIGTERM` by flushing pending document updates before
it exits. SQLite is `/data/hub.sqlite` in the `hub-data` named volume, so normal
container replacement and `sh remote-compose.sh down` preserve it. Backups are a
separate follow-up (#85).

## Moving an existing local workspace onto this hub

The hub this deployment starts is empty. `ub remote` moves a workspace onto it,
and onto a second computer afterwards. Which process runs where matters:
everything in this section runs on **your** computers, not on the remote host,
which only ever runs `sh remote-compose.sh`.

On the computer that holds the documents, with the local hub still running —
`mise run hub` — because documents a browser created live only there until an
MCP session has pulled them down:

```sh
ub remote promote wss://<TAILSCALE_HOST>/ws
```

It hydrates the local directory and every live document into the update log,
reads the target with a throwaway client that writes nothing, uploads, then
opens the target again as a fresh client and compares what it finds against what
you hold — in both directions, tombstones included, and by content rather than
by name. The endpoint is rewritten only after that comparison succeeds, so a
failed or partial run leaves you pointed at the hub that still works. Rerunning
finishes an interrupted run: a shared uuid is one document's lineage on two
hubs, which Yjs merges.

It exits non-zero without writing anything if the local hub is unreachable, if
the target accepted the connection but never finished serving its directory (a
hub whose contents are unknown is not an empty hub), or if the target holds
documents this workspace has never heard of.

On a second computer, from a fresh clone:

```sh
mise trust && mise run setup -- --yes --workspace <WORKSPACE_ID>
ub remote join wss://<TAILSCALE_HOST>/ws \
  --secret-file ~/uberblick-remote-secret
mise run web
```

`<WORKSPACE_ID>` is the workspace this second machine is joining — the value the
first machine's `ub status` prints. It has to be given, because a workspace id
is a uuid and `ub init` with none in force generates a *new* one: a machine that
invented its own workspace would join a hub and find nothing of yours there, the
rooms being keyed by a different id. Either spelling works, decorated or bare.

`ub init` imports no documents, so that workspace is empty and there is nothing
to duplicate — do not run `mise run import-seed` on it. `join` pulls the whole
remote directory and every live document into the local update log, verifies it
the same way, and only then persists the endpoint; `mise run web` then starts the
web client alone, against the remote hub. An unreachable or auth-rejecting
remote writes nothing at all.

Unlike `promote`, `join` does not require a local hub — a second computer has
none. It says so, and says that the check deciding whether this workspace is
empty could therefore see only the update log: a checkout whose documents only
ever reached a local hub that is switched off reads as empty, joins anyway, and
leaves that work on a hub nothing points at any more. If this machine has one,
start it and rerun instead.

The secret that reached the remote replaces whatever `ub init` generated on this
machine, at mode 0600, and the command says so — on a second machine that is the
point, since `ub init` invents a random secret and the remote verifies with the
first machine's.

Persisting the endpoint writes `$XDG_CONFIG_HOME/uberblick/config.json`, which
is where `ub`, `ub mcp serve` and the MCP server it spawns resolve it. `HUB_URL`
in the environment and a `hubUrl` in a committable `./uberblick.json` both
outrank that file; when either does, these commands name the one that wins
instead of claiming a switch that did not take effect. The deployed web client
here reads its endpoint at runtime from the served `/uberblick-config.json`, not
from any of them.

The `--secret-file` argument is a path, never the secret: it must be a file only
you can read (mode 0600), holding either the bare value from the host's `.env`
or a `credentials.json` carrying it. Without the flag, the secret already
configured is tried first and a terminal is prompted with the input hidden.
Nothing here prints the secret or a token signed with it.

Archived documents replicate as directory state and stay archived; their content
is not moved. Merging two independently populated workspaces is not supported —
both bridges refuse it explicitly, naming both document counts.
