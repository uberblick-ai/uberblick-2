/**
 * The one process warning nobody running `ub` can act on.
 *
 * lib0, reached through yjs, reads `localStorage` at import time, and Node then
 * warns that `--localstorage-file` was not passed. Nobody running `ub` can do
 * anything about it, and stderr is where *our* diagnostics go — including into
 * an MCP client's log — so this one warning is dropped and every other still
 * printed. Node prints warnings from its own listener, hence removing it first.
 *
 * It lives here, and is called from {@link module:./main}, so that both `ub`
 * entry points inherit it: the `bin/ub.mjs` shim a checkout ships, and the
 * built bundle the test suite spawns. A copy in each would be a copy that can
 * drift, and the drift would be invisible — a warning nobody sees.
 *
 * **Calling it after yjs has already been imported is not too late**, which is
 * why `main.ts` can hold it rather than the shim: `process.emitWarning` defers
 * to `process.nextTick`, so a listener installed anywhere in the same
 * synchronous module-graph evaluation still gets the warning first.
 */
export function quietUnactionableWarnings(): void {
  process.removeAllListeners("warning");
  process.on("warning", (warning) => {
    const noise =
      warning.name === "ExperimentalWarning" &&
      warning.message.includes("localStorage");
    if (!noise) {
      process.stderr.write(`${warning.name}: ${warning.message}\n`);
    }
  });
}
