/**
 * The sync protocol version this bundle was built for, written beside it.
 *
 * A built bundle cannot say what it is: the version it speaks is a defaulted
 * parameter of `wrapToken`, so the minified asset inlines a bare integer with
 * nothing to anchor a search on. A bundle built before a
 * `SYNC_PROTOCOL_VERSION` bump therefore looks exactly like a current one,
 * sends an auth message this hub cannot read, and leaves the page at
 * `syncing…` with nothing naming the cause (#452).
 *
 * So the build states it: one small JSON file, emitted from the very constant
 * the client imports — never a second literal, never a copy under `public/`
 * that a bump would leave behind — which `ub open` reads before it serves
 * anything. It is emitted through the normal build, so every entrance produces
 * it: `mise run build-web`, the Dockerfile's `pnpm --filter @uberblick/web
 * build`, the one `ub open` shells out to, and the programmatic `build()` in
 * `test/bundle-secret.test.ts` that proves it is there.
 *
 * It discloses one small integer, and the hub already states that integer on
 * the wire to anyone who connects (`protocolMismatchReason`).
 */

import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";
import { runnerImport } from "vite";

/**
 * Contract, not detail: `packages/cli/src/open.ts` reads this name out of the
 * directory it is about to serve, and a deployment ships it with the bundle.
 */
export const BUILD_STAMP_FILE = "uberblick-build.json";

/**
 * The one `SYNC_PROTOCOL_VERSION`, read through Vite's own resolver.
 *
 * `src/collab/rooms.ts` imports `@uberblick/hub/protocol` directly and so would
 * this file — but a Vite config is loaded by **Node**, which cannot follow this
 * monorepo's TypeScript sources: `protocol.ts` reaches `token.ts` and
 * `@uberblick/schema` through `.js` specifiers that only a bundler resolves to
 * their `.ts` files. {@link runnerImport} is Vite resolving the same module the
 * app build resolves, which is what keeps this one definition rather than a
 * second number that a bump could leave behind.
 */
async function protocolVersion(): Promise<number> {
  // The web package, so the module is resolved from here rather than from
  // whatever directory the build was started in — and resolved *lazily*, since
  // `import.meta.url` is only a file URL when this module is loaded by Node.
  const root = fileURLToPath(new URL(".", import.meta.url));
  const { module } = await runnerImport<typeof import("@uberblick/hub/protocol")>(
    "@uberblick/hub/protocol",
    { configFile: false, logLevel: "error", root },
  );
  return module.SYNC_PROTOCOL_VERSION;
}

/** Emit {@link BUILD_STAMP_FILE} into the bundle directory. */
export function buildStampPlugin(): Plugin {
  return {
    name: "uberblick:build-stamp",
    apply: "build",
    async generateBundle() {
      const protocol = await protocolVersion();
      this.emitFile({
        type: "asset",
        fileName: BUILD_STAMP_FILE,
        source: `${JSON.stringify({ protocolVersion: protocol })}\n`,
      });
    },
  };
}
