---
uuid: 7b4c11a6-37a2-4dff-862e-9bf5c4f0bfd8
title: Install and run
tags: [start-here]
links: [3231bff4-fb3c-4195-a83a-98031551ca68, 8865aba4-fc8b-4050-a8d2-9c851be0bed3, bea0f13c-5ba9-4fb6-af7b-d627b4807786, 4575a744-1656-4699-af69-980a05d15fcc, f1f403e6-fb4b-4e95-b12f-4fc0df8f4957]
---

Two commands from a clean machine to a running stack. Everything runs from
TypeScript source inside a checkout; there is no installable package yet.

## Prerequisites

`git` and `mise`. Nothing else — mise installs the pinned Node, pnpm and fnox
itself. No age key is needed: without one, `ub init` generates its own local
development signing secret and says so.

## Getting it running

```sh
git clone <repo> && cd uberblick
mise trust && mise run setup -- --yes
mise run dev
```

`mise trust` comes first because mise treats an untrusted config as a hard
error for every task in the directory. `mise run setup` runs `mise install`,
then a frozen-lockfile `pnpm install`, then `ub init`. Drop `--yes` to be
prompted; a non-interactive shell behaves as if you passed it. `mise run dev`
starts the hub and the Vite dev server together and takes both down on Ctrl-C.

Without an activated shell, prefix commands with `mise x --`.

## What `ub init` creates

- A workspace uuid, with an optional cosmetic display slug stored as `<slug>-<uuid>`. There is no default workspace and the uuid is never guessable.
- `$XDG_CONFIG_HOME/uberblick/config.json` — the workspace, your awareness display name and colour. Mode 0600, in a 0700 directory.
- `$XDG_CONFIG_HOME/uberblick/credentials.json` — the hub's HMAC signing secret, 32 random bytes. Mode 0600. It is never printed, and a file other users can read is refused rather than used.
- `mise.local.toml` in the checkout, gitignored, derived from those two files. It owns exactly three keys — `WORKSPACE_ID`, `HUB_AUTH_TOKEN` and `HUB_URL` — and passes every other line through untouched, so mise tasks and a registered MCP client see the same values `ub` resolved.
- A two-document starter corpus, but only into a workspace that holds nothing else.

Nothing here needs a network. Two `ub init` runs racing each other take a lock,
and the loser adopts the winner's secret and workspace rather than overwriting
them.

## The tasks

- `mise run dev` — hub and web dev server together, at `http://localhost:5173`.
- `mise run hub` — the hub alone. It binds `HUB_HOST`:`PORT`, default `127.0.0.1:1234`; `HUB_URL` is what clients dial, so the two must agree.
- `mise run web` — the Vite dev server alone.
- `mise run import-seed` — import `docs-seed/*.md`, keyed by frontmatter uuid.
- `mise run mcp` — a standalone smoke test of the MCP server. An MCP client normally spawns it over stdio itself.
- `mise run lint`, `mise run typecheck`, `mise run test` — the gates.
- `mise run e2e` — the browser proof points, on demand, on their own ports.
- `mise run build-web` — a production bundle. This one needs the real secret.
- `mise run fue` — the documented install path, executed on a clean machine in Docker and then asserted with the network switched off.
- `mise run review` — build and verify an immutable commit in Docker.

## Wiring up an MCP client

```sh
ub mcp install claude          # or codex, or cursor
```

It writes this directory's config by default, `--user` for the per-user one,
`--print` to emit the snippet and write nothing, and `--force` to replace an
existing entry after backing the file up. An unrelated server in the same file
survives byte for byte. The registered command is always `ub mcp serve`, with
no arguments and no environment: it resolves the workspace, endpoint and secret
itself at spawn time, so switching workspaces never means editing a client
config.

`--workspace <id>` registers a second, pinned entry instead of touching the
first.

## Knowing where you stand

- `ub status` — the workspace and which layer chose it, the hub endpoint and its state, whether a credential is present, the database path, per-room applied sequence numbers and anything unsynced. `--json` prints one object.
- `ub doctor` — seven checks against the known failure modes: workspace, credential, database, hub, port, bind and MCP registration. It diagnoses and never repairs, exits 1 on any failure, and never prints the secret.
- `ub workspace` — the workspace in force; `ub workspace list` for the ones this machine has a database for; `ub workspace use <id>` to bind this directory, or `--user` to bind the machine. Either way it regenerates the derived mise config, so the tasks follow the switch.
- `ub open` — serve a built bundle and, if nothing is listening locally, a hub, then open a browser. Loopback only, port 4173 by default.

## Where the signing secret comes from

Highest wins: the environment, then `credentials.json`, then the derived mise
config, then a freshly generated one. `fnox exec` supplies the environment
layer on a machine that has the age key; every mise task that needs a secret
wraps its command in `fnox exec --if-missing warn`, so a contributor without
the key still runs the stack on a generated one.

The secret is a signing secret, not a token. It is never written to a `.env`
file, never committed, and never printed by any command.

## If it fails

- Nothing answers the hub — check that `PORT` and `HUB_URL` name the same socket; `ub doctor`'s `port` check is exactly that comparison.
- The port is held by something else — `ub doctor`'s `bind` check tells you whether the holder is an uberblick hub or a stranger.
- A refused workspace, an exposed credentials file, an unwritable database directory: each is its own `ub doctor` line with its own remedy.
