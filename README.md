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

All four are private workspace packages and resolve to their TypeScript sources
(`exports` → `./src/index.ts`). Nothing imports build output: `tsx`, `vite` and
`vitest` compile TypeScript directly, and `tsc` is only ever a typechecker here
(`build` and `typecheck` both run `tsc --noEmit`). There is no `dist/` in any
resolution path.

## Running things

[mise](https://mise.jdx.dev) tasks are the only supported entry points. Do not
invoke `pnpm` directly — the tasks pin the toolchain and wrap commands in
`fnox exec` so secrets are present.

```
mise install          # Node 26, pnpm 10, fnox 1
mise exec -- pnpm install

mise run hub          # Hocuspocus sync hub
mise run mcp          # MCP server, standalone smoke test only (see below)
mise run web          # Vite dev server
mise run dev          # hub + web in parallel
mise run lint         # Biome lint across the workspace (no formatter)
mise run typecheck    # tsc --noEmit across all packages
mise run test         # all test suites
mise run e2e          # browser proof points (Playwright, Chromium, on demand)
REVIEW_SHA=<commit> mise run review  # immutable Docker review of one commit
```

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

`.mcp.json` registers the server for any MCP client that reads it, Claude Code
included — the client spawns it for you, so there is nothing to start by hand.
For a standalone smoke test, `mise run mcp` runs the same thing in the
foreground. The exact spawn is config, and `.mcp.json` is where it lives; read it
there rather than copying it into a shell.

What that config is careful about, since none of it is obvious:

- Secrets come from `fnox exec`, which supplies `HUB_AUTH_TOKEN`. A missing key
  is a warning, not an error, on purpose: a contributor without the age key still
  gets a working server — offline-first, with `sync_status` reporting `disabled`.
- Package-manager lifecycle output is suppressed. stdout is the JSON-RPC
  transport, so a banner on it would corrupt the session.
- `HUB_URL` is left unset, so the server falls back to `ws://localhost:1234` —
  the same default mise's `[env]` carries. No hub address is pinned here.

`mise run import-seed` is the one-time import of `docs-seed/` into the system.
After it, the product docs live in the documents, and are read and written
through the MCP tools rather than by editing the seed files.

## Review isolation

`mise run review` resolves `REVIEW_SHA` to a commit, streams that commit through
`git archive`, builds its `Dockerfile.review`, and runs the full typecheck and
test gates in a disposable container. The build context therefore contains
only committed files from the reviewed SHA: it cannot pick up a changing
checkout, untracked files, local `node_modules`, `.git`, or plaintext secrets.
The resulting image is tagged `uberblick-review:<full-sha>` and retained so a
reviewer can run focused failure-path probes against the exact same environment.

### The trust boundary

`Dockerfile.review` belongs to the branch, so branches may add the OS/runtime
dependencies their changes require — which makes it executable branch code.
Two consequences follow, and neither is papered over.

**The build stage has network; the verification stage does not.** Installing
the pinned package manager and the lockfile's dependencies needs the npm
registry, so `docker build` runs the branch's `RUN` instructions on Docker's
default network. The verification container that runs the gates is the isolated
half: `--network none --cap-drop ALL --security-opt no-new-privileges`.
Restricting the build itself is not on the table — `docker build
--network=none` fails at the package-manager install, and a `RUN
--network=none` written *inside* the Dockerfile would be a control the branch
could simply delete. So the build stage is guarded procedurally: read the
reviewed commit's `Dockerfile.review` diff **before** you run anything, and
note that a build only ever happens on an explicit
`REVIEW_SHA=<commit> mise run review` — nothing builds a branch automatically
and no CI job builds one on push. The standing rule bounds the blast radius:
never pass build secrets, host mounts, privileged mode, or the Docker socket,
so a hostile build has no credentials of ours to exfiltrate.

**The task definition comes from your checkout, not from the branch.**
`mise run review` reads `mise.toml` from the working tree it runs in, so the
launcher is trustworthy exactly as far as that tree is. Keep it that way:
reviewing a PR never requires checking the branch out. The task builds
`git archive <REVIEW_SHA>`, which needs the commit *fetched*, not checked out —
so stay on your own `main` and pass the SHA. Check out a branch you are
reviewing and you have already handed it your `mise.toml`, your git hooks and
your `node_modules`, long before Docker is involved.

## Toolchain choices

**Node 26** (`engines.node: ">=26"`, `mise` `node = "26"`). One runtime version
across the repo; it gives us stable native `fetch`/WebStreams, and `tsx` is the
only TypeScript loader we need.

**better-sqlite3 pinned to `^12`.** The 12.x line is what publishes prebuilt
binaries for Node 26's ABI. On older majors the install falls back to compiling
from source, which needs a full C++ toolchain on every contributor machine and
in CI. pnpm 10 blocks install scripts by default, so `better-sqlite3` (and
`esbuild`) are listed under `onlyBuiltDependencies` in `pnpm-workspace.yaml`;
bumping the major means re-checking that prebuilds exist for the Node we pin.

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
warning and the command still runs with that variable unset instead of aborting.
`mise run lint`, `mise run test` and `mise run typecheck` don't shell through
fnox at all.

`HUB_AUTH_TOKEN` is the HMAC secret hub tokens are signed with. The hub refuses
to start without it — a hub that cannot verify a token would accept anything.
The MCP server treats it as optional and runs local-only without it: its update
log is the authoritative replica, so no secret means no sync, not no service
(`sync_status` reports `hub.status: "disabled"`). It also reads `WORKSPACE_ID`
(default `main`) and `UBERBLICK_DB` (default
`$XDG_DATA_HOME/uberblick/<workspace>.sqlite`).
