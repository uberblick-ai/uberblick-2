/**
 * The one-time seed import: `docs-seed/*.md` → documents inside uberblick.
 *
 * This exists because of the dogfooding contract — the product's own docs live
 * in the product. It runs once; after it, `docs-seed/` is dead history and the
 * docs are edited through the MCP tools. Markdown is still export-only as a
 * *storage* rule: `importMarkdown` is the reader this import was built for, and
 * there is deliberately no import MCP tool.
 *
 * Five properties worth stating, because they are what the implementation is
 * shaped around:
 *
 * 1. **It writes through the same path the MCP tools do.** A {@link Replicas}
 *    set over the {@link MirrorStore}, so every update lands in the
 *    authoritative update log synchronously and reaches the hub the same way
 *    any tool's write does. Nothing here touches the derived index tables.
 * 2. **Identity comes from the file.** The frontmatter `uuid` is what makes a
 *    re-run recognise a document it already wrote. A file without one is an
 *    error — the importer never invents identity.
 * 3. **One-time by construction.** A uuid that already exists is never written
 *    again, not even when the file has changed. After the import the document
 *    belongs to whoever edits it through the MCP tools, and this importer cannot
 *    tell a legitimately edited seed file from a legitimately edited *document* —
 *    so it does not guess, and a re-run cannot clobber real work. Ongoing
 *    docs-seed sync is not a feature; the file is dead history.
 * 4. **A document it must not write is skipped, not written.** Two cases: a uuid
 *    the directory knows whose room has not reached this replica (writing it
 *    would put a second copy of every block into a room that already has one),
 *    and a uuid whose directory entry is tombstoned (a tombstone is sticky, so
 *    the document could never be listed again). Both report why and fail the
 *    command, which is the honest outcome.
 * 5. **A store that cannot log stops the run.** Health is asserted after every
 *    document and after the final wait, so a failing store can never let the
 *    import report success for writes the log refused.
 *
 * Offline-first like everything else: with no hub it imports into the local log
 * and the rooms stay pending until one appears. With a hub it waits for the
 * rooms to sync *before* deciding what exists, which is what keeps a second
 * machine's import from duplicating a corpus it has not downloaded yet.
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  appendBlock,
  getDirectoryEntry,
  getMeta,
  importMarkdown,
  initDoc,
  setLinks,
  upsertDirectoryEntry,
} from "@uberblick/schema";
import type { BlockInput, ImportedBlock, ImportedDoc } from "@uberblick/schema";
import type { McpConfig } from "./config.js";
import { log } from "./log.js";
import { Replicas } from "./replica.js";
import { MirrorStore } from "./store.js";

/** `docs-seed/` at the repo root — the only import source there is. */
export const SEED_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "docs-seed",
);

/** A parsed seed file: an {@link ImportedDoc} that is guaranteed to have identity. */
export interface SeedDoc extends ImportedDoc {
  uuid: string;
  /** The source file name, for reporting. Never part of the document. */
  file: string;
}

/**
 * What happened to one seed file.
 *
 * - `created` — the document did not exist and was written.
 * - `unchanged` — the uuid is already in the system, so nothing was written.
 *   This is the normal outcome of every run after the first, whatever the file
 *   says now.
 * - `skipped` — the importer refused, and `reason` says why. The command fails.
 */
export type SeedAction = "created" | "unchanged" | "skipped";

export interface SeedImport {
  file: string;
  uuid: string;
  title: string;
  room: string;
  action: SeedAction;
  blocks: number;
  /** Why the document was skipped. Null for every other action. */
  reason: string | null;
  /** Whether the hub has acknowledged this room's changes. */
  synced: boolean;
}

/**
 * Read and parse every seed file in `dir`, sorted by name. `README.md`
 * documents the format and is not a document.
 */
export function readSeedDocs(dir: string = SEED_DIR): SeedDoc[] {
  const files = readdirSync(dir)
    .filter((file) => file.endsWith(".md") && file !== "README.md")
    .sort();

  return files.map((file) => {
    const parsed = importMarkdown(readFileSync(join(dir, file), "utf8"));
    if (parsed.uuid === undefined) {
      throw new Error(
        `${file}: no \`uuid\` in frontmatter. Identity is UUIDs and the importer ` +
          `never invents one — a generated uuid would make every re-run a new document.`,
      );
    }
    if (parsed.title === "") {
      throw new Error(`${file}: no \`title\` in frontmatter`);
    }
    return { ...parsed, uuid: parsed.uuid, file };
  });
}

function toBlockInput(block: ImportedBlock): BlockInput {
  return {
    type: block.type,
    text: block.text,
    ...(block.level === undefined ? {} : { level: block.level }),
    ...(block.language === undefined ? {} : { language: block.language }),
    // The seed files are GFM, so their prose carries inline marks. Dropping
    // `inline` here would not just lose the formatting: `text` is the *resolved*
    // plain text, so the markup would be gone from the document entirely.
    ...(block.inline === undefined ? {} : { inline: block.inline }),
  };
}

