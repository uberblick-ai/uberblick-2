import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestProject } from "vitest/node";

/** A suite-owned ancestor whose exact bytes must survive every worker. */
export default function setup(project: TestProject): () => void {
  const root = mkdtempSync(join(tmpdir(), "uberblick-cli-bound-"));
  const path = join(root, ".uberblick.json");
  const bytes = Buffer.from(`${JSON.stringify({ workspaceId: randomUUID(), hubUrl: null }, null, 2)}\n`);
  writeFileSync(path, bytes);
  project.provide("boundFixtureRoot", root);
  return () => {
    try {
      if (!readFileSync(path).equals(bytes)) {
        throw new Error("CLI suite changed its parent .uberblick.json; a fixture wrote an ancestor binding.");
      }
    } catch (error) {
      // Vitest logs global-teardown errors without failing an otherwise passing run.
      process.exitCode = 1;
      throw error;
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };
}
