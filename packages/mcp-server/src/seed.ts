/**
 * The one-time seed import: `docs-seed/*.md` → documents inside uberblick.
 *
 * This exists because of the dogfooding contract — the product's own docs live
 * in the product. It runs once; after it, `docs-seed/` is dead history and the
 * docs are edited through the MCP tools. Markdown is still export-only as a
 * *storage* rule: `importMarkdown` is the reader this import was built for, and
 * there is deliberately no import MCP tool.
 *
 * Four properties worth stating, because they are what the implementation is
 * shaped around:
 *
 * 1. **It writes through the same path the MCP tools do.** A {@link Replicas}
 *    set over the {@link MirrorStore}, so every update lands in the
 *    authoritative update log synchronously and reaches the hub the same way
 *    any tool's write does. Nothing here touches the derived index tables.
 * 2. **Identity comes from the file.** The frontmatter `uuid` is the idempotency
 *    key: it is what makes a re-run recognise a document it already wrote. A
 *    file without one is an error — the importer never invents identity.
 * 3. **A re-run of unchanged files writes nothing at all.** Every write is
 *    guarded by a comparison, so an unchanged re-run appends zero log entries.
 * 4. **Existing documents are reconciled in place, never replaced.** Blocks are
 *    matched positionally and updated with `editBlock`/`setBlockType`, so block
 *    ids — and the annotation anchors hanging off them — survive a re-import.
 * 5. **An unhydrated document is skipped, not created.** A uuid the directory
 *    knows whose room has not reached this replica is refused: writing it would
 *    put a second copy of every block into a room that already has one. The
 *    report says so and the command fails, which is the honest outcome — the
 *    alternative is a silently duplicated corpus.
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
  deleteBlock,
  editBlock,
  getBlockText,
  getBlocks,
  getDirectoryEntry,
  getMeta,
  importMarkdown,
  initDoc,
  setBlockLanguage,
  setBlockLevel,
  setBlockType,
  setLinks,
  setTags,
  setTitle,
  upsertDirectoryEntry,
} from "@uberblick/schema";
import type { BlockInput, ImportedBlock, ImportedDoc } from "@uberblick/schema";
import * as Y from "yjs";
import { log } from "./log.js";
import type { Replicas } from "./replica.js";

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

export type SeedAction = "created" | "updated" | "unchanged" | "skipped";

export interface SeedImport {
  file: string;
  uuid: string;
  title: string;
  room: string;
  action: SeedAction;
  blocks: number;
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

/** Set equality: neither a tag list nor a link list has meaningful order. */
function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const left = new Set(a);
  return b.every((value) => left.has(value));
}

function toBlockInput(block: ImportedBlock): BlockInput {
  return {
    type: block.type,
    text: block.text,
    ...(block.level === undefined ? {} : { level: block.level }),
    ...(block.language === undefined ? {} : { language: block.language }),
  };
}

/**
 * Bring the document's blocks in line with the file, matched by position.
 *
 * Positional matching is the honest choice for a seed import: the file has no
 * block ids to match on, and position is what the author's edit history looks
 * like. Every change goes through a sanctioned block-scoped write — `editBlock`
 * for text, `setBlockType` for a type change — so a block keeps its id and its
 * annotation anchors instead of being deleted and reinserted.
 *
 * Returns whether anything was written.
 */
function reconcileBlocks(doc: Y.Doc, want: ImportedBlock[]): boolean {
  const have = getBlocks(doc);
  let changed = false;

  const shared = Math.min(have.length, want.length);
  for (let i = 0; i < shared; i += 1) {
    const current = have[i];
    const target = want[i];
    if (current === undefined || target === undefined) continue;

    if (current.type !== target.type) {
      setBlockType(doc, current.id, target.type, {
        ...(target.level === undefined ? {} : { level: target.level }),
        ...(target.language === undefined ? {} : { language: target.language }),
      });
      changed = true;
    } else if (
      target.type === "heading" &&
      (current.level ?? 1) !== (target.level ?? 1)
    ) {
      setBlockLevel(doc, current.id, target.level ?? 1);
      changed = true;
    } else if (
      target.type === "code" &&
      (current.language ?? "") !== (target.language ?? "")
    ) {
      setBlockLanguage(doc, current.id, target.language ?? "");
      changed = true;
    }

    // Read the text back: a re-type replaced the element, and the file is the
    // intended state either way.
    const text = getBlockText(doc, current.id);
    if (text !== target.text) {
      editBlock(doc, current.id, text, target.text);
      changed = true;
    }
  }

  // Trailing blocks the file no longer has, back to front so the ids stay valid.
  for (let i = have.length - 1; i >= want.length; i -= 1) {
    const extra = have[i];
    if (extra === undefined) continue;
    deleteBlock(doc, extra.id);
    changed = true;
  }

  for (let i = have.length; i < want.length; i += 1) {
    const missing = want[i];
    if (missing === undefined) continue;
    appendBlock(doc, toBlockInput(missing));
    changed = true;
  }

  return changed;
}