function applySeed(
  replicas: Replicas,
  seed: SeedDoc,
): Omit<SeedImport, "synced"> {
  const replica = replicas.replica(seed.uuid);
  const doc = replica.doc;
  const directory = replicas.directory();
  const stub = getDirectoryEntry(directory.doc, seed.uuid);
  const identity = {
    file: seed.file,
    uuid: seed.uuid,
    title: seed.title,
    room: replica.room,
    blocks: seed.blocks.length,
  };
  const skip = (reason: string): Omit<SeedImport, "synced"> => {
    log.warn("skipping a seed document", {
      uuid: seed.uuid,
      file: seed.file,
      reason,
      hub: replicas.sync.state().status,
    });
    return { ...identity, action: "skipped", reason };
  };

  // A tombstone is sticky by design: upserting a deleted entry keeps it deleted,
  // so a document written here could never be listed again. Importing into that
  // is a conflict a human has to resolve, not something to do quietly.
  if (stub?.deleted === true) {
    return skip(
      "the directory entry is tombstoned, and a tombstone is sticky — this " +
        "document could never appear in list_docs again",
    );
  }

  // An empty `meta.uuid` is the one reliable "this document does not exist
  // yet" — the room is joined by uuid, so its name proves nothing.
  const hydrated = getMeta(doc).uuid !== "";

  // …but a live stub over an empty room means the document exists somewhere and
  // this replica has not received it, which is the case where writing does real
  // damage: the blocks would merge into the existing room as a second copy.
  if (!hydrated && stub !== null && replicas.sync.enabled) {
    return skip(
      "the directory names this document but its room has not reached this " +
        "replica, so writing it would duplicate every block",
    );
  }

  // Already imported, so this importer is done with it — whatever the file says
  // now. The document belongs to the MCP tools from here on, and a changed seed
  // file is indistinguishable from an edited document.
  if (hydrated) {
    return { ...identity, action: "unchanged", reason: null };
  }

  initDoc(doc, { uuid: seed.uuid, title: seed.title, tags: seed.tags });
  for (const block of seed.blocks) {
    appendBlock(doc, toBlockInput(block));
  }
  // A file that declares no links says nothing about links — it does not say
  // "no links". `initDoc` has already seeded an empty set, so writing one here
  // would only ever be a way to clear something.
  const links = seed.links ?? [];
  if (links.length > 0) {
    setLinks(doc, links);
  }

  // Discovery is a synced doc, so being discoverable is an explicit write here —
  // the way `create_doc` does it — not a side effect of having been observed.
  upsertDirectoryEntry(directory.doc, {
    uuid: seed.uuid,
    title: seed.title,
    tags: seed.tags,
  });

  return { ...identity, action: "created", reason: null };
}

/**
 * Links are UUIDs, so there is nothing to resolve — but a link to a uuid no
 * document has is a content bug worth naming. A warning, not an error: a seed
 * doc may legitimately cite something created outside the seed set.
 */
function warnOnDanglingLinks(replicas: Replicas, docs: SeedDoc[]): void {
  const known = new Set(docs.map((doc) => doc.uuid));
  for (const doc of docs) {
    for (const target of doc.links ?? []) {
      if (known.has(target)) continue;
      if (getDirectoryEntry(replicas.directory().doc, target) !== null) continue;
      log.warn("seed document links to a uuid no document has", {
        file: doc.file,
        uuid: doc.uuid,
        target,
      });
    }
  }
}

/**
 * Import every parsed seed document that is not already in the system.
 *
 * The two-pass shape is the load-bearing part. Every target room is joined and
 * given a chance to sync *before* anything is written, because "does this
 * document already exist?" has to be asked of everything reachable, not just of
 * what this machine happens to have downloaded. Skipping that, a second machine
 * would find every seed document empty and append a second copy of its blocks
 * into the very same room — merging into a duplicated document.
 *
 * @throws PersistenceError as soon as an update fails to reach the log. The log
 * is the authoritative replica, so a failed append leaves the document ahead of
 * the truth: continuing would pile more unlogged writes on top and let the run
 * report documents as imported that a restart will not bring back.
 */
export async function importSeedDocs(
  replicas: Replicas,
  docs: SeedDoc[],
): Promise<SeedImport[]> {
  await replicas.settle();

  for (const doc of docs) {
    replicas.replica(doc.uuid);
  }
  await replicas.sync.waitForQuiet();

  warnOnDanglingLinks(replicas, docs);

  const results: Omit<SeedImport, "synced">[] = [];
  for (const doc of docs) {
    results.push(applySeed(replicas, doc));
    // Checked per document, not once at the end: the first failed append is the
    // last honest moment. Stopping here leaves the documents already imported
    // intact and durable, and reports the failure instead of a false success.
    replicas.assertHealthy();
  }

  // The import is already durable — it is in the log. This only lets the report
  // tell the truth about what the hub has taken.
  await replicas.sync.waitForQuiet();
  // A remote update can fail to log while we wait, which poisons this replica
  // just as surely as one of our own writes would.
  replicas.assertHealthy();

  return results.map((result) => ({
    ...result,
    synced: replicas.isRoomQuiet(result.room),
  }));
}

/**
 * The whole import as one call: open a replica set for `config`, import every
 * markdown file in `dir`, close both handles again.
 *
 * The lifecycle is the reason this exists — a caller that is not a process
 * dedicated to importing (`ub init` seeding a new workspace's starter
 * documents) must not leave a SQLite handle and a hub connection open behind
 * it. `hub` is the sync layer's status at the end, reported after the replicas
 * are gone.
 */
export async function importSeedDir(
  dir: string,
  config: McpConfig,
): Promise<{ results: SeedImport[]; hub: string }> {
  const store = new MirrorStore(config.databasePath, config.workspaceId);
  const replicas = new Replicas(config, store);
  try {
    const results = await importSeedDocs(replicas, readSeedDocs(dir));
    return { results, hub: replicas.sync.state().status };
  } finally {
    replicas.destroy();
    store.close();
  }
}
