import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  importSeedDir,
  readSeedDocs,
} from "@uberblick/mcp-server";
import type { SeedDoc } from "@uberblick/mcp-server";
import { resolveMcpConfig } from "./budget.js";

export const TEMPLATE_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "templates",
);

export const STARTER_GROUP_NAME = "Überblick";

/** Fixed starter-layout identity, never derived from document metadata. */
export const STARTER_GROUP_ID = "57a27e40-0000-4000-8000-000000000001";

/**
 * Explicit pin order differs from readSeedDocs' filename sort. UUIDs come from
 * frontmatter; fail on a renamed template rather than silently losing its pin.
 */
const PIN_ORDER = ["welcome-to-uberblick.md", "how-to-use-it.md"];

function pinnedUuids(starters: SeedDoc[]): string[] {
  const byFile = new Map(starters.map((doc) => [doc.file, doc.uuid]));
  return PIN_ORDER.map((file) => {
    const uuid = byFile.get(file);
    if (uuid === undefined) {
      throw new Error(
        `templates/${file} is missing, and the starter pin order names it`,
      );
    }
    return uuid;
  });
}

/** Seed offline under the shared writer and seed locks before publishing a binding. */
export async function seedStarterDocs(
  env: NodeJS.ProcessEnv,
  config = resolveMcpConfig(env),
): Promise<void> {
  const starters = readSeedDocs(TEMPLATE_DIR);
  const { results, sidebar } = await importSeedDir(TEMPLATE_DIR, config, {
    id: STARTER_GROUP_ID,
    name: STARTER_GROUP_NAME,
    docs: pinnedUuids(starters),
  });
  if (!sidebar || results.length !== starters.length || results.some(result => result.action !== "created")) {
    throw new Error("starter documents and sidebar were not completely seeded");
  }
}
