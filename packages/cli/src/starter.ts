/**
 * The starter corpus — the first-open state a brand-new workspace gets.
 *
 * A fresh workspace that is empty tells a new user nothing, so `ub init` writes
 * *Welcome to Überblick* (what this is) and *How to Use It* (the shortest path
 * to useful work) into it, and pins both into one sidebar group named
 * **Überblick**, in that reading order. They are ordinary documents from the
 * moment they land: no flag marks them, nothing special-cases them, and the
 * first edit, unpin or delete is the user's.
 *
 * The sidebar is part of the seed rather than a consequence of it. The web
 * client reads `<workspaceId>/_sidebar` directly and runs no migration, so a
 * workspace whose pins were only ever written by an MCP server's boot-time
 * migration opens differently depending on which client happened to start
 * first. Navigation is product state, and `ub init` owns creating it.
 *
 * Four properties hold this in place:
 *
 * 1. **The templates ship with this package.** `templates/` sits next to `src/`
 *    and the path below is resolved from this module, never from a checkout or
 *    a working directory — `ub init` outside the repository seeds the same two
 *    documents. `package.json`'s `files` array is what carries them into a
 *    published tarball.
 * 2. **The import machinery is package-private.** `importSeedDir` is the only
 *    markdown→blocks path there is, and these two templates are its only
 *    caller: no command imports a corpus, and no MCP tool reads markdown. One
 *    converter, one set of rules about identity — the frontmatter `uuid` is
 *    the document's identity, and a uuid already in the system is never written
 *    again. The sidebar group goes through the same call, the same replica set
 *    and the same update log, after both documents are durable — which is what
 *    makes the pins survive a machine where no MCP server has ever run.
 * 3. **The decision is read from the workspace, not from the run.** What gets
 *    seeded is decided by what this replica holds — which makes the seed
 *    repeatable rather than a one-shot. A run that fails after the first
 *    document (a full disk, a refused log) leaves the second one missing, and
 *    the next `ub init` finishes it, then the sidebar, because "what is
 *    missing" is asked again every time. The caller holds `ub init`'s lock
 *    across the whole of it, because a read that decides a write is only as
 *    good as the window between the two: without it, two first-time runs on one
 *    machine both read an empty workspace and both write the same documents
 *    into it.
 * 4. **Somebody else's workspace is never written into, and two guards say so
 *    at different distances.** The primary one is `maySeed` in `init.ts`:
 *    naming a workspace with `--workspace` is *joining* one that exists
 *    elsewhere, and this is not called at all for it. The reading below is the
 *    second, and it is local-only and therefore only ever about what this
 *    machine has downloaded. The authoritative one is inside `importSeedDir`,
 *    which settles first and refuses a hydrated directory naming anything but
 *    the starter documents — because a replica bound to a workspace it has
 *    never synced reads an empty directory here and would otherwise seed into a
 *    real corpus.
 * 5. **Curation is never undone.** The sidebar write refuses a sidebar that
 *    holds a group or carries the seed marker (see `seed.ts`), so an unpinned
 *    starter document stays unpinned, a reordered group stays reordered, and a
 *    deleted group stays deleted however often `ub init` is run afterwards.
 *
 * The group id is a fixed constant rather than a generated uuid, so two runs
 * that both seed write one group instead of two. #210 — concurrent creates of
 * one group id lose the loser's pins — does not bite here: every writer of this
 * id writes the same name and the same two pins, and `ub init`'s runs are
 * serialised on one machine by the seed lock, so the two sides are never
 * seeding from different state.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  importSeedDir,
  readSeedDocs,
  syncWorkspace,
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

/** What a seed did, and whether the hub has it. */
export interface StarterResult {
  /** Titles of the documents this run created. */
  created: string[];
  /**
   * Whether the hub has acknowledged everything this run wrote.
   *
   * True when there was nothing to write — a seed that wrote nothing has
   * nothing outstanding. False is not a failure of the write: it is durable in
   * the local update log either way. It is the answer to the one question
   * `ub init <hub-url>` promises, which is whether the hub holds the workspace
   * by the time the command returns.
   */
  synced: boolean;
}

