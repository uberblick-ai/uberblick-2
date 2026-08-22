# Remote deployment over Tailscale

This deployment runs one hub and one prebuilt web client on a Linux host that
is already in a private Tailscale network. Caddy serves the single-page app,
proxies `/ws` to the hub, and asks the host's Tailscale daemon for the HTTPS
certificate. The hub is not published directly.

> the served bundle contains the shared write-token signing secret — this deployment is supported only on a private Tailscale network until server-minted sessions exist; an unguessable public hostname is not a security boundary.

Server-minted sessions are the planned replacement; see
[Hosted future](CLAUDE.md#hosted-future-directional--shapes-cheap-now-choices-only).

## Host prerequisites

- A Linux host with a plain checkout of this repository, Docker Engine, and
  Docker Compose v2.
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

Edit `.env` and set all three values:

- `TAILSCALE_HOST` is the host's full `*.ts.net` MagicDNS name, with no scheme
  or trailing slash.
- `TAILSCALE_IP` is the IPv4 address printed by `tailscale ip -4`. Compose binds
  port 443 only to this address, not to the host's public or LAN interfaces.
- `HUB_AUTH_TOKEN` is the existing shared signing secret used by the local MCP
  clients that will sync to this hub. On a trusted machine with the repository's
  age key, `fnox get HUB_AUTH_TOKEN` prints that value so it can be transferred
  to the host's ignored `.env`. Never copy the age key to the host.

Validate the resolved configuration, build the web bundle with
`wss://<TAILSCALE_HOST>/ws` baked in, and start both services:

```sh
docker compose config
docker compose up --build --detach
docker compose ps
docker compose logs --tail=100 hub caddy
```

Open `https://<TAILSCALE_HOST>` from a second computer on the same tailnet. In
the browser developer tools, the collaboration WebSocket must be
`wss://<TAILSCALE_HOST>/ws`; an `ws://` request means the image was built with
the wrong `TAILSCALE_HOST`. The directory should hydrate after the socket
connects.

The web configuration is compiled into the image. After changing
`TAILSCALE_HOST` or `HUB_AUTH_TOKEN`, rebuild it with
`docker compose up --build --detach`; restarting the existing container cannot
change the bundle.

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
   both computers. On the host run `docker compose restart hub`, then reload B.
   Confirm the document and the last edit remain.
5. **Named-volume durability:** record a distinctive document title, then run
   `docker compose down` followed by `docker compose up --detach`. Reload B and
   confirm the title remains and the directory hydrates. Do not pass `--volumes`
   to `down`; that flag intentionally deletes the named SQLite volume.

Record the host name, date, browser/OS pairs, and pass/fail result for every
step in issue #75. The physical two-computer checks are deployment evidence;
they are not replaced by the repository's local test suite.

## Operations

```sh
docker compose logs --follow hub caddy
docker compose restart hub
docker compose down
docker compose up --detach
```

The hub handles Compose's `SIGTERM` by flushing pending document updates before
it exits. SQLite is `/data/hub.sqlite` in the `hub-data` named volume, so normal
container replacement and `docker compose down` preserve it. Backups and moving
an existing local workspace into this deployment are separate follow-ups.

