import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAppBundle } from "./bundle.js";

/** Runs once even when Playwright selects only some files or projects. */
export default async function globalSetup(): Promise<() => Promise<void>> {
  const directory = mkdtempSync(join(tmpdir(), `uberblick-bundle-${process.env.UB_AGENTS_RUN ?? "local"}-`));
  // Reserve the compiled fallback for the entire run. Missing configuration
  // cannot dial a developer hub, including one started after this build.
  const fallback = createServer((socket) => socket.destroy());
  const cleanup = async (): Promise<void> => {
    try {
      if (fallback.listening) {
        await new Promise<void>((resolveClose, reject) => {
          fallback.close((error) => error === undefined ? resolveClose() : reject(error));
        });
      }
    } finally {
      delete process.env.UBERBLICK_E2E_BUNDLE;
      rmSync(directory, { recursive: true, force: true });
    }
  };
  // Never accept a caller's artifact, even if setup subsequently fails.
  delete process.env.UBERBLICK_E2E_BUNDLE;
  try {
    await new Promise<void>((resolveListen, reject) => {
      fallback.once("error", reject);
      fallback.listen(0, "127.0.0.1", resolveListen);
    });
    const address = fallback.address();
    if (address === null || typeof address === "string") throw new Error("e2e: fallback has no TCP address");
    const bundle = { directory, hubUrl: `ws://127.0.0.1:${address.port}`, workspace: `e2e-${randomUUID()}` };
    await buildAppBundle(bundle);
    process.env.UBERBLICK_E2E_BUNDLE = JSON.stringify(bundle);
    console.log("e2e: shared app bundle built once");
    return cleanup;
  } catch (error) {
    await cleanup().catch(() => {});
    throw error;
  }
}
