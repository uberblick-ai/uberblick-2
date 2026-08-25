/**
 * The v0 MCP tool set.
 *
 * Fifteen tools and no more: create_doc, get_doc, list_docs, search,
 * backlinks, edit_block, insert_block, delete_block, set_tags, set_links,
 * archive_doc, restore_doc, annotate, export_markdown, sync_status. There is
 * deliberately no whole-document write — every content change names one block
 * — no markdown-import tool, because markdown is an export format, and no hard
 * delete: archive_doc tombstones the directory stub and leaves every byte of
 * the document where it was.
 *
 * Every handler starts with `replicas.settle()`: replay the log tail (another
 * MCP instance may have written since the last call) and, on boot or after a
 * reconnect, wait briefly for the hub. Every mutating handler ends with
 * `{applied, synced}` plus the hub's state, because "applied locally" is not
 * "synced" and an agent deserves to know which one it got — and `synced` is not
 * "stored by the hub" either, which is why {@link SYNCED_MEANS} says so in the
 * tool descriptions rather than leaving the word to be read generously.
 *
 * All document reads and writes go through `@uberblick/schema`. That is not
 * politeness: the web editor destroys content outside its palette, and the
 * schema helpers are what keep this server inside it.
 */

import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  AnnotationRangeError,
  BLOCK_TYPES,
  BlockNotFoundError,
  StaleBlockError,
  addComment,
  appendBlock,
  createAnnotation,
  deleteBlock,
  editBlock,
  exportMarkdown,
  getBlock,
  getBlocks,
  getDirectoryEntry,
  getMeta,
  initDoc,
  insertBlock,
  listAnnotations,
  listDirectory,
  resolveAnnotationRange,
  restoreDirectoryEntry,
  setLinks,
  setTags,
  tombstoneDirectoryEntry,
  upsertDirectoryEntry,
} from "@uberblick/schema";
import type { Annotation, BlockInput, HeadingLevel } from "@uberblick/schema";
import { z } from "zod";
import { log } from "./log.js";
import { PersistenceError } from "./replica.js";
import type { Replica, Replicas } from "./replica.js";
import { collectSyncStatus } from "./status.js";

/** A tool failure with a stable machine-readable code. */
class ToolError extends Error {
  readonly code: string;

  readonly detail: Record<string, unknown>;

  constructor(
    code: string,
    message: string,
    detail: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ToolError";
    this.code = code;
    this.detail = detail;
  }
}

function json(payload: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
  };
}

function failure(payload: Record<string, unknown>): CallToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
  };
}

/**
 * Map a thrown error onto a tool failure.
 *
 * `StaleBlockError` is the interesting one: it comes back as the re-read
 * payload — `currentText` and `currentRev` — so a caller can re-diff and retry
 * without another round trip.
 */
function toFailure(error: unknown): CallToolResult {
  if (error instanceof PersistenceError) {
    // Fail-stop: every later call lands here too, until the server is restarted.
    return failure({
      error: "persistence_failed",
      message: error.message,
      room: error.room,
      applied: false,
      synced: false,
    });
  }
  if (error instanceof StaleBlockError) {
    return failure({
      error: "stale_block",
      message: error.message,
      blockId: error.blockId,
      expectedText: error.expectedText,
      expectedRev: error.expectedRev ?? null,
      currentText: error.currentText,
      currentRev: error.currentRev,
      retry: "re-diff against currentText and call edit_block again with currentRev",
    });
  }
  if (error instanceof BlockNotFoundError) {
    return failure({
      error: "block_not_found",
      message: error.message,
      blockId: error.blockId,
    });
  }
  if (error instanceof AnnotationRangeError) {
    return failure({
      error: "annotation_range",
      message: error.message,
      reason: error.reason,
      blockId: error.blockId,
      conflictingThreadId: error.conflictingThreadId ?? null,
    });
  }
  if (error instanceof ToolError) {
    return failure({ error: error.code, message: error.message, ...error.detail });
  }
  log.error("tool call failed", error);
  return failure({
    error: "internal_error",
    message: error instanceof Error ? error.message : String(error),
  });
}

/** Wrap a handler so every throw becomes a structured tool failure. */
function guarded<Args>(
  handler: (args: Args) => Promise<CallToolResult>,
): (args: Args) => Promise<CallToolResult> {
  return async (args: Args) => {
    try {
      return await handler(args);
    } catch (error) {
      return toFailure(error);
    }
  };
}