/**
 * Write whatever the workspace `env` names is still missing of the starter
 * corpus — documents and sidebar group alike — and report the titles actually
 * created, with whether the hub acknowledged them. No title means no document
 * was written, which is the normal outcome of every run after the first.
 *
 * The workspace is read local-only first (the update log, no hub round trip),
 * because two questions have to be answered before anything is written: whether
 * the starter documents are already here, and whether anything *else* is. A
 * workspace holding other documents — one joined from a remote, one that
 * predates this feature — is left exactly as it is. This read is a fast path,
 * not the guarantee: `importSeedDir` asks the second question again once the
 * directory has hydrated, and refuses there. Read and write both happen under
 * the caller's init lock.
 *
 * A workspace already holding both documents still goes through the importer,
 * because the sidebar may be the part that is missing: an init interrupted
 * between the documents and the pins, or a workspace seeded before pinning
 * existed, is repaired by the next run. The importer writes nothing new for a
 * uuid it finds (beyond the set-once `createdAt` backfill on a stub that
 * predates timestamps), so the repair costs a hydration and changes no
 * document.
 *
 * That repair is deliberately invisible in the report. The returned titles are
 * documents *created*, and a run that only wrote the pins created none: what
 * `ub init` prints describes the workspace a user is about to open, and the
 * sidebar it names is there either way. Announcing a repair would be announcing
 * an implementation detail of a previous run's failure.
 *
 * Offline-first like every other write: the documents and the pins land in the
 * local update log whether or not a hub answers, and reach the hub when one
 * does.
 */
export async function seedStarterDocs(
  env: NodeJS.ProcessEnv,
  config = resolveMcpConfig(env),
): Promise<StarterResult> {
  const starters = readSeedDocs(TEMPLATE_DIR);
  const uuids = new Set(starters.map((doc) => doc.uuid));

  // Every directory stub, tombstoned ones included. A tombstone is what a
  // deleted document leaves behind, and it has to count on both sides of this:
  // an archived starter document is a document this workspace has had — writing
  // it again is not something a user asked for, and reading it as absent would
  // make every later `ub init` try, fail on the sticky tombstone, and say so
  // forever. An archived document that is not a starter is the same evidence
  // the live ones are: this workspace is somebody's already.
  const { deviceLogin: _deviceLogin, ...localConfig } = config;
  const stubs = (await syncWorkspace({ ...localConfig, authSecret: null }))
    .entries;
  const nothingToDo: StarterResult = { created: [], synced: true };
  if (stubs.some((stub) => !uuids.has(stub.uuid))) return nothingToDo;
  const known = new Set(stubs.map((stub) => stub.uuid));
  // Nothing left to write and nothing left to pin: every starter document is
  // here, and one of them is archived, so the sidebar has nothing to be
  // repaired to. Returning here is also what keeps the importer — and its
  // refusal to write over a tombstone — out of a run that has no work.
  const complete = starters.every((doc) => known.has(doc.uuid));
  if (complete && stubs.some((stub) => stub.deleted)) return nothingToDo;

  const { results, hub } = await importSeedDir(TEMPLATE_DIR, config, {
    id: STARTER_GROUP_ID,
    name: STARTER_GROUP_NAME,
    docs: pinnedUuids(starters),
  });
  return {
    created: results
      .filter((result) => result.action === "created")
      .map((result) => result.title),
    // Every room acknowledged, and the connection that acknowledged them still
    // standing. Both, because a per-room flag says nothing about a hub that was
    // never reached, and a connected hub says nothing about a room it has not
    // answered for yet.
    synced: hub === "connected" && results.every((result) => result.synced),
  };
}
