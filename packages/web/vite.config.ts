import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

/**
 * Client configuration reaches the bundle through `define`.
 *
 * `HUB_URL` is plaintext config (mise `[env]`); `HUB_AUTH_TOKEN` is a real
 * secret decrypted by `fnox exec`, which the `mise run web` task already wraps
 * this command in. Both are read here, at config time, from the task's
 * environment — never from a committed `.env`.
 *
 * ============================ LOUD WARNING ============================
 * Embedding HUB_AUTH_TOKEN in the bundle is a LOCAL-SPIKE-ONLY shortcut.
 * Anything served to a browser is public: this secret would be readable by
 * every visitor of a hosted deployment. It is acceptable here only because the
 * hub runs on localhost against a dev secret.
 *
 * The hosted design is already decided (see CLAUDE.md, "Hosted future"): the
 * server mints a claims-shaped token per OAuth session and hands it to the
 * client, so the signing secret never leaves the server. When that lands,
 * `HUB_AUTH_TOKEN` disappears from this file and `src/collab/token.ts` becomes
 * a fetch against the session endpoint.
 * =====================================================================
 */
export default defineConfig({
  plugins: [react()],
  define: {
    __HUB_URL__: JSON.stringify(process.env.HUB_URL ?? "ws://localhost:1234"),
    __HUB_AUTH_TOKEN__: JSON.stringify(process.env.HUB_AUTH_TOKEN ?? ""),
  },
  server: {
    port: 5173,
  },
  test: {
    // jsdom everywhere: the golden round-trip test drives a real ProseMirror
    // EditorView, which needs a DOM.
    environment: "jsdom",
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
  },
});
