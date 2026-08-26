---
uuid: 4575a744-1656-4699-af69-980a05d15fcc
title: Remote server setup
tags: [reference]
links: [7b4c11a6-37a2-4dff-862e-9bf5c4f0bfd8, 9b4ea859-8304-4e11-9cc8-76232c16a4e5, 8727c914-c462-410a-bff4-0d2975d1dbcc]
---

Running the hub and web client on a remote Linux host inside a tailnet, so a
second machine can reach the same corpus. The served bundle still carries the
shared signing secret, so this is supported on a private tailnet and nowhere
else.

## What the host needs

Linux with Docker and Compose 2.6 or newer, `git`, SSH, and Tailscale up with
MagicDNS and HTTPS enabled for the tailnet. Port 443 free on the Tailscale
IPv4. Your own machine must also be on the tailnet, because it is what verifies
the deployment afterwards.

## Standing it up

```sh
ub remote init <ssh-target> [--dir <path>] [--host <fqdn>] [--ip <v4>]
```

In order, it: requires a local signing secret; checks that this machine is on
the tailnet; runs one preflight command over SSH reporting the host's Compose
version, `git`, Tailscale, any existing checkout and any existing deploy key;
resolves the host's MagicDNS name and Tailscale IPv4 — detected, or from the
flags, or prompted, never guessed; generates an ed25519 deploy key **on the
host** and registers its public half with GitHub, matched by key material
rather than by title so a re-run is idempotent; clones or fast-forwards the
checkout; writes the host `.env` over stdin with mode 0600; brings the stack up;
and then verifies from your machine by fetching the site — the first request is
what makes Tailscale issue the certificate — and completing a real WebSocket
upgrade against `/ws`.

The signing secret never appears in an argument, on either side, and never in
an error message.

Finally, if this workspace already holds documents, `ub remote init` changes
nothing and prints the `ub remote promote` command instead. If it holds none,
it points this machine at the new endpoint.

## What runs there

- `hub` — the Node image running the hub, bound to all interfaces inside the container on port 1234, with its SQLite database on a named volume. It is not published directly.
- `caddy` — the stock Caddy image serving the built web bundle, published on the Tailscale IPv4 address only, never the public or LAN interface. It takes the tailnet certificate straight from the Tailscale socket rather than through ACME.

Caddy answers `/uberblick-config.json` with the hub endpoint and the workspace
list, before the single-page fallback; proxies `/ws` to the hub; and serves
everything else from the bundle.

`remote-compose.sh` is the mandatory wrapper: it refuses an old Compose,
enforces the character sets of the secret and the workspace list — the
workspace list is substituted inside a JSON string, where a quote could append
a second endpoint and retarget every browser — and derives a non-secret digest
of the secret as a cache key, which is what forces a web rebuild after the
secret is rotated.

`WEB_HUB_URL` and `WEB_WORKSPACES` are named that way deliberately: the
unprefixed names already mean something on a developer's machine, and
inheriting those values would serve them to every visitor.

## Moving a corpus

- `ub remote promote <url>` moves a populated workspace onto an empty remote hub. It requires a reachable local hub, because documents made in a browser live only there; it refuses if the target already holds documents this workspace never heard of; and it persists the new endpoint only after a fresh client re-reads the target and compares in both directions, tombstones included.
- `ub remote join <url>` pulls a populated remote workspace into an empty local one. It does not require a local hub, since a second machine has none, and it says plainly that its emptiness check therefore saw only the update log.
- `ub remote set <url>` points the clients at an endpoint and moves nothing.

Either bridge takes the secret from `--secret-file` with mode 0600 enforced, or
from a hidden prompt. The endpoint and the credential are written in an order
that cannot leave the two files naming different hubs.

## Updating, deliberately

The host never updates itself. There is no timer, no webhook and no polling
loop. One command deploys:

```sh
ub remote update <ssh-target>
```

It takes a lock outside the checkout it rewrites, fetches `origin/main`,
compares it against the ref recording what was last successfully deployed —
never against the checkout's own head, so a commit whose build failed is
retried rather than remembered as deployed — resets, rebuilds, and moves that
ref only on success. The host's `.env` is untracked and survives.

The rule this buys: a change to the token shape, the sync protocol, the room
key or the served config contract must be deployed and have every client
updated in the same sitting. There are no compatibility windows.