/**
 * The exact claim `synced: true` makes, in the words an agent reads.
 *
 * The hub acknowledges an update on receipt and only schedules the write, so an
 * acknowledged update is in the hub's memory, not on its disk. Narrowing the
 * word here is the honest fix: the hub cannot store per update, because its
 * SQLite extension writes the whole document state per store call.
 */
const SYNCED_MEANS =
  "`synced: true` means the hub acknowledged this update: it is in the hub's memory, and a healthy hub has " +
  "scheduled the write on its store debounce — by default 2s after the last change to the document, 10s at the " +
  "outside. It does NOT mean the hub has stored it: the write is still ahead of the hub's disk, and the store " +
  "itself can fail. A hub that dies abruptly inside that window (SIGKILL, a crash, power loss) loses its " +
  "volatile copy of the update. That is recoverable rather than fatal: `applied: true` is the durable half — " +
  "this server's append-only update log holds the write before the tool returns and re-sends it on reconnect — " +
  "so losing it for good takes the crash plus no replica holding that update ever coming back.";

/**
 * What concurrency does to an archive, in the words an agent reads.
 *
 * A directory stub is written whole, so two replicas disagreeing about one
 * document's fate converge on an update order rather than on an intent. Saying
 * so is cheaper than an agent inferring a guarantee that is not there.
 */
const ARCHIVE_IS_LAST_WRITE_WINS =
  "Concurrency: a directory entry is written as a whole object, so an archive_doc racing a restore_doc on another " +
  "replica converges on whichever update Yjs orders last — not on whichever call happened later by the clock. When it " +
  "matters which way it went, re-read with list_docs and `include_deleted: true`.";

/** The same narrowing for the mutators that do not restate it in full. */
const SYNCED_IS_ACKNOWLEDGED =
  "`synced` here means hub-acknowledged, not hub-stored — see sync_status for the exact claim and its crash window.";

// Identity is UUIDs, so the boundary checks for one. A tool that accepted any
// string would let an agent persist an identity nothing can ever resolve.
const uuidArg = z.uuid().describe("Document UUID.");

const linkArg = z
  .uuid("a link is a target document UUID, never a path or a title")
  .describe("Target document UUID.");

const blockShape = {
  type: z.enum([...BLOCK_TYPES]),
  text: z.string().optional(),
  level: z
    .number()
    .int()
    .min(1)
    .max(6)
    .optional()
    .describe("Heading level. Headings only."),
  language: z
    .string()
    .optional()
    .describe("Code language, e.g. \"ts\". Code blocks only."),
};

const blockInputSchema = z.object(blockShape);

function toBlockInput(input: z.infer<typeof blockInputSchema>): BlockInput {
  return {
    type: input.type,
    ...(input.text === undefined ? {} : { text: input.text }),
    ...(input.level === undefined
      ? {}
      : { level: input.level as HeadingLevel }),
    ...(input.language === undefined ? {} : { language: input.language }),
  };
}

