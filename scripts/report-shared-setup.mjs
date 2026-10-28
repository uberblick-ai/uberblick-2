import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

export async function measureSharedSetup(name, phase, work) {
  const started = performance.now();
  try { return await work(); }
  finally {
    if (process.env.GITHUB_ACTIONS === "true" && process.env.RUNNER_TEMP) {
      try {
        const directory = join(process.env.RUNNER_TEMP, "vitest-results");
        mkdirSync(directory, { recursive: true });
        appendFileSync(join(directory, "shared-setup.jsonl"), `${JSON.stringify({
          name, phase, durationMs: performance.now() - started,
        })}\n`);
      } catch (error) { console.warn(`Could not collect shared setup timing for ${name}: ${error.message}`); }
    }
  }
}