function applySeed(
  replicas: Replicas,
  seed: SeedDoc,
): Omit<SeedImport, "synced"> {
  const replica = replicas.replica(seed.uuid);
  const doc = replica.doc;
  const links = seed.links ?? [];
  const directory = replicas.directory();
  const stub = getDirectoryEntry(directory.doc, seed.uuid);
  const identity = {
    file: seed.file,
    uuid: seed.uuid,
    title: seed.title,
    room: replica.room,
    blocks: seed.blocks.length,
  };

  // An empty `meta.uuid` is the one reliable "this document does not exist
  // yet" — the room is joined by uuid, so its name proves nothing.
  const fresh = getMeta(doc).uuid === "";

  // …unless the directory says otherwise. A live stub for an empty room means
  // the document exists somewhere and this replica has not received it, which is
  // the one case where writing does real damage: the blocks would merge into the
  // existing room as a second copy. Refuse, and let the report say why.
  if (fresh && stub !== null && stub.deleted !== true && replicas.sync.enabled) {
    log.warn(
      "skipping a seed document the directory knows but this replica has not received",
      { uuid: seed.uuid, file: seed.file, hub: replicas.sync.state().status },
    );
    return { ...identity, action: "skipped" };
  }

  let changed = fresh;

  if (fresh) {
    initDoc(doc, { uuid: seed.uuid, title: seed.title, tags: seed.tags });
  } else {
    const meta = getMeta(doc);
    if (meta.title !== seed.title) {
      setTitle(doc, seed.title);
      changed = true;
    }
    if (!sameSet(meta.tags, seed.tags)) {
      setTags(doc, seed.tags);
      changed = true;
    }
  }

  if (!sameSet(getMeta(doc).links, links)) {
    setLinks(doc, links);
    changed = true;
  }
  if (reconcileBlocks(doc, seed.blocks)) {
    changed = true;
  }

  // Discovery is a synced doc, so being discoverable is an explicit write here —
  // the way `create_doc` does it — not a side effect of having been observed.
  // A re-run therefore also repairs a stub that went missing.
  //
  // Re-read: observing this document's own updates already repaired the stub, so
  // the value from before the writes would provoke a pointless second write.
  const written = getDirectoryEntry(directory.doc, seed.uuid);
  if (written?.deleted === true) {
    // Tombstones are sticky by design: a late write must not resurrect a
    // deleted document. Say so rather than leaving a doc silently unlisted.
    log.warn("seed document is tombstoned in the directory, leaving it deleted", {
      uuid: seed.uuid,
      file: seed.file,
    });
  } else if (
    written === null ||
    written.title !== seed.title ||
    !sameSet(written.tags, seed.tags)
  ) {
    upsertDirectoryEntry(directory.doc, {
      uuid: seed.uuid,
      title: seed.title,
      tags: seed.tags,
    });
  }

  return {
    ...identity,
    action: fresh ? "created" : changed ? "updated" : "unchanged",
  };
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
 * Import (or re-import) every parsed seed document.
 *
 * The two-pass shape is the load-bearing part. Every target room is joined and
 * given a chance to sync *before* anything is written, because "does this
 * document already exist?" has to be asked of everything reachable, not just of
 * what this machine happens to have downloaded. Skipping that, a second machine
 * would find every seed document empty and append a second copy of its blocks
 * into the very same room — merging into a duplicated document.
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

  const results = docs.map((doc) => applySeed(replicas, doc));

  // The import is already durable — it is in the log. This only lets the report
  // tell the truth about what the hub has taken.
  await replicas.sync.waitForQuiet();

  return results.map((result) => ({
    ...result,
    synced: replicas.isRoomQuiet(result.room),
  }));
}