export function registerTools(server: McpServer, replicas: Replicas): void {
  /**
   * Resolve a document, or fail with a hub-aware message: a uuid in the
   * directory whose room has not reached this replica yet is a different
   * problem from a uuid nobody has heard of, and saying which is more useful
   * than "not found".
   *
   * A uuid nobody has heard of must not be opened as a room: joining one would
   * create an empty document on the hub for what is almost certainly a typo.
   */
  const requireDoc = (uuid: string): Replica => {
    const stub = getDirectoryEntry(replicas.directory().doc, uuid);
    if (!replicas.known(uuid) && stub === null && !replicas.hasLog(uuid)) {
      throw new ToolError(
        "doc_not_found",
        `No document ${uuid} in workspace ${replicas.config.workspaceId}`,
        { uuid, inDirectory: false, hub: replicas.sync.state() },
      );
    }

    const replica = replicas.replica(uuid);
    if (getMeta(replica.doc).uuid !== "") {
      return replica;
    }
    throw new ToolError(
      "doc_not_hydrated",
      `Document ${uuid} is known but its room has not synced to this replica yet`,
      { uuid, inDirectory: stub !== null, hub: replicas.sync.state() },
    );
  };

  /**
   * What a mutating tool owes its caller: the write landed locally, and whether
   * it has reached the hub — which, right after a write, it has not.
   *
   * `synced` is "the hub acknowledged it", never "the hub stored it"; see
   * {@link SYNCED_MEANS} for the window that distinction leaves open.
   *
   * `assertHealthy` runs here, after the write: an append that failed during
   * *this* call must not be reported as applied. It throws, so the tool answers
   * with `persistence_failed` instead.
   */
  const durability = (replica: Replica): Record<string, unknown> => {
    replicas.assertHealthy();
    return {
      applied: true,
      synced: replicas.isRoomQuiet(replica.room),
      hub: replicas.sync.state(),
    };
  };

  const annotationJson = (
    replica: Replica,
    annotation: Annotation,
  ): Record<string, unknown> => ({
    ...annotation,
    range: resolveAnnotationRange(replica.doc, annotation.id),
  });

  server.registerTool(
    "create_doc",
    {
      title: "Create a document",
      description:
        "Create a document and publish its directory stub, so every client can discover it. " +
        "Blocks are optional: pass them to seed the document, or add them later with insert_block. " +
        "The write applies to the local replica and syncs in the background.\n\n" +
        SYNCED_MEANS,
      inputSchema: {
        title: z.string().describe("Display title. Identity is the returned UUID."),
        tags: z.array(z.string().min(1)).optional(),
        blocks: z
          .array(blockInputSchema)
          .optional()
          .describe("Initial blocks, in order."),
      },
    },
    guarded(async ({ title, tags, blocks }) => {
      await replicas.settle();

      const uuid = randomUUID();
      const replica = replicas.replica(uuid);
      initDoc(replica.doc, {
        uuid,
        title,
        ...(tags === undefined ? {} : { tags }),
      });
      for (const block of blocks ?? []) {
        appendBlock(replica.doc, toBlockInput(block));
      }

      // Observing the document's own update repairs the stub, but a brand-new
      // document must be discoverable because create_doc said so, not because
      // a side effect happened to fire.
      const directory = replicas.directory();
      if (getDirectoryEntry(directory.doc, uuid) === null) {
        upsertDirectoryEntry(directory.doc, {
          uuid,
          title,
          ...(tags === undefined ? {} : { tags }),
        });
      }

      return json({
        uuid,
        room: replica.room,
        title,
        tags: tags ?? [],
        blocks: getBlocks(replica.doc),
        ...durability(replica),
      });
    }),
  );

  server.registerTool(
    "get_doc",
    {
      title: "Read a document",
      description:
        "Read a document's metadata, its blocks and its annotation threads. " +
        "Every block carries a `rev` content hash — pass it back to edit_block to assert nothing changed since this read.",
      inputSchema: { uuid: uuidArg },
    },
    guarded(async ({ uuid }) => {
      await replicas.settle();
      const replica = requireDoc(uuid);
      const meta = getMeta(replica.doc);
      return json({
        ...meta,
        room: replica.room,
        blocks: getBlocks(replica.doc),
        annotations: listAnnotations(replica.doc).map((annotation) =>
          annotationJson(replica, annotation),
        ),
      });
    }),
  );

  server.registerTool(
    "list_docs",
    {
      title: "List documents",
      description:
        "Every document in the workspace, from the synced directory document — never from locally observed creations. " +
        "A fresh replica lists the whole corpus once the directory room has synced.",
      inputSchema: {
        tag: z.string().min(1).optional().describe("Only documents carrying this tag."),
        include_deleted: z.boolean().optional(),
      },
    },
    guarded(async ({ tag, include_deleted }) => {
      await replicas.settle();
      const entries = listDirectory(replicas.directory().doc, {
        includeDeleted: include_deleted ?? false,
      }).filter((entry) => tag === undefined || entry.tags.includes(tag));
      return json({
        workspace: replicas.config.workspaceId,
        docs: entries,
        hub: replicas.sync.state(),
      });
    }),
  );

  server.registerTool(
    "search",
    {
      title: "Search documents",
      description:
        "Full-text search over document titles and block text, from the local FTS5 index. " +
        "The index is derived from the replicas and updated as updates are observed, so it reflects edits from any client this replica has seen.",
      inputSchema: {
        query: z.string().min(1).describe("Words to match. A trailing * is a prefix match."),
        limit: z.number().int().min(1).max(100).optional(),
      },
    },
    guarded(async ({ query, limit }) => {
      await replicas.settle();
      return json({
        query,
        hits: replicas.store.search(query, limit ?? 20),
      });
    }),
  );

  server.registerTool(
    "backlinks",
    {
      title: "Documents linking here",
      description:
        "Documents whose `links` name this document. Links are by UUID, never by path or title.",
      inputSchema: { uuid: uuidArg },
    },
    guarded(async ({ uuid }) => {
      await replicas.settle();
      return json({ uuid, backlinks: replicas.store.backlinks(uuid) });
    }),
  );

  server.registerTool(
    "edit_block",
    {
      title: "Edit one block",
      description:
        "Replace one block's text by diff-and-splice: only the characters that actually changed are touched, " +
        "so a concurrent human edit elsewhere in the block survives and every formatting mark — inline " +
        "formatting and annotation anchors alike — stays put.\n\n" +
        "Plain text, both ways: `old_text` and `new_text` are the block's text with no markdown in it, the text " +
        "get_doc returns. Inline formatting is not spelled out there and cannot be changed here; spliced-in text " +
        "inherits the formatting of the character to its left, and `rev` ignores marks, so formatting a range " +
        "never makes a prepared edit stale.\n\n" +
        "Pass `old_text` (and the `rev` from get_doc) to assert what you are editing. If either is stale the edit is " +
        "refused and the error carries `currentText` and `currentRev` to re-diff against.\n\n" +
        "Scope of that guarantee, stated plainly: it is a check against THIS replica at the moment of the call. " +
        "There is no cross-replica compare-and-swap — an edit made elsewhere that has not reached this replica yet " +
        "cannot be detected, and the window widens the longer this server stays offline.\n\n" +
        SYNCED_MEANS,
      inputSchema: {
        uuid: uuidArg,
        block_id: z.string().min(1),
        old_text: z.string().describe("The block text you read. Asserted before the splice."),
        new_text: z.string(),
        rev: z
          .string()
          .min(1)
          .optional()
          .describe("The block's `rev` from get_doc. Asserted alongside old_text."),
      },
    },
    guarded(async ({ uuid, block_id, old_text, new_text, rev }) => {
      await replicas.settle();
      const replica = requireDoc(uuid);
      editBlock(replica.doc, block_id, old_text, new_text, {
        ...(rev === undefined ? {} : { rev }),
      });
      replicas.publishCursor(replica, block_id, new_text.length);
      return json({
        uuid,
        block: getBlock(replica.doc, block_id),
        ...durability(replica),
      });
    }),
  );

  server.registerTool(
    "insert_block",
    {
      title: "Insert a block",
      description:
        "Insert one block after `after_block_id`, or at the top of the document when it is omitted. " +
        "Block types are paragraph, heading, code and mermaid — the editor's whole palette.\n\n" +
        SYNCED_IS_ACKNOWLEDGED,
      inputSchema: {
        uuid: uuidArg,
        after_block_id: z
          .string()
          .min(1)
          .nullish()
          .describe("Insert after this block. Omit or null to insert first."),
        ...blockShape,
      },
    },
    guarded(async ({ uuid, after_block_id, type, text, level, language }) => {
      await replicas.settle();
      const replica = requireDoc(uuid);
      const blockId = insertBlock(
        replica.doc,
        after_block_id ?? null,
        toBlockInput({ type, text, level, language }),
      );
      replicas.publishCursor(replica, blockId, (text ?? "").length);
      return json({
        uuid,
        block: getBlock(replica.doc, blockId),
        ...durability(replica),
      });
    }),
  );

  server.registerTool(
    "delete_block",
    {
      title: "Delete a block",
      description:
        "Delete one block. Deleting is never how a block changes type — use insert_block plus edit_block only for new content, " +
        "and never delete-and-reinsert to re-type, which churns the block id and orphans its annotations.\n\n" +
        SYNCED_IS_ACKNOWLEDGED,
      inputSchema: { uuid: uuidArg, block_id: z.string().min(1) },
    },
    guarded(async ({ uuid, block_id }) => {
      await replicas.settle();
      const replica = requireDoc(uuid);
      deleteBlock(replica.doc, block_id);
      return json({ uuid, blockId: block_id, ...durability(replica) });
    }),
  );

  server.registerTool(
    "set_tags",
    {
      title: "Set a document's tags",
      description:
        "Replace the document's tag set. The directory stub is updated to match, so list_docs and tag filters follow.\n\n" +
        SYNCED_IS_ACKNOWLEDGED,
      inputSchema: { uuid: uuidArg, tags: z.array(z.string().min(1)) },
    },
    guarded(async ({ uuid, tags }) => {
      await replicas.settle();
      const replica = requireDoc(uuid);
      setTags(replica.doc, tags);
      return json({ uuid, tags, ...durability(replica) });
    }),
  );

  server.registerTool(
    "set_links",
    {
      title: "Set a document's outbound links",
      description:
        "Replace the document's outbound link set. Values are target document UUIDs — never paths, never titles. " +
        "The backlinks index follows immediately.\n\n" +
        SYNCED_IS_ACKNOWLEDGED,
      inputSchema: { uuid: uuidArg, links: z.array(linkArg) },
    },
    guarded(async ({ uuid, links }) => {
      await replicas.settle();
      const replica = requireDoc(uuid);
      setLinks(replica.doc, links);
      return json({ uuid, links, ...durability(replica) });
    }),
  );

  /**
   * Archiving and restoring both write the *directory*, not the document, so
   * both report durability for the directory room — that is the room whose
   * update has to reach the hub — and both re-derive the document's index rows
   * by hand, because a directory write does not run the document's observer.
   */
  server.registerTool(
    "archive_doc",
    {
      title: "Archive a document",
      description:
        "Hide a document: tombstones its directory stub, so it leaves list_docs, the web sidebar and the search index. " +
        "This is not erasure and not a delete. Every block, mark and annotation stays exactly where it was: get_doc still " +
        "serves the document by uuid, and list_docs with `include_deleted: true` still lists it, flagged `deleted`. " +
        "restore_doc is the way back. There is no tool that erases content, by design.\n\n" +
        ARCHIVE_IS_LAST_WRITE_WINS +
        "\n\n" +
        SYNCED_IS_ACKNOWLEDGED,
      inputSchema: { uuid: uuidArg },
    },
    guarded(async ({ uuid }) => {
      await replicas.settle();
      const replica = requireDoc(uuid);
      const directory = replicas.directory();
      tombstoneDirectoryEntry(directory.doc, uuid);
      replicas.reindex(replica);
      return json({
        uuid,
        title: getMeta(replica.doc).title,
        archived: true,
        ...durability(directory),
      });
    }),
  );

  server.registerTool(
    "restore_doc",
    {
      title: "Restore an archived document",
      description:
        "Lift a document's archive tombstone: it returns to list_docs, to the web sidebar and to the search index, its " +
        "title and tags brought back in line with the document's own metadata, which is what they are cached from. " +
        "The counterpart to archive_doc, and the only way back — a rename or a retag " +
        "deliberately cannot revive an archived document. Restoring one that was never archived leaves it as it is.\n\n" +
        ARCHIVE_IS_LAST_WRITE_WINS +
        "\n\n" +
        SYNCED_IS_ACKNOWLEDGED,
      inputSchema: { uuid: uuidArg },
    },
    guarded(async ({ uuid }) => {
      await replicas.settle();
      const replica = requireDoc(uuid);
      const directory = replicas.directory();
      restoreDirectoryEntry(directory.doc, uuid);
      replicas.reindex(replica);
      return json({
        uuid,
        title: getMeta(replica.doc).title,
        archived: false,
        ...durability(directory),
      });
    }),
  );

  server.registerTool(
    "annotate",
    {
      title: "Annotate a range, or comment on a thread",
      description:
        "Open an annotation thread over a range of a block's text, or — with `thread_id` — add a comment to an existing thread. " +
        "The range is anchored by a formatting mark on the text itself, so it survives edits, splits and re-types.\n\n" +
        SYNCED_IS_ACKNOWLEDGED,
      inputSchema: {
        uuid: uuidArg,
        text: z.string().min(1).describe("The comment body."),
        thread_id: z
          .string()
          .min(1)
          .optional()
          .describe("Comment on this existing thread instead of opening a new one."),
        block_id: z.string().min(1).optional().describe("Required for a new thread."),
        start: z.number().int().min(0).optional().describe("Range start, in characters."),
        end: z.number().int().min(0).optional().describe("Range end, exclusive."),
        author: z.string().min(1).optional(),
      },
    },
    guarded(async ({ uuid, text, thread_id, block_id, start, end, author }) => {
      await replicas.settle();
      const replica = requireDoc(uuid);
      const who = author ?? replicas.name;

      if (thread_id !== undefined) {
        const updated = addComment(replica.doc, thread_id, who, text);
        if (updated === null) {
          throw new ToolError(
            "thread_not_found",
            `No annotation thread ${thread_id} in document ${uuid}`,
            { uuid, threadId: thread_id },
          );
        }
        return json({
          uuid,
          annotation: annotationJson(replica, updated),
          ...durability(replica),
        });
      }

      if (block_id === undefined || start === undefined || end === undefined) {
        throw new ToolError(
          "invalid_arguments",
          "A new thread needs block_id, start and end; pass thread_id to comment on an existing one",
          { uuid },
        );
      }
      const created = createAnnotation(
        replica.doc,
        block_id,
        start,
        end,
        who,
        text,
      );
      return json({
        uuid,
        annotation: annotationJson(replica, created),
        ...durability(replica),
      });
    }),
  );

  server.registerTool(
    "export_markdown",
    {
      title: "Export a document as markdown",
      description:
        "Render the document as markdown, including fenced code and mermaid blocks. " +
        "Export only: markdown is never the storage format, and there is no import tool.",
      inputSchema: {
        uuid: uuidArg,
        frontmatter: z
          .boolean()
          .optional()
          .describe("Emit a YAML frontmatter block with uuid, title and tags. Default true."),
        annotations: z
          .enum(["html-comments", "drop"])
          .optional()
          .describe("How to render annotation threads. Default drop."),
      },
    },
    guarded(async ({ uuid, frontmatter, annotations }) => {
      await replicas.settle();
      const replica = requireDoc(uuid);
      return json({
        uuid,
        markdown: exportMarkdown(replica.doc, {
          ...(frontmatter === undefined ? {} : { frontmatter }),
          ...(annotations === undefined ? {} : { annotations }),
        }),
      });
    }),
  );

  server.registerTool(
    "sync_status",
    {
      title: "Sync status",
      description:
        "What this replica holds and what the hub has acknowledged.\n\n" +
        "`hub.status` distinguishes a hub that is down from a token the hub rejected — the first resolves itself, " +
        "the second needs a human — and `disabled` means no secret was configured, so this server is local-only.\n\n" +
        "The two counts here are in different units, so they are not expected to agree. `unsyncedChanges` counts " +
        "ROOMS, not updates: the rooms holding local changes the hub has not acknowledged, the ones `pendingRooms` " +
        "names. It is read from the durable pending set, so it survives a restart and is non-zero in local-only " +
        "mode: work that never left this machine is unsynced, whether or not a connection was ever attempted. " +
        "`inFlightUpdates` counts provider SYNC MESSAGES awaiting acknowledgement on the current connection, " +
        "which is not a count of Yjs updates: the provider merges a batch of updates into one message, counts a " +
        "message before it goes out, and resets the backlog to the single sync-handshake message on every " +
        "reconnect — so it can read 1 for a whole document's worth of unsent work. It is in memory and resets " +
        "with the connection. The web client's status line shows the same counter for the room it has open, " +
        "labelled `N sync messages unacked`.\n\n" +
        `${SYNCED_MEANS} The same holds for \`rooms[].synced\` below and for \`unsyncedChanges: 0\`: both are ` +
        "statements about acknowledgement, so a hub that dies inside the debounce comes back missing updates " +
        "this tool has already reported as synced, until a replica holding them reconnects and re-sends.\n\n" +
        "`persistence` is null unless an update failed to reach the log, in which case every other tool refuses " +
        "to serve until the server is restarted.",
      inputSchema: {},
    },
    // The same snapshot `ub status` prints — see ./status.ts. Diagnostics must
    // still answer when persistence has failed, which is exactly when someone
    // needs to know why every other tool stopped.
    guarded(async () => json(await collectSyncStatus(replicas))),
  );
}
