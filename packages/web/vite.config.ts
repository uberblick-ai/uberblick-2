import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

/**
 * Client configuration reaches the bundle through `define`.
 *
 * `HUB_URL` and `WORKSPACE_ID` are plaintext config, put into this command's
 * environment by `ub env`, which the `mise run web` task wraps it in: they are
 * this machine's own configuration, resolved by `ub` from `config.json`. The
 * committed `mise.toml` carries no endpoint (#376), so a checkout that has
 * joined nothing falls back to the `ws://localhost:1234` below.
 * `HUB_AUTH_TOKEN` is a real secret decrypted by `fnox exec`, which wraps that
 * in turn. All three are read here, at config time, from the task's environment
 * — never from a committed `.env`.
 *
 * `HUB_URL`, `WORKSPACE_ID` and `WORKSPACES` are *defaults*, not the answer.
 * The client prefers the hub endpoint
 * and the workspace list served at `/uberblick-config.json` on its own origin,
 * and falls back to these values when no such document is deployed — which is
 * exactly the dev server, where nothing serves that path and `mise run dev`
 * therefore needs no configuration document. See src/config.ts.
 *
 * `__WORKSPACE_ID__` is the first of those workspaces: it answers one address,
 * `/`, which names no workspace. Every other address carries its own — a bundle
 * is not bound to a workspace, and no workspace at all means `/` says so rather
 * than guessing. `__WORKSPACES__` is `WORKSPACES`, the rest of the menu, comma
 * separated and empty by default because the ids are a uuid per machine.
 * Switching workspaces is navigating, so the list changes what is on the menu,
 * never which corpus an address opens. See src/ui/route.ts.
 *
 * ============================ LOUD WARNING ============================
 * Embedding HUB_AUTH_TOKEN in the bundle is a PRIVATE-SPIKE-ONLY shortcut.
 * Anything served to a browser is public: this secret would be readable by
 * every visitor. It is acceptable here only on localhost or on the explicitly
 * supported private-Tailscale deployment described in REMOTE.md.
 *
 * The hosted design is already decided (see CLAUDE.md, "Hosted future"): the
 * server mints a claims-shaped token per OAuth session and hands it to the
 * client, so the signing secret never leaves the server. When that lands,
 * `HUB_AUTH_TOKEN` disappears from this file and `src/collab/token.ts` becomes
 * a fetch against the session endpoint.
 * =====================================================================
 */
export default defineConfig({
  // Tailwind is chrome-only (#27): it compiles `src/ui/tailwind.css`, which the
  // vendored shadcn components under `src/ui/shadcn` are styled with. Preflight
  // is deliberately not imported there — see that file. The plugin is a no-op
  // for every module that does not import that stylesheet, the editor's and the
  // sidebar's plain CSS included.
  plugins: [tailwindcss(), react()],
  define: {
    __HUB_URL__: JSON.stringify(process.env.HUB_URL ?? "ws://localhost:1234"),
    __HUB_AUTH_TOKEN__: JSON.stringify(process.env.HUB_AUTH_TOKEN ?? ""),
    __WORKSPACE_ID__: JSON.stringify(process.env.WORKSPACE_ID ?? ""),
    __WORKSPACES__: JSON.stringify(process.env.WORKSPACES ?? ""),
  },
  server: {
    port: 5173,
  },
  test: {
    // jsdom everywhere: the golden round-trip test drives a real ProseMirror
    // EditorView, which needs a DOM.
    environment: "jsdom",
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
    // The reconnect suite runs real hubs on real sockets, and its `afterEach`
    // stops two of them. Vitest's default 5s hook budget is what a shutdown
    // under load overruns, and it overruns it anonymously — the hook has no
    // label to fail with. Matches packages/mcp-server, for the same reason: the
    // timeout that fires first is the one that gets to explain itself, so the
    // anonymous one is kept out of the way. Per-test budgets are set in the
    // file that needs them.
    hookTimeout: 120_000,
  },
});
