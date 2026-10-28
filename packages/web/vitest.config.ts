import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";
import { vitestBudgets } from "../../scripts/vitest-budget-config.mjs";

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
    ...vitestBudgets("web"),
    silent: "passed-only",
    execArgv: ["--no-experimental-webstorage"],
    // Real-hub shutdown hooks share the complete-attempt budget with the body.
    hookTimeout: 60_000,
    // Standalone runs use one worker per core for jsdom and editor imports.
    // Root runs supply their shared budget through VITEST_MAX_WORKERS instead.
    maxWorkers: "100%",
  },
});
