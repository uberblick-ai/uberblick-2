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

- A Linux host with a plain checkout of this repository, Docker Engine, and
  Docker Compose 2.6.0 or newer (Compose 5 also satisfies this requirement).
  Check with `docker compose version --short`. Compose 2.5 added build secrets;
  2.6 is the minimum that also supports the environment-backed secret source
  and top-level project name used here.
- Tailscale installed on the host and connected to the private tailnet. MagicDNS
  and HTTPS must be enabled for the tailnet. Enabling HTTPS publishes the
  machine names used in certificates to a public certificate transparency log;
  Tailscale documents that tradeoff in
  [Enabling HTTPS](https://tailscale.com/docs/how-to/set-up-https-certificates).
- TCP port 443 free on the host's Tailscale IPv4 address.

Caddy supports Tailscale certificates without an ACME challenge when it can
reach the local Tailscale daemon. The compose file bind-mounts the standard
`/var/run/tailscale/tailscaled.sock` and runs Caddy as root inside its container,
which is one of the access modes documented by
[Caddy certificates on Tailscale](https://tailscale.com/docs/integrations/web-servers/caddy/caddy-certificates).

## Bring it up

From the repository checkout on the remote host:

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

The hub handles Compose's `SIGTERM` by flushing pending document updates before
it exits. SQLite is `/data/hub.sqlite` in the `hub-data` named volume, so normal
container replacement and `sh remote-compose.sh down` preserve it. Backups and
moving an existing local workspace into this deployment are separate
follow-ups.
