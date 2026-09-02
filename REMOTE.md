# Remote deployment over Tailscale

This deployment runs one hub and one prebuilt web client on a Linux host that
is already in a private Tailscale network. Caddy serves the single-page app,
serves the client's runtime configuration at `/uberblick-config.json`, proxies
`/ws` to the hub, and asks the host's Tailscale daemon for the HTTPS
certificate. The hub is not published directly.

> the host serves the shared write-token signing secret to the app, in `/uberblick-config.json` — anyone who can fetch that document has full read-write. This deployment is supported only on a private Tailscale network until server-minted sessions exist; an unguessable public hostname is not a security boundary.

Server-minted sessions are the planned replacement; see
[Hosted future](CLAUDE.md#hosted-future-directional--shapes-cheap-now-choices-only).

## Host prerequisites

`ub remote init` probes most of this over SSH before it changes anything on the
host, and refuses naming the piece that is missing rather than guessing. Two
entries are marked **not probed** — check those yourself, with the commands
given, before you deploy.

- **SSH access to the host**, as the user the target names
  (`uberblick@box.tailnet.ts.net`). Tailscale SSH is enough. The same access is
  how the host is updated later, since nothing on it updates itself.
- **That user able to reach the Docker socket** — *not probed*. What the probe
  runs, `docker compose version --short`, asks the CLI plugin its own version
  and never contacts the daemon, so a user outside the host's `docker` group
  passes it and then fails at the first command that does any work. Check it by
  hand with something that changes nothing:

  ```sh
  ssh uberblick@box.tailnet.ts.net docker info
  ```

  A permission error on `/var/run/docker.sock` is fixed on the host by adding
  the user to the `docker` group (and opening a new session).
- **Docker Engine, with Docker Compose 2.6.0 or newer.** Compose 5 satisfies it
  too; `docker compose version --short` is what both the probe and
  `remote-compose.sh` read. The build secrets and the environment-backed secret
  source that first set this floor are gone with #426; what the compose file
  still uses beyond long-standing Compose v2 features is the top-level project
  `name`. The floor stays at 2.6 because that is the oldest version this
  deployment has been verified on, not because a lower one is known to fail.
- **`git`.** `ub remote init` clones this repository onto the host and
  `ub remote update` fetches into that checkout: the deployment is *built there,
  from source*, so the host always holds a checkout and there is no registry and
  no published image anywhere in this procedure. Only the by-hand walk-through
  below needs a checkout you made yourself.
- **Tailscale, connected to the private tailnet**, with MagicDNS and HTTPS
  enabled for the tailnet — that is where the certificate comes from. Enabling
  HTTPS publishes the machine names used in certificates to a public certificate
  transparency log; Tailscale documents that tradeoff in
  [Enabling HTTPS](https://tailscale.com/docs/how-to/set-up-https-certificates).
  The probe also reads `tailscale status --json` and `tailscale ip -4` for the
  MagicDNS name and the address.
- **TCP port 443 free on the host's Tailscale IPv4 address** — *not probed*
  either. Compose publishes `<TAILSCALE_IP>:443`, and Docker binds that port
  *before* the container starts, so an address already in use fails
  `sh remote-compose.sh up` outright with the daemon's bind error. Read that
  error, not the logs: Caddy never ran, so `logs caddy` is empty and says
  nothing.

Nothing else belongs on the host: no Node, no pnpm, no `sqlite3`. Every process
here runs in a container built from the checkout, which is why the backup and
restore procedures below borrow the hub's own image rather than asking for tools
of their own.

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
4. Writes the host's `.env` — `TAILSCALE_HOST`, `TAILSCALE_IP`,
   `HUB_AUTH_TOKEN` from your local signing secret, and `WEB_WORKSPACES` with
   this machine's resolved workspace uuid — **over stdin**. The secret is never
   an argument on either side, never echoed, and never reaches a shell history.
5. Runs `sh remote-compose.sh up --build --detach`, then verifies from your
   machine: it polls `https://<host>/` for up to 90 seconds — the first request
   is what makes Tailscale issue the certificate, so an immediate check is a
   false negative — and confirms `/ws` upgrades to a WebSocket. A failure exits
   non-zero with the last hub and Caddy log lines, and persists nothing.
6. Points this machine's clients at the new hub, and prints the **join URL** a
   second computer binds to — `wss://<host>/ws/<workspace id>`, the endpoint
   with this workspace's id on the end.

Every step is idempotent: re-running `ub remote init` against a host it already
stood up adds no second deploy key and re-clones nothing. The re-run locks that
checkout continuously while it fast-forwards, replaces `.env`, rebuilds, and
records the deployed commit, so it cannot interleave with another re-run or
`ub remote update`. A contending re-run refuses as an operational failure.

That guarantee starts once the checkout already exists. The first invocation
creates the directory before it writes `.env` and builds, so do not overlap a
second invocation with that initial stand-up.

### Updating the host — deliberately

**The host does not update itself.** It stays on the commit it was last deployed
at until somebody deploys another one. Nothing is scheduled: no timer, no
webhook, no polling loop (owner decision, 2026-08-25 — an unattended updater
would apply a commit that changes wire semantics to production with nobody
present).

One command, from your own machine, run by you or by an agent session over SSH:

```sh
ub remote update uberblick@box.tailnet.ts.net
```

It runs `remote-update.sh` in the host's checkout — the same script you would
run by hand there — and reports either "up to date" or the commit it moved to.
A `flock` on the checkout keeps every deployment of an existing checkout — this
script or an `ub remote init` re-run, whichever sessions or users they run as —
from interleaving. Updater contention remains the successful no-op "already
running; nothing to do"; an explicit init re-run that cannot apply its
configuration refuses non-zero. A second checkout on the same host remains free
to deploy itself, and a host that cannot take a lock at all refuses non-zero
rather than reporting an update it never ran as success.

**When to update:** when a merged change is one you want live — a fix you are
waiting on, a feature you are about to demonstrate, a deployment you are about
to verify. Deploy while you are present to watch it, never as the last thing
before walking away.

**The wire-semantics rule.** A change to what travels over the socket — the auth
token's shape or claims, the sync protocol, the room key, the served
`/uberblick-config.json` contract — breaks every client still on the old code.
Deploy such a change and update the clients in the **same sitting**: after
`ub remote update`, pull `main` on each machine that syncs to this hub (and
reload every open browser tab, which takes its bundle and its configuration from
the host). If you cannot finish both halves now, do neither now.

Nothing is deployed *from* your checkout: the host fetches `origin/main` itself
and resets to it, so what runs there is always a commit that is on `main`.
The updater compares against `refs/uberblick/deployed`, which moves only after a
build exits 0 — never against `HEAD`. A commit whose build fails is therefore
retried on the next run rather than remembered as deployed, which is what keeps
one bad commit from wedging the host with its containers on the old code.
`git reset --hard` discards host-local edits to **tracked** files, deliberately —
the host mirrors `main` and is not a place to edit — and prints what it
discarded. The host's `.env` is untracked and survives; nothing runs `git clean`.

## What the command does, by hand

The manual procedure, kept as the reference for what `ub remote init` automates
and for repairing a host by hand.

**`docker-compose.yml` in this repository is the recipe** — the one canonical
copy of what runs, which image each service is built from, which volume holds
what, and which port is published where. It is not restated here and there is no
second copy to keep in step: read it when you want the shape of the deployment.
Caddy's configuration is the same story — `Caddyfile` is `COPY`'d into the web
image from the checkout (see `Dockerfile`) and is fully `{$VAR}`-parameterised,
so nothing writes or edits a Caddyfile on the host. **The only file the host
supplies is `.env`.**

From the repository checkout on the remote host:

```sh
cp remote.env.example .env
chmod 600 .env
tailscale ip -4
```

Mode `0600`, because that file holds the signing secret — `ub remote init`
writes it under `umask 077` and chmods it for exactly this reason.

Then edit `.env`. Its keys are the ones `docker-compose.yml` and
`remote.env.example` name, and there are no others: four required, plus optional
`WEB_HUB_URL` (see
[Pointing the client at another hub](#pointing-the-client-at-another-hub)).

- `TAILSCALE_HOST` is the host's full `*.ts.net` MagicDNS name, with no scheme
  or trailing slash.
- `WEB_WORKSPACES` is the comma-separated list of workspaces the web client
  offers, and its first entry is what `https://<TAILSCALE_HOST>/` opens. Use the
  workspace id `ub status` prints on the machine whose documents this hub is
  for, optionally decorated with a display slug (`<slug>-<uuid>`). Left at the
  placeholder, the root address has nothing to open and says so — document links
  still work, and the switcher shows only the workspace the address names. The
  value may contain only letters, digits, `,` and `-`; `remote-compose.sh`
  refuses anything else, because the list is substituted into the JSON
  configuration document and a quote there could inject a second `hubUrl` that
  retargets every browser. That refusal is the guarantee: no quote and no
  backslash reaches the document, so no escape can be written into it. The
  client also refuses a document that plainly names a key twice, but that is
  best-effort defence in depth — it reads raw JSON spelling, so an escaped key
  would slip past it, and anyone able to write into the served document could
  set `hubUrl` outright anyway. A document an attacker controls is outside this
  deployment's threat model.
- `TAILSCALE_IP` is the IPv4 address printed by `tailscale ip -4`. Compose binds
  port 443 only to this address, not to the host's public or LAN interfaces.
- `HUB_AUTH_TOKEN` is the existing shared signing secret used by the local MCP
  clients that will sync to this hub. On a trusted machine with the repository's
  age key, `fnox get HUB_AUTH_TOKEN` prints that value so it can be transferred
  to the host's ignored `.env`. Never copy the age key to the host. The secret
  must consist only of letters, digits, `.`, `_`, and `-`; `remote-compose.sh`
  refuses other characters because the shell and Compose parse `.env`
  differently — and because the value is substituted into the JSON
  configuration document Caddy serves, where a quote could inject further keys.

The wrapper reads `.env`, checks both substituted values against that alphabet,
and re-exports the secret under a name only it sets, which `docker-compose.yml`
requires. Always use it for this deployment: that requirement is what makes a
bare `docker compose up` fail rather than serve an unchecked value into the
document.

Validate the configuration without rendering its secret values, build the web
bundle, and start both services:

```sh
sh remote-compose.sh config --quiet
sh remote-compose.sh up --build --detach
sh remote-compose.sh ps
sh remote-compose.sh logs --tail=100 hub caddy
```

Two things say the deployment is up, and they are what `ub remote init` checks
for you: **the site answers** on `https://<TAILSCALE_HOST>/`, and **`/ws`
upgrades** to a WebSocket. The first request is what makes Tailscale issue the
certificate, so a check that fails immediately after `up` is a false negative —
give it up to 90 seconds. From another machine on the tailnet:

```sh
curl -sS -o /dev/null -w '%{http_code}\n' https://<TAILSCALE_HOST>/
curl -sS -o /dev/null -D - https://<TAILSCALE_HOST>/ws \
  -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
  -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: AAAAAAAAAAAAAAAAAAAAAA=='
```

`200` from the first, `101 Switching Protocols` from the second. A `502` on
`/ws` is Caddy up and the hub down — expected while the hub is stopped for a
backup, and otherwise a job for `sh remote-compose.sh logs hub`.

Then open `https://<TAILSCALE_HOST>` from a second computer on the same tailnet.
It opens the first workspace in `WEB_WORKSPACES`. In the browser developer tools,
`https://<TAILSCALE_HOST>/uberblick-config.json` must return
`{"hubUrl":"wss://<TAILSCALE_HOST>/ws","workspaces":"<the list from .env>","hubAuthToken":"<the secret from .env>"}`
and the collaboration WebSocket must be that same address; a `ws://localhost`
request means the document did not arrive and the client fell back to the values
compiled into the bundle. That document is a credential — do not paste it
anywhere. If the status line reads "no hub token", the document arrived without
`hubAuthToken`: check that the deployment commands went through
`remote-compose.sh`. The client logs one line naming both sources in force,
which is the fastest way to tell a served value from a fallback. The directory
should hydrate after the socket connects.

Do not run `docker compose config` without `--quiet`: the rendered
configuration contains `HUB_AUTH_TOKEN` in the hub environment.

### Pointing the client at another hub

Nothing about this deployment is baked into the bundle. The client fetches
`/uberblick-config.json` from the origin it was served from and takes `hubUrl`,
`workspaces` and `hubAuthToken` from it; the compiled-in endpoint is only the
fallback for when no such document is deployed, and there is no compiled-in
secret at all. Caddy renders that document from the `HUB_URL`, `WORKSPACES` and
`HUB_AUTH_TOKEN` it is given, which `docker-compose.yml` fills from
`WEB_HUB_URL` and `WEB_WORKSPACES` in `.env` — the first defaulting to
`wss://<TAILSCALE_HOST>/ws`, the second to empty — and from the checked secret
`remote-compose.sh` exports.

So retargeting the client, or changing which workspaces it offers, is an edit to
that document, not a rebuild — set the value in `.env` and recreate the Caddy
container:

```sh
sh remote-compose.sh up --detach caddy
```

The document is served with `Cache-Control: no-store`, so the next page load
picks up the change. The client reads `hubUrl`, `workspaces` and `hubAuthToken`
and ignores every other key. `hubUrl` must be a plain `ws://` or `wss://`
address — one carrying userinfo, a query string or a fragment is refused, and
the client falls back to the endpoint compiled into the bundle rather than
dialling it. An entry of `workspaces` that is not a workspace id is dropped
rather than offered, and a list with nothing usable in it degrades to the
bundle's own — which on this deployment is empty, so `/` says there is no
workspace while document links keep working. A document with no `hubAuthToken`
leaves a client that renders from its local cache and says "no hub token"; there
is no fallback secret, and the client re-reads the document on its next connect
attempt rather than giving up for the life of the tab.

Rotating the secret is the same edit: set it in `.env` and recreate the two
containers with `sh remote-compose.sh up --detach`. It is no longer a rebuild —
the bundle carries no secret (#426) — but every open tab keeps minting with the
one it was served until it is reloaded.

## Two-computer verification protocol

Use computers A and B on the same tailnet. Before starting, open the remote URL
on both, choose the same document, and give each browser a distinct awareness
name/color if prompted.

1. **Live edit and cursor:** type a distinctive sentence on A. Confirm it
   appears on B without reloading and that B renders A's remote cursor or
   selection.
2. **Local MCP to remote browser:** on the computer that launches the MCP
   client, bind that machine first —
   `ub remote join wss://<TAILSCALE_HOST>/ws/<workspace id>`, with
   `--secret-file <path>` when it does not hold the remote's secret yet — which
   persists the endpoint and the credential. An endpoint exported as `HUB_URL`
   is not read at all. A `HUB_AUTH_TOKEN` in the client's own environment still
   outranks the stored credential, so where one is set it must equal the value
   in the remote `.env`. Then launch the client, use `edit_block` on the open
   document and confirm the edit appears live on B. `sync_status` must report
   the remote URL and a connected hub.
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

Deploying a new commit is [its own runbook](#updating-the-host--deliberately).
A host stood up before 2026-08-25 carries the retired `uberblick-update.timer`;
retire it once, on that host:

```sh
systemctl --user disable --now uberblick-update.timer
rm -f ~/.config/systemd/user/uberblick-update.timer \
      ~/.config/systemd/user/uberblick-update.service
systemctl --user daemon-reload
systemctl --user list-timers --all | grep uberblick   # expect no output
```

The hub handles Compose's `SIGTERM` by flushing pending document updates before
it exits. SQLite is `/data/hub.sqlite` in the `hub-data` named volume, so normal
container replacement and `sh remote-compose.sh down` preserve it.

### Backing the hub up

```sh
sh hub-backup.sh ~/uberblick-hub-$(date +%Y-%m-%d).sqlite
```

In the host's checkout, beside `remote-compose.sh`. It **stops the hub, copies,
and starts it again** — and the stop is the point, not an inconvenience.
Hocuspocus debounces the store (2s, at most 10s; the hub leaves both at their
defaults), so a document edited a moment ago may exist only in the hub's memory.
The only flush an operator can reach is a shutdown: `SIGTERM` makes the hub
write every pending update and close the database, and `stop_grace_period: 30s`
already leaves room for that 10s ceiling. Copying a *live* file instead would
capture whatever SQLite happened to have on disk — a file that opens perfectly
and is missing the last few minutes of work.

**The hub's own verdict is what decides.** `docker compose stop` exits 0 whatever
the container did, so the script reads the exit code separately, from
`ps -a --format json` → `ExitCode`. Non-zero — including `137`, the grace period
expiring — means the flush did not finish, and **no file is written at all**. A
backup nobody can trust is worse than no backup, because it is the one that gets
restored. The hub is started again from the exit and signal traps on every path
— an `EXIT` trap alone does not run when a signal kills the script: with
`restart: unless-stopped`, a manual stop survives a Docker restart, so a run that
died between the stop and the start would leave the hub down for good.

The file lands at mode `0600`, and it lands whole: the copy goes to a temporary
sibling and is renamed onto the name you gave, so an interrupted run leaves the
previous backup exactly as it was rather than a truncated file wearing its name.
It is every document in the workspace in one readable file; treat it exactly
like the signing secret. Naming an existing directory, or a directory that is
not writable, is refused before the hub is stopped.

**Clients keep working while the hub is stopped.** Caddy stays up and serves the
app; `/ws` answers 502 for those seconds; every MCP server and browser tab goes
on editing its own replica offline and converges when the socket returns. The
window is a few seconds — but take backups when you would take a deploy, not
mid-sentence for somebody.

### Restoring one

```sh
sh hub-restore.sh ~/uberblick-hub-2026-08-28.sqlite
```

**Verified before anything is touched.** A restore runs on somebody's worst day,
against a file nobody has opened since it was written, over the only copy that is
left. So the backup is read first — `PRAGMA integrity_check`, *and* a non-empty
`documents` table, because an empty but perfectly valid database passes the
pragma and would restore a corpus of nothing. That check runs inside the hub's
own image through `node:sqlite`, the module the hub itself persists with (the
image is `node:26-bookworm-slim` and carries no `sqlite3` CLI), and writes the
candidate to the container's `/tmp`, never to `/data`. A missing, corrupt or
empty backup exits non-zero **with the hub still running and the volume
untouched**.

Only then does it stop the hub — and even then it **never writes over the live
database**. The file is copied in as `/data/hub.sqlite.restoring`, a name the
hub does not open; only once that copy is whole and owned by the container's
`node` user does a single `mv -f` put it in place, which within one filesystem
is atomic. So a copy that dies half way — a full disk, a killed daemon, an
interrupted script — leaves the database that was already there intact, and the
script says the live database was **not** replaced and exits non-zero.

**A rollback journal stops the restore rather than being worked around.** After
the stop, the script looks in the volume for a `hub.sqlite-*` sidecar. If one is
there the database is mid-transaction and the journal is the half that says what
to undo — one unit, and not one a restore should take apart: replace the
database and the journal describes a file that is gone; delete the journal and
the old database loses the rollback it needs; and every way of moving it out of
the way has a window where an interruption leaves exactly one of those. So it
copies nothing, touches nothing, and says so.

Clearing it is one line, and SQLite does the work: a journal is recovered on the
next clean open.

```sh
sh remote-compose.sh up --detach hub
sh remote-compose.sh stop hub
sh hub-restore.sh ~/uberblick-hub-2026-08-28.sqlite
```

A hub that exited non-zero but left no journal is not blocked — that is often
exactly why somebody is restoring. The exit code is reported either way.

Then the hub starts. It restores into an empty volume
just as well as over an existing one, which is the case the drill on #404
exercises: `down --volumes`, `up`, restore, and a fresh client with empty local
state enumerating and reading the pre-backup corpus.

Both scripts drive Compose only through `sh remote-compose.sh`. That is not
style: `docker-compose.yml` gates Caddy's secret on a variable only the wrapper
exports, and Compose interpolates the whole model for every subcommand, so a bare
`docker compose stop hub` fails on this host.

### What a backup is actually for

Every MCP server holds the **entire** workspace and hydrates from its own
append-only update log; `_directory`, `_sidebar` and `_feedback` are synced
documents like any other, and the hub keeps no non-synced tables today. So the
*content* is restorable without a backup at all: stand up an empty hub, let one
machine reconnect, and the corpus comes back off that replica.

What no replica gives you is **point-in-time recovery** — yesterday's text of a
document somebody has since mangled, in a system where every mangling replicates
within a second. That is the backup's job, and the only job it has here.

**Retention and encryption at rest are the owner's**, deliberately: how many of
these files to keep, where they live, whether they are encrypted or copied off
the host. Nothing here schedules a backup, rotates one, or sends one anywhere.

## Binding a computer to this hub's workspace

The hub this deployment starts is empty; `ub remote init` pointed the machine
that ran it at the new endpoint. Every other computer joins. Which process runs
where matters: everything in this section runs on **your** computers, not on the
remote host, which only ever runs `sh remote-compose.sh`.

There is one verb for joining a workspace that exists, and it is the same on
every machine:

```sh
ub remote join wss://<TAILSCALE_HOST>/ws/<WORKSPACE_ID> \
  --secret-file ~/uberblick-remote-secret
```

That is the URL `ub remote init` printed: the endpoint with the workspace id as
its last path segment. Nothing precedes it — no `ub init`, no `--workspace`, no
clone. The id is what a second machine has to be told, because a workspace id is
a uuid: a machine that invented its own would join the hub and find nothing of
yours there, the rooms being keyed by a different id. Carrying it in the URL is
what makes that one string, and one paste, rather than two.

`join` binds this machine to the workspace the URL names **whatever is here
already**, pulls the whole remote directory and every live document into the
local update log for it, verifies that by the same read-back, and only then
persists the endpoint and the binding. It seeds nothing into a joined workspace:
the documents come off the wire. An unreachable or auth-rejecting remote writes
nothing at all.

A machine that already had a workspace of its own keeps it. It is not merged and
not moved: `ub workspace list` shows both, and `ub workspace use <id>`
switches back. The endpoint, though, is machine-wide — after a join, the
workspace that was here syncs with this hub too, under its own rooms.

A URL with no workspace id, or with something that is not one, is refused before
anything is written, and the refusal names the form.

**A workspace that does not exist yet is the other verb.** To put a *new*
workspace on this hub — the first one, or another one later — the machine that
creates it runs:

```sh
fnox exec -- ub init <TAILSCALE_HOST>
```

The bare host is read as `wss://<TAILSCALE_HOST>/ws`, this deployment's
endpoint, and the `wss://` form in full works the same; `ub init` dials and
authenticates before it writes anything, stores the endpoint, generates the
workspace id and has its starter documents on the hub by the time it returns —
if the hub does not acknowledge them it says so and exits non-zero rather than
reporting a workspace the hub does not hold.

The hub's secret has to reach that command's **environment**, because a secret
generated locally is random and this hub would refuse it. `fnox exec` is how
this repository supplies it; any other way of exporting `HUB_AUTH_TOKEN` into
the shell works, and a `credentials.json` this machine already holds is read
without any of that. Never put the secret in the command itself: a command line
is in every `ps` listing and every shell history. Every *other* machine then joins that workspace with the URL
above — `ub status` on this one names the id. `ub init` never replaces an
endpoint already stored: the same one changes nothing, and a different one is
refused, naming `ub remote join` as the move. Neither command asks anybody to
edit `config.json`.

To run the web client on this machine against the remote hub, from a clone:

```sh
mise trust && mise run setup -- --yes   # a checkout, its own local workspace
ub remote join wss://<TAILSCALE_HOST>/ws/<WORKSPACE_ID> \
  --secret-file ~/uberblick-remote-secret
mise run web
```

`ub init` with no hub argument (which is how `mise run setup` runs it) creates a
*local* workspace with its starter documents; the join then binds this machine
to the remote one, and
`mise run web` serves it because the task runs its command through `ub env`,
which resolves this machine's own configuration. Nothing is written into the
checkout.

The secret that reached the remote replaces whatever this machine had, at mode
0600, and the command says so — on a second machine that is the point, since a
locally generated secret is random and the remote verifies with the first
machine's.

Persisting the endpoint — and, after a join, the workspace binding — writes
`$XDG_CONFIG_HOME/uberblick/config.json`, which is the only place `ub`,
`ub mcp serve`, the MCP server it spawns and every checkout task under `ub env`
resolve them from — an endpoint in the environment is not read at all. The
*workspace* can still be outranked by `WORKSPACE_ID` there, and a project MCP
entry pinned with `ub mcp install --project --workspace <id>` is exactly how one
gets into an agent session's environment; `join` names the winner instead of
claiming a switch that did not take effect. The deployed web client here reads
its endpoint at runtime from the served `/uberblick-config.json`, not from any
of them.

The `--secret-file` argument is a path, never the secret: it must be a file only
you can read (mode 0600), holding either the bare value from the host's `.env`
or a `credentials.json` carrying it. Without the flag, the secret already
configured is tried first and a terminal is prompted with the input hidden.
Nothing here prints the secret or a token signed with it.

Archived documents replicate as directory state and stay archived; their content
is not moved. Merging two independently populated workspaces is not supported:
the URL says which workspace `join` is about — that one's two replicas reconcile
as CRDTs, and the others on the machine are left alone.
