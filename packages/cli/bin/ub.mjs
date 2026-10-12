#!/usr/bin/env node
/**
 * The source-checkout entry needs tsx at runtime, supplied by devDependencies.
 * Resolve its loader from this file; a --import tsx shebang resolves against
 * the caller's directory and fails when ub is launched elsewhere.
 */
import { register } from "tsx/esm/api";

// Keep warning policy in main.ts so this shim and the compiled bundle agree.
register();
await import(new URL("../src/main.ts", import.meta.url).href);
