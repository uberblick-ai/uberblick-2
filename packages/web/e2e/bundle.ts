/** One run's app artifact; runtime configuration still belongs to each harness. */
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export interface AppBundle {
  directory: string;
  hubUrl: string;
  workspace: string;
}

export async function buildAppBundle(bundle: AppBundle): Promise<void> {
  await build({
    configFile: join(packageRoot, "vite.config.ts"),
    root: packageRoot,
    logLevel: "error",
    // fnox and callers may supply deployment values, including release mode.
    // Every fallback is run-owned; a served document remains authoritative.
    define: {
      __RUNTIME_CONFIG_ONLY__: "false",
      __HUB_URL__: JSON.stringify(bundle.hubUrl),
      __WORKSPACE_ID__: JSON.stringify(bundle.workspace),
      __WORKSPACES__: JSON.stringify(""),
    },
    build: { outDir: bundle.directory, emptyOutDir: true },
  });
}

/** Read inside hooks: Playwright collects files before global setup runs. */
export function sharedAppBundle(): AppBundle {
  const value = process.env.UBERBLICK_E2E_BUNDLE;
  if (value === undefined) throw new Error("e2e: shared app bundle is missing; run through Playwright's global setup");
  return JSON.parse(value) as AppBundle;
}
