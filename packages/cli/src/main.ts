import { runCli } from "./cli.js";
import { stopWhenDrained } from "./exit.js";
import { quietUnactionableWarnings } from "./warnings.js";

// Install the shared warning policy before either entry point writes output.
quietUnactionableWarnings();

// Drain buffered output before forcing exit for leftover handles such as stalled
// WebSockets. Commands must still close their own servers and signal handlers.
function stopWaiting(): void {
  stopWhenDrained([process.stdout, process.stderr], () => {
    process.exit(process.exitCode ?? 0);
  });
}

function fail(error: unknown): void {
  // stdout belongs to MCP frames on the serve path.
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`ub: ${message}\n`);
  process.exitCode = 1;
  // Failures can leave the same stalled handles as successful commands.
  stopWaiting();
}

runCli(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
  stopWaiting();
}, fail);
