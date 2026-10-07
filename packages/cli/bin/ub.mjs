#!/usr/bin/env node
/**
 * `ub` — the entry point, in a checkout.
 *
 * Every package here runs from TypeScript source, so this shim registers tsx's
 * loader and then imports the CLI. That makes `tsx` load-bearing at run time
 * even though it is a devDependency: until distribution (#90) ships a build,
 * `ub` only ever runs inside a checkout where devDependencies are installed.
 *
 * A shim rather than a `#!/usr/bin/env -S node --import tsx` shebang on the
 * TypeScript file: `--import tsx` is resolved against the *caller's* working
 * directory, so it breaks the moment `ub` is run from somewhere else. The
 * import below is resolved against this file.
 *
 * Because `ub` runs straight from source, a `git pull` that adds a dependency
 * leaves the checkout runnable but its `node_modules` stale until the next
 * `pnpm install`. Node then fails with a bare ERR_MODULE_NOT_FOUND stack; the
 * catch below turns that one case into the instruction that fixes it.
 */

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

try {
  const { register } = await import("tsx/esm/api");
  // The stderr warning policy is not here but in `src/warnings.ts`, called by
  // `src/main.ts` — so this shim and the bundle the test suite builds cannot
  // drift apart on it. This file's own contract is the line below.
  register();
  await import(new URL("../src/main.ts", import.meta.url).href);
} catch (error) {
  const missing =
    error?.code === "ERR_MODULE_NOT_FOUND" && /Cannot find package '([^']+)'/.exec(error.message)?.[1];
  if (!missing) throw error;
  process.stderr.write(
    `ub: package '${missing}' is not installed; this checkout's dependencies are out of date.\n` +
      `Run \`pnpm install\` in ${resolve(fileURLToPath(import.meta.url), "../../../..")} and try again.\n`,
  );
  process.exit(1);
}
