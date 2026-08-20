/**
 * `mise run import-seed` — the one-time seed import, as a process.
 *
 * Owns the process the way main.ts does: build the config from the environment,
 * open the store, run, report, exit. The import itself is ./seed.ts.
 *
 * Unlike the MCP server this is a CLI and not a stdio transport, so its report
 * goes to stdout where a human expects it; diagnostics still go to stderr
 * through ./log.ts.
 */

import { resolveMcpConfig } from "./config.js";
import { log } from "./log.js";
import { Replicas } from "./replica.js";
import { MirrorStore } from "./store.js";
import { importSeedDocs, readSeedDocs } from "./seed.js";
import type { SeedImport } from "./seed.js";

/** Whether every document is accounted for. Skips mean it is not. */
function report(results: SeedImport[], hub: string): boolean {
  const counts = { created: 0, unchanged: 0, skipped: 0 };
  for (const result of results) {
    counts[result.action] += 1;
    const sync = result.synced ? "synced" : "local only";
    process.stdout.write(
      `${result.action.padEnd(9)} ${result.uuid}  ${result.blocks
        .toString()
        .padStart(3)} blocks  ${sync}  ${result.file}\n`,
    );
    if (result.reason !== null) {
      process.stdout.write(`          ↳ ${result.reason}\n`);
    }
  }
  process.stdout.write(
    `\n${results.length} seed documents: ${counts.created} created, ` +
      `${counts.unchanged} already present, ${counts.skipped} skipped. ` +
      `Hub: ${hub}.\n`,
  );
  if (results.some((result) => !result.synced)) {
    process.stdout.write(
      "Some rooms have not reached the hub. The import is durable in the local " +
        "update log and those rooms stay pending until a hub is reachable.\n",
    );
  }
  if (counts.skipped > 0) {
    process.stdout.write(
      "Skipped documents were not written, because writing them would have " +
        "duplicated blocks or created a document nothing can list. Resolve the " +
        "reason above, then run this again.\n",
    );
  }
  return counts.skipped === 0;
}

async function main(): Promise<void> {
  const config = resolveMcpConfig();
  const store = new MirrorStore(config.databasePath);
  const replicas = new Replicas(config, store);

  try {
    const docs = readSeedDocs();
    const results = await importSeedDocs(replicas, docs);
    if (!report(results, replicas.sync.state().status)) {
      process.exitCode = 1;
    }
  } finally {
    replicas.destroy();
    store.close();
  }
}

main().catch((error: unknown) => {
  log.error("the seed import failed", error);
  process.exit(1);
});
