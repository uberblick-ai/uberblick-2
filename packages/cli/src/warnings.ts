/**
 * lib0/Yjs reads localStorage at import time, causing Node's unactionable
 * --localstorage-file warning. Replace Node's printer to suppress only that
 * warning and preserve all others. emitWarning uses nextTick, so installing
 * this listener during the same module-graph evaluation still catches it.
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
