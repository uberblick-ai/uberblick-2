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
 */
import { register } from "tsx/esm/api";

register();
await import(new URL("../src/main.ts", import.meta.url).href);
