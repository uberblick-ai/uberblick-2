/**
 * Every new workspace gets the shipped starter documents and one sidebar group.
 * Creation seeds offline under the shared writer and seed locks, then publishes
 * the project binding only after the complete layout is durable. A failed run
 * leaves its partial replica alone; the next create uses a fresh workspace id.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  importSeedDir,
  readSeedDocs,
} from "@uberblick/mcp-server";
import type { SeedDoc } from "@uberblick/mcp-server";
import { resolveMcpConfig } from "./budget.js";

/** `templates/` in this package — the only place the starter documents live. */
export const TEMPLATE_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "templates",
);

/** The sidebar group the starter documents are pinned into. */
export const STARTER_GROUP_NAME = "Überblick";

/**
 * Its id, fixed rather than generated — see the header. It is specific to the
 * starter layout and never derived from document metadata.
 */
export const STARTER_GROUP_ID = "57a27e40-0000-4000-8000-000000000001";

/**
 * The starter templates in reading order, which is also the pin order.
 *
 * `readSeedDocs` sorts by file name; the sidebar is ordered deliberately, so
 * this names the files rather than inferring the order from them. Identity
 * still lives in one place — the frontmatter — and a template renamed without
 * this list is a loud failure rather than a silently missing pin.
 */
const PIN_ORDER = ["welcome-to-uberblick.md", "how-to-use-it.md"];

/** The starter uuids in pin order. */
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

/** Seed a fresh workspace completely before its project binding is published. */
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
