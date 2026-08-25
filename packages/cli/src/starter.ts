/**
 * The starter corpus — the two documents a brand-new workspace opens with.
 *
 * A fresh workspace that is empty tells a new user nothing, so `ub init` writes
 * *Welcome* (what a document is, by example) and *Bring your docs in* (how to
 * connect an agent) into it. They are ordinary documents from the moment they
 * land: no flag marks them, nothing special-cases them, and the first edit or
 * delete is the user's.
 *
 * Three properties hold this in place:
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
 *    again.
 * 3. **The decision is read from the workspace, not from the run.** What gets
 *    seeded is decided by what this replica holds — which makes the seed
 *    repeatable rather than a one-shot. A run that fails after the first
 *    document (a full disk, a refused log) leaves the second one missing, and
 *    the next `ub init` finishes it, because "what is missing" is asked again
 *    every time. The same reading is what keeps the starter documents out of a
 *    workspace that is already somebody's: a corpus holding anything else is
 *    not one to write into.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  bridgeConfig,
  importSeedDir,
  liveDocs,
  readSeedDocs,
  resolveMcpConfig,
  syncWorkspace,
} from "@uberblick/mcp-server";

/** `templates/` in this package — the only place the starter documents live. */
export const TEMPLATE_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "templates",
);

/**
 * Write whatever the workspace `env` names is still missing of the starter
 * corpus, and report the titles actually created. Empty means nothing was
 * needed — which is the normal outcome of every run after the first.
 *
 * The workspace is read local-only first (the update log, no hub round trip),
 * because two questions have to be answered before anything is written: whether
 * the starter documents are already here, and whether anything *else* is. A
 * workspace holding other documents — one joined from a remote, one that
 * predates this feature — is left exactly as it is.
 *
 * Offline-first like every other write: the documents land in the local update
 * log whether or not a hub answers, and reach the hub when one does.
 */
export async function seedStarterDocs(
  env: NodeJS.ProcessEnv,
): Promise<string[]> {
  const config = resolveMcpConfig(env);
  const starters = readSeedDocs(TEMPLATE_DIR);
  const uuids = new Set(starters.map((doc) => doc.uuid));

  const held = liveDocs(
    await syncWorkspace(bridgeConfig(config, { authSecret: null })),
  );
  if (held.some((doc) => !uuids.has(doc.uuid))) return [];
  if (held.length === starters.length) return [];

  const { results } = await importSeedDir(TEMPLATE_DIR, config);
  return results
    .filter((result) => result.action === "created")
    .map((result) => result.title);
}
