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

Running uberblick locally means installing mise, placing the age key, and
starting the hub and the web dev server with one task.

## Prerequisites

- `git`.
- `mise`, which pins Node 26, pnpm 10 and fnox 1 for this repo.
- `age`, for decrypting secrets: `brew install age`.
- The age private key at `~/.config/fnox/age.txt`. It is never in the repo.

## Steps

```
git clone https://github.com/uberblick-ai/uberblick-2.git
cd uberblick-2
mise install
mise run install
mise run dev
```

`mise run dev` starts the hub and the Vite dev server. The MCP server is a stdio
process spawned by its own client, so it is not part of the dev loop.

## Verify

- Open `http://localhost:5173` in two browser windows.
- Click "+ new doc" in the first window; the document appears in the second
  window's list, which is fed by the directory document.
- Open it in both windows and type in the first. The characters appear in the
  second, and a named, coloured remote cursor marks where the other window is.

## If it fails

- No age key: `fnox exec --if-missing warn` warns and leaves `HUB_AUTH_TOKEN`
  unset. The hub then refuses to start — `resolveHubConfig` throws
  "HUB_AUTH_TOKEN is not set" — and the web dev server starts but throws
  "HUB_AUTH_TOKEN is empty" on every connection attempt.
- Both windows show "offline": the hub is not running, or `HUB_URL` disagrees
  with the port the hub bound.
- Port 1234 already in use: set `PORT` for the hub and `HUB_URL` for the clients
  together. The hub binds `HUB_HOST`:`PORT`, default `127.0.0.1:1234`, and never
  reads `HUB_URL`.
- To check the checkout itself rather than the stack: `mise run test` and
  `mise run typecheck`.
