import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin, type UserConfig, runnerImport } from "vite";
import { fileURLToPath } from "node:url";

/**
 * Client configuration reaches the bundle through `define` — and no secret
 * does.
 *
 * The binding comes from the same project/environment resolver as the CLI.
 * Local workspaces use `ws://localhost:1234`; `WORKSPACES` can add entries to
 * the menu. Release builds skip this resolution and carry no machine values.
 *
 * `HUB_AUTH_TOKEN` is deliberately **not** among them (#426). The signing
 * secret is served at runtime in `/uberblick-config.json`, so it is a value of
 * the deployment rather than of the build: a bundle carries no credential, and
 * `packages/web/test/bundle-secret.test.ts` builds one and proves it. The dev
 * server serves that document from `dev-config-document.ts`, through the same
 * resolver and private credential store.
 *
 * The endpoint and workspaces are defaults, not the answer.
 * The client prefers the hub endpoint and the workspace list from the served
 * document and falls back to these only when none arrives. See src/config.ts.
 *
 * `__WORKSPACE_ID__` is the first of those workspaces: it answers one address,
 * `/`, which names no workspace. Every other address carries its own — a bundle
 * is not bound to a workspace, and no workspace at all means `/` says so rather
 * than guessing. `__WORKSPACES__` is `WORKSPACES`, the rest of the menu, comma
 * separated and empty by default because the ids are a uuid per machine.
 * Switching workspaces is navigating, so the list changes what is on the menu,
 * never which corpus an address opens. See src/ui/route.ts.
 *
 * A build writes one thing of its own beside the assets — the stamp naming the
 * sync protocol it speaks. That is output rather than configuration; see
 * {@link buildStampPlugin}.
 */

/**
 * What a build says about itself, for a server deciding whether to serve it.
 *
 * Contract, shared with `packages/cli/src/open.ts`: the file name and the
 * `syncProtocolVersion` in it. A bundle built before a `SYNC_PROTOCOL_VERSION`
 * bump sends an auth message the hub reads as unparseable and refuses, and the
 * page sits at `syncing…` with nothing naming the cause (#452) — so `ub open`
 * reads this and refuses to serve a bundle whose version is not its own.
 */
const BUILD_STAMP = "uberblick-build.json";

/**
 * Stamp the built bundle with the sync protocol version it speaks.
 *
 * A plugin rather than a `package.json` postbuild step because that would run
 * for one entrance only: `ub open` and `mise run build-web` shell out to
 * `pnpm --filter @uberblick/web build`, while the release payload invokes Vite
 * directly and `test/bundle-secret.test.ts` calls its `build()` API.
 * `generateBundle` is common to all four, so no build produces an unstamped
 * bundle — including the one the suite scans.
 *
 * The version is *imported* from the definition the client itself compiles in;
 * a second literal here is a copy that can disagree with the wire it describes.
 *
 * Through `runnerImport` rather than a plain `import`, because a plain one does
 * not work here: Vite bundles a config file but externalises every bare import
 * in it, so `@uberblick/hub/protocol` is handed to Node — which runs
 * TypeScript, but does not rewrite that module's own `./token.js` specifier to
 * `token.ts` the way every bundler in this repo does. `runnerImport` resolves
 * it with Vite's resolver, the one that already resolves the client's import of
 * the same module, in an environment scoped to this call: nothing else in the
 * process resolves differently for it, and a dev server never runs it at all.
 */
function buildStampPlugin(): Plugin {
  return {
    name: "uberblick:build-stamp",
    apply: "build",
    async generateBundle() {
      const { module } =
        await runnerImport<typeof import("@uberblick/hub/protocol")>("@uberblick/hub/protocol");
      this.emitFile({
        type: "asset",
        fileName: BUILD_STAMP,
        source: `${JSON.stringify({ syncProtocolVersion: module.SYNC_PROTOCOL_VERSION })}\n`,
      });
    },
  };
}

export default defineConfig(async (): Promise<UserConfig> => {
  // Skip machine files entirely for deployable bundles. Import through Vite's
  // runner for the same TypeScript/.js-specifier reason as the stamp above.
  const runtimeConfigOnly = process.env.UBERBLICK_RELEASE_WEB === "1";
  const { module: dev } = runtimeConfigOnly ? { module: null } :
    await runnerImport<typeof import("./dev-config-document.js")>(fileURLToPath(new URL("./dev-config-document.ts", import.meta.url)));
  const config = dev?.resolveDevProjectConfig();
  for (const warning of config?.warnings ?? []) console.error(warning);
  return {
    // Tailwind compiles `src/ui/tailwind.css` for shadcn and product UI utilities.
    // Web UI system keeps editor content in plain CSS; other legacy surfaces
    // migrate when next changed. Preflight is deliberately omitted so the
    // existing editor and unmigrated controls keep their defaults — see that file.
    plugins: [tailwindcss(), react(), ...(dev === null ? [] : [dev.devConfigDocumentPlugin()]), buildStampPlugin()],
    define: {
      __RUNTIME_CONFIG_ONLY__: JSON.stringify(runtimeConfigOnly),
      __HUB_URL__: JSON.stringify(config?.hubUrl ?? ""),
      __WORKSPACE_ID__: JSON.stringify(config?.workspaceId ?? ""),
      __WORKSPACES__: JSON.stringify(config?.workspaces.join(",") ?? ""),
    },
    server: {
      port: 5173,
    },
  };
});
