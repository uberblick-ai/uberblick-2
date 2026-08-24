---
uuid: 7b4c11a6-37a2-4dff-862e-9bf5c4f0bfd8
title: Install and run
tags:
  - start-here
links:
  - 3231bff4-fb3c-4195-a83a-98031551ca68
  - 8865aba4-fc8b-4050-a8d2-9c851be0bed3
  - 8727c914-c462-410a-bff4-0d2975d1dbcc
  - f1f403e6-fb4b-4e95-b12f-4fc0df8f4957
---

Running uberblick locally takes one command. It needs no account, no age key,
and no remote hub.

```
git clone https://github.com/uberblick-ai/uberblick-2.git
cd uberblick-2
mise trust && mise run setup -- --yes
mise run dev
```

`mise run setup` installs the pinned toolchain (Node 26, pnpm 10, fnox 1) and
the frozen lockfile, then runs `ub init`. `mise run dev` starts the hub and the
Vite dev server on http://localhost:5173.

## What this supports

One workspace, one trusted user, multiple clients and machines; no login and no
tenant isolation. Every client on your machines shares one signing secret, and
anyone holding it can read and write everything. That is the deliberate shape of
the current system, not a gap waiting on a patch.

## Prerequisites

- `git`.
- `mise`, which pins Node 26, pnpm 10 and fnox 1 for this repository.
- Nothing else. `age` and the repository owner's key are for the owner's
  encrypted secret, not for running the system.

`mise trust` comes first because mise refuses to read a config file with an
`[env]` block until it has been told to trust it — and refusing is a hard error,
not a warning.

## What `ub init` does

- Settles your **awareness identity**: the display name and cursor colour other
  clients see. Written to `$XDG_CONFIG_HOME/uberblick/config.json`.
- Settles the **workspace** (default `main`), which is the first segment of every
  room key and the name of the local SQLite file.
- Makes sure there is a **hub signing secret**. `HUB_AUTH_TOKEN` is the HMAC
  secret hub tokens are signed with, not a token.

It is convenience, never a precondition: every other command works without it,
falling back to workspace `main` and hub `ws://localhost:1234`.

Run it again whenever you like. It is idempotent, and it never replaces a secret
that already exists.

Every question has a flag — `--name`, `--color`, `--workspace` — and `--yes`
takes all the defaults, so it needs no terminal to talk to. It finishes by
offering to wire up an agent's MCP client (`--mcp` / `--no-mcp`); that wiring
itself is not built yet, and until it is, the repository's `.mcp.json` already
registers the server for MCP clients that read it.

## Where the signing secret comes from

Two paths, and they do not fight:

- **The repository owner** keeps the real secret age-encrypted in `fnox.toml`,
  and every task wraps its command in `fnox exec`. With the age key present that
  value overwrites `HUB_AUTH_TOKEN` in the task's environment, so it wins — and
  `ub init` generates nothing when it can already see a secret.
- **Everyone else** gets a generated development secret: 32 random bytes written
  to `$XDG_CONFIG_HOME/uberblick/credentials.json`, mode 0600. That file is the
  authority. Because mise tasks and `.mcp.json` inherit their environment from
  mise rather than from `ub`, `ub init` also writes a gitignored
  `mise.local.toml` derived from it — same value, one owner, rewritten if the two
  ever drift, and restored with the same value if you delete it.

The secret is never printed by any command, including error paths. The most any
of them reports is where it came from.

## Verify

- Open `http://localhost:5173` in two browser windows.
- Click "+ new doc" in the first window; the document appears in the second
  window's list, which is fed by the directory document.
- Open it in both windows and type in the first. The characters appear in the
  second, and a named, coloured remote cursor marks where the other window is.
- `mise run import-seed` imports the product documents; an MCP client's
  `list_docs` then returns them.

## If it fails

- `mise ERROR ... are not trusted`: run `mise trust` in the checkout. If it
  names `mise.local.toml`, `mise trust mise.local.toml` — `ub init` normally
  does this for you, and says so when it could not.
- Both windows show "offline": the hub is not running, or `HUB_URL` disagrees
  with the port the hub bound.
- The hub refuses to start with "HUB_AUTH_TOKEN is not set": no secret reached
  it. Run `mise run init` and check that it reports a credential.
- `ub status` says `credential  none — local-only, no hub sync`: same cause, and
  everything except hub sync still works.
- `refusing ...credentials.json: mode 0644`: another user on the machine can read
  your signing secret, so it was not used. `mise run init` repairs the mode and
  keeps the value.
- Port 1234 already in use: set `PORT` for the hub and `HUB_URL` for the clients
  together. The hub binds `HUB_HOST`:`PORT`, default `127.0.0.1:1234`, and never
  reads `HUB_URL`.
- To check the checkout itself rather than the stack: `mise run test` and
  `mise run typecheck`.
