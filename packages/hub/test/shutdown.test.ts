/**
 * The signal path, in the process that actually receives the signal.
 *
 * Everything else in this suite embeds `createHub` and calls `stop()` directly,
 * which proves the shutdown but not the wiring around it: `main.ts` reads the
 * environment, installs the handlers, and decides the exit code. A SIGTERM
 * arriving mid-debounce is the ordinary way this hub dies — a service manager
 * restarting it, a laptop closing — so it is worth spawning the real entry
 * point to see that the edit is on disk afterwards and that the process said
 * so with exit code 0.
 */

import { spawn, type ChildProcessByStdio } from "node:child_process";
import { once } from "node:events";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import {
  TEST_SECRET,
  acknowledged,
  createClient,
  removeTempDatabases,
  storedText,
  tempDatabasePath,
  testRoom,
  token,
  waitForText,
  type TestClient,
} from "./helpers.js";

const ENTRY_POINT = fileURLToPath(new URL("../src/main.ts", import.meta.url));

interface HubProcess {
  readonly child: ChildProcessByStdio<null, Readable, Readable>;
  /** The ephemeral port the hub bound, read back from its own startup log. */
  readonly port: number;
  /** Resolves with the exit code once the process is gone. */
  exit(signal: NodeJS.Signals): Promise<number | null>;
}

/**
 * Start `src/main.ts` the way `mise run hub` does — through tsx, configured by
 * the environment — and wait for the `hub.listen` line it logs to stderr.
 */
async function startHubProcess(databasePath: string): Promise<HubProcess> {
  const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), ENTRY_POINT], {
    // The private scratch root may be deep; relative Unix socket paths from
    // the database directory stay within the hub's existing length limit.
    cwd: dirname(databasePath), timeout: 15_000, killSignal: "SIGKILL",
    env: {
      ...process.env,
      HUB_AUTH_TOKEN: TEST_SECRET,
      HUB_DB_PATH: databasePath,
      HUB_HOST: "127.0.0.1",
      HUB_GITHUB_CLIENT_ID: "",
      PORT: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const port = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    let buffered = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      buffered += chunk;
      const lines = buffered.split("\n");
      // The last element is whatever has not been newline-terminated yet.
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("{")) {
          continue;
        }
        const record = JSON.parse(line) as { event?: string; port?: number };
        if (record.event === "hub.listen" && typeof record.port === "number") {
          resolve(record.port);
          return;
        }
      }
    });
    child.once("exit", (code) => {
      reject(new Error(`the hub exited before listening (code ${code})`));
    });
  });

  return {
    child,
    port,
    async exit(signal) {
      child.kill(signal);
      const [code] = (await once(child, "exit")) as [number | null];
      return code;
    },
  };
}

/** The hub's claim-state rows, read beside the running process. */
function claimRows(databasePath: string): Record<string, unknown>[] {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return database.prepare("SELECT * FROM hub_claim_state").all();
  } finally {
    database.close();
  }
}

const running: HubProcess[] = [];
const clients: TestClient[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) {
    client.destroy();
  }
  for (const hub of running.splice(0)) {
    if (hub.child.exitCode === null) {
      await hub.exit("SIGKILL");
    }
  }
  removeTempDatabases();
});

it("initializes a fresh hub, stores a debounced edit on SIGTERM and serves both after a restart", async () => {
  const databasePath = tempDatabasePath();
  const room = testRoom();

  const first = await startHubProcess(databasePath);
  running.push(first);

  // The standalone process configures sign-in by default. Collecting an
  // unknown request proves the wiring without starting a GitHub device flow.
  const collect = await fetch(`http://127.0.0.1:${first.port}/auth/github/collect`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      requestId: "00000000-0000-4000-8000-000000000001",
      collectionSecret: "x".repeat(43),
    }),
    signal: AbortSignal.timeout(3000),
  });
  expect(collect.status).toBe(404);
  expect(await collect.json()).toEqual({ status: "unknown-request" });

  // A fresh deployment initializes an empty hub, claimable, exactly once.
  const claimState = await fetch(`http://127.0.0.1:${first.port}/auth/claim-state`, {
    signal: AbortSignal.timeout(3000),
  });
  expect(await claimState.json()).toEqual({ unclaimed: true, canClaim: true });
  const initialized = claimRows(databasePath);
  expect(initialized).toHaveLength(1);
  expect(initialized[0]!.default_workspace_id).toEqual(expect.any(String));

  const writer = createClient({
    port: first.port,
    room,
    token: await token("read-write"),
  });
  clients.push(writer);
  await writer.synced;

  writer.text.insert(0, "written before SIGTERM");
  await acknowledged(writer);

  // The window this test exists for: the hub has the update, the default 2s
  // debounce has not fired, and the writer is still connected — so nothing has
  // stored the document. A hub that died here without flushing would lose it.
  expect(storedText(databasePath, room)).toBeNull();

  expect(await first.exit("SIGTERM")).toBe(0);
  writer.destroy();
  clients.length = 0;

  // Exit code 0 is the hub's claim that its state is durable. This is the claim
  // being checked, against the file, before anything is served from it again.
  expect(storedText(databasePath, room)).toBe("written before SIGTERM");

  const second = await startHubProcess(databasePath);
  running.push(second);

  const reader = createClient({
    port: second.port,
    room,
    token: await token("read-write"),
  });
  clients.push(reader);
  await reader.synced;
  await waitForText("the restarted hub", reader.text, "written before SIGTERM");
  // The replacement reuses the initialized state rather than starting over.
  expect(claimRows(databasePath)).toEqual(initialized);

  expect(await second.exit("SIGTERM")).toBe(0);
});
