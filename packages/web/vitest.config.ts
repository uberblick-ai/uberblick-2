import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [tailwindcss(), react()],
  // Unit fixtures own their configuration. The checkout's binding and machine
  // credentials are exercised by tests that explicitly load vite.config.ts.
  define: {
    __RUNTIME_CONFIG_ONLY__: "false",
    __HUB_URL__: JSON.stringify("ws://localhost:1234"),
    __WORKSPACE_ID__: JSON.stringify(""),
    __WORKSPACES__: JSON.stringify(""),
  },
  test: {
    // jsdom everywhere: the golden round-trip test drives a real ProseMirror
    // EditorView, which needs a DOM.
    environment: "jsdom",
    // Full-app fixtures import the editor and render portal/focus lifecycles
    // while the other packages run in parallel. Their deadline is a liveness
    // guard, not a five-second performance contract on shared CI CPUs.
    testTimeout: 20_000,
    setupFiles: ["test/setup-dom.ts"],
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
    // CI output, as in packages/schema/vitest.config.ts.
    reporters: process.env.CI ? ["dot"] : ["default"],
    silent: "passed-only",
    execArgv: ["--no-experimental-webstorage"],
    // The reconnect suite runs real hubs on real sockets, and its `afterEach`
    // stops two of them. Vitest's default 5s hook budget is what a shutdown
    // under load overruns, and it overruns it anonymously — the hook has no
    // label to fail with. Matches packages/mcp-server, for the same reason: the
    // timeout that fires first is the one that gets to explain itself, so the
    // anonymous one is kept out of the way.
    hookTimeout: 120_000,
    // One worker per core rather than Vitest's cores-1 default. Workers spend
    // most of their time starting jsdom and importing the editor, not idling
    // on the main process, and measured on a 4-core box under load the extra
    // worker took the suite from ~37s to ~32s.
    maxWorkers: "100%",
  },
});
