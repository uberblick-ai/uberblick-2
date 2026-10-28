import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { FullConfig } from "@playwright/test";

/** Global setup/teardown stdout does not reach Playwright reporters. */
export function recordRunTiming(config: FullConfig, purpose: string, durationMs: number): void {
  try {
    const directory = config.projects[0]?.outputDir ?? "test-results";
    mkdirSync(directory, { recursive: true });
    appendFileSync(join(directory, "shared-timings.jsonl"), `${JSON.stringify({ scope: "run", purpose, durationMs })}\n`);
  } catch (error) {
    console.warn(`Could not record shared Playwright timing: ${String(error)}`);
  }
}
