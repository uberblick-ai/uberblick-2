/**
 * From the repository root, after `mise run install`:
 *   mise x -- fnox exec -- ub env -- pnpm --filter @uberblick/cli exec tsx test/observe-remote-join.ts 30
 *
 * Reads this machine's configured endpoint, workspace and credential. Refuses
 * UB_TEST_MAX_WAIT_MS: unset it for a like-for-like join preflight. JSONL on
 * stdout: budgets, every independent preflight (including raw socket events),
 * then the measured rate. No CLI extra retry is performed. A directory that
 * never settles is a failed preflight, separate from a failure to connect.
 *
 * Fresh HubSync per attempt; OS name resolution, tailnet routing and TLS
 * caches are not reset. It does not manufacture the reported first dial from
 * a just-upgraded machine with a cold tailnet path and TLS session. No join,
 * mirror, update log,
 * document rooms or awareness state; no config/credential writes. No error
 * messages, remote close reasons, headers, document titles or tokens printed.
 * Connection milestones are attempt-level, not assigned to a guessed dial.
 * DNS/TCP/TLS attribution requires a known native error code. A connected
 * transport without a WebSocket open places a stall in the upgrade. Otherwise
 * the stage remains unattributable, including auth/settle on an open socket.
 */
import { readFileSync } from "node:fs";
import { bridgeConfig, resolveMcpConfig } from "@uberblick/mcp-server";
import { resolveConfig } from "../src/config.js";
import { observePreflight } from "./remote-observation.js";

const print = (record: unknown) => process.stdout.write(`${JSON.stringify(record)}\n`);
function bytes(path: string): Buffer | null {
  try { return readFileSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
function same(before: Buffer | null, after: Buffer | null): boolean {
  return before === null ? after === null : after !== null && before.equals(after);
}

async function main(): Promise<void> {
  const attempts = Number(process.argv[2] ?? "30");
  if (process.argv.length > 3 || !Number.isInteger(attempts) || attempts < 1 || attempts > 1_000) {
    throw new Error("usage");
  }
  if (process.env.UB_TEST_MAX_WAIT_MS !== undefined) throw new Error("capped");
  const resolved = resolveConfig();
  const paths = [resolved.paths.userConfig, resolved.paths.credentials];
  const before = paths.map(bytes);
  const config = bridgeConfig(resolveMcpConfig(resolved.env));
  const url = new URL(config.hubUrl);
  if (!config.authSecret || !["ws:", "wss:"].includes(url.protocol) ||
    url.username || url.password || url.search || url.hash) throw new Error("configuration");
  // Only origin and validated UUID; never paths or URL credentials/queries.
  print({ kind: "measurement", attempts, node: process.version,
    platform: process.platform, architecture: process.arch,
    hubOrigin: url.origin, workspace: config.workspaceId,
    connectTimeoutMs: config.connectTimeoutMs, syncTimeoutMs: config.syncTimeoutMs,
    condition: "fresh observer; existing machine network state; no CLI retry" });
  let failures = 0;
  let connectionFailures = 0;
  let successes = 0;
  let unchanged = false;
  try {
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      // Own deadline: terminate this foreground harness if native cleanup hangs.
      const deadline = setTimeout(() => {
        print({ kind: "harness-timeout", attempt, stage: "unattributable" });
        process.exit(1);
      }, config.connectTimeoutMs + config.syncTimeoutMs + 5_000);
      try {
        const result = await observePreflight(config);
        print({ kind: "attempt", attempt, ...result });
        if (result.complete) successes += 1;
        else failures += 1;
        if (result.status === "hub-down" || result.status === "connecting") connectionFailures += 1;
      } finally { clearTimeout(deadline); }
    }
  } finally {
    const after = resolveConfig();
    unchanged = paths.every((path, index) => same(before[index] ?? null, bytes(path))) &&
      after.env.WORKSPACE_ID === resolved.env.WORKSPACE_ID &&
      after.env.HUB_URL === resolved.env.HUB_URL;
    print({ kind: "safety", bindingAndCredentialFilesUnchanged: unchanged });
  }
  if (!unchanged) throw new Error("changed");
  print({ kind: "summary", attempts, successes, failures, connectionFailures,
    connectionFailureRate: connectionFailures / attempts,
    reachableHubObserved: successes > 0,
    firstAttemptFailureReproduced: successes > 0 ? connectionFailures > 0 : null });
}

// A raw exception can contain a path, URL or wire text. Fixed local messages
// keep both streams safe, including configuration/credential reader failures.
main().catch(() => {
  process.stderr.write("Observation failed: require valid config and credential, an unset UB_TEST_MAX_WAIT_MS, and an attempt count from 1 to 1000. No raw error is printed.\n");
  process.exitCode = 1;
});
