/**
 * The starter corpus — the two documents a brand-new workspace opens with.
 *
 * A fresh workspace that is empty tells a new user nothing, so `ub init` writes
 * *Welcome* (what a document is, by example) and *Bring your docs in* (how to
 * connect an agent) into it. They are ordinary documents from the moment they
 * land: no flag marks them, nothing special-cases them, and the first edit or
 * delete is the user's.
 *
 * Two properties hold this in place:
 *
 * 1. **The templates ship with this package.** `templates/` sits next to `src/`
 *    and the path below is resolved from this module, never from a checkout or
 *    a working directory — `ub init` outside the repository seeds the same two
 *    documents. `package.json`'s `files` array is what carries them into a
 *    published tarball.
 * 2. **The import machinery is the existing one.** `importSeedDir` is the same
 *    markdown→blocks path `mise run import-seed` runs, so there is one
 *    converter and one set of rules about identity: the frontmatter `uuid` is
 *    the document's identity, and a uuid already in the system is never written
 *    again. Seeding twice cannot duplicate anything, which is the second lock
 *    on the caller's own "only for a workspace just created" guard.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { importSeedDir, resolveMcpConfig } from "@uberblick/mcp-server";

/** `templates/` in this package — the only place the starter documents live. */
export const TEMPLATE_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "templates",
);

/**
 * Write the starter documents into the workspace `env` names, and report the
 * titles of the ones that were actually created.
 *
 * Offline-first like every other write: the documents land in the local update
 * log whether or not a hub answers, and reach the hub when one does.
 */
export async function seedStarterDocs(
  env: NodeJS.ProcessEnv,
): Promise<string[]> {
  const { results } = await importSeedDir(TEMPLATE_DIR, resolveMcpConfig(env));
  return results
    .filter((result) => result.action === "created")
    .map((result) => result.title);
}
