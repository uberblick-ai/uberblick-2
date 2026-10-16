import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin, type UserConfig, runnerImport } from "vite";
import { fileURLToPath } from "node:url";

/**
 * Define endpoint/workspace fallbacks through the CLI's project resolver; never
 * compile a signing secret. Local defaults use loopback, WORKSPACES extends the
 * menu, and release builds read no machine values. Runtime config takes priority.
 * The first workspace answers `/`; other routes retain their explicit workspace,
 * and an empty configuration never guesses. See src/config.ts for the contract.
 */

/** Shared with ub open: this filename and syncProtocolVersion gate bundle compatibility. */
const BUILD_STAMP = "uberblick-build.json";

/** Resolve the retry URL through the bundler without preloading the renderer. */
function wireframeRendererUrlPlugin(): Plugin {
  const urlModule = fileURLToPath(new URL("./src/editor/wireframe-renderer-url.ts", import.meta.url));
  return {
    name: "uberblick:wireframe-renderer-url",
    apply: "build",
    async load(id) {
      if (id !== urlModule) return;
      const renderer = await this.resolve("@uberblick/wireframe", urlModule);
      if (renderer === null) throw new Error("Cannot resolve the wireframe renderer");
      const reference = this.emitFile({ type: "chunk", id: renderer.id, name: "wireframe-renderer", preserveSignature: "strict" });
      return `export default import.meta.ROLLUP_FILE_URL_${reference};`;
    },
  };
}

/**
 * generateBundle covers package builds, releases and Vite's build API; a
 * postbuild script would miss callers. Import the client's protocol constant,
 * never duplicate it. runnerImport resolves TypeScript .js specifiers through
 * Vite; plain config imports are externalized to Node and cannot resolve them.
 * Its resolver scope is local to this call; the plugin runs only on builds.
 */
function buildStampPlugin(contentSecurityPolicy: string): Plugin {
  return {
    name: "uberblick:build-stamp",
    apply: "build",
    async generateBundle() {
      const { module } =
        await runnerImport<typeof import("@uberblick/schema/protocol")>("@uberblick/schema/protocol");
      this.emitFile({
        type: "asset",
        fileName: BUILD_STAMP,
        source: `${JSON.stringify({ syncProtocolVersion: module.SYNC_PROTOCOL_VERSION })}\n`,
      });
      this.emitFile({
        type: "asset",
        fileName: "uberblick-csp.caddy",
        source: `header Content-Security-Policy ${JSON.stringify(contentSecurityPolicy)}\n`,
      });
    },
  };
}

export default defineConfig(async (): Promise<UserConfig> => {
  const { module: webPolicy } =
    await runnerImport<typeof import("@uberblick/schema/web-policy")>("@uberblick/schema/web-policy");
  // Deployable bundles skip machine files; the runner resolves TS .js imports.
  const runtimeConfigOnly = process.env.UBERBLICK_RELEASE_WEB === "1";
  const { module: dev } = runtimeConfigOnly ? { module: null } :
    await runnerImport<typeof import("./dev-config-document.js")>(fileURLToPath(new URL("./dev-config-document.ts", import.meta.url)));
  const config = dev?.resolveDevProjectConfig();
  const hubTarget = config === undefined ? undefined : new URL(config.hubUrl);
  for (const warning of config?.warnings ?? []) console.error(warning);
  return {
    // Omit Tailwind preflight to preserve editor and unmigrated control defaults.
    // Editor content remains plain CSS; see src/ui/tailwind.css.
    // The entry imports React's module preamble; its inline HTML preamble is blocked by script-src.
    plugins: [tailwindcss(), react().map((plugin) => ({ ...plugin, transformIndexHtml: undefined })), ...(dev === null ? [] : [dev.devConfigDocumentPlugin()]), buildStampPlugin(webPolicy.WEB_CONTENT_SECURITY_POLICY), wireframeRendererUrlPlugin()],
    define: {
      __RUNTIME_CONFIG_ONLY__: JSON.stringify(runtimeConfigOnly),
      __HUB_URL__: JSON.stringify(config?.hubUrl ?? ""),
      __WORKSPACE_ID__: JSON.stringify(config?.workspaceId ?? ""),
      __WORKSPACES__: JSON.stringify(config?.workspaces.join(",") ?? ""),
    },
    server: {
      port: 5173,
      headers: {
        "Content-Security-Policy": webPolicy.WEB_CONTENT_SECURITY_POLICY,
      },
      // Keep browser sync on the page's origin; CLI/MCP still dial the bound hub directly.
      proxy: hubTarget === undefined ? {} : {
        "/ws": { target: hubTarget.origin, ws: true, rewrite: () => hubTarget.pathname },
      },
    },
  };
});
