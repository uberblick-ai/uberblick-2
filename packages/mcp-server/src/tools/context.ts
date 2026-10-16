import {
  decisionApprovalChanged,
  decisionApprovalFingerprint,
  decisionContentLocked,
  decisionRelations,
  decisionTopicArchived,
  getBlocksWithInline,
  getDirectoryEntry,
  isDirectoryEntryDeleted,
  getMeta,
  getMetaMap,
  isProseBlockType,
  parseTableCell,
  parseTableInput,
  parseCardInput,
  parseFigmaInput,
  parseInline,
  CARD_PARTS,
  readDirectoryTags,
  readDocumentTags,
  resolveAnnotationRange,
} from "@uberblick/schema";
import type {
  Annotation,
  BlockInput,
  DecisionTopicResolution,
  DirectoryEntry,
  HeadingLevel,
  InlineMarkSet,
  InlineRun,
  TableMapping,
} from "@uberblick/schema";
import type { z } from "zod";
import {
  ToolError,
  hydrationRecovery,
} from "../failures.js";
import type { GuidanceBriefing } from "../briefing.js";
import { docLinkRanges } from "../replica.js";
import type { Replica, Replicas } from "../replica.js";
import type { ServerWork } from "../server-work.js";
import { HelpCatalog } from "../help.js";
import { activeTagCatalog } from "../tag-catalog.js";
import { TLDR_AFTER_CONTENT_CHANGE } from "./descriptions.js";
import type { DecisionAnswer, blockInputSchema, inlineArg } from "./schemas.js";

/** The one-line prompt a mutating tool carries when a document has none. */
const DESCRIPTION_NUDGE =
  "This document has no description: call set_metadata with `description`: one or two sentences saying what it is for, so " +
  "list_docs and search can answer for it without anyone opening it.";

/** The one-line prompt a mutating tool carries when a document has no tags. */
const TAG_NUDGE =
  "This document has no tag assignments: call list_tags for the active workspace vocabulary, then call set_metadata " +
  "with `tags` to assign one or more tags.";

/** The stronger prompt returned when a changed document has no summary yet. */
const TLDR_MISSING_NUDGE =
  "This content change left the document without a TL;DR: call set_metadata with `tldr`: one or two sentences of plain " +
  "English for a person opening it.";

/**
 * Only true flags are model marks; omit false and undefined input properties.
 */
function inlineMarks(
  marks: NonNullable<z.infer<typeof inlineArg>>[number]["marks"],
): InlineMarkSet {
  return {
    ...(marks.bold === true ? { bold: true } : {}),
    ...(marks.italic === true ? { italic: true } : {}),
    ...(marks.strike === true ? { strike: true } : {}),
    ...(marks.inlineCode === true ? { inlineCode: true } : {}),
    ...(marks.link === undefined ? {} : { link: marks.link }),
    ...(marks.docLink === undefined ? {} : { docLink: marks.docLink }),
  };
}

/**
 * Inline runs must already be resolved; target refusals must precede all writes.
 */
function toBlockInput(
  input: z.infer<typeof blockInputSchema>,
  inline?: InlineRun[],
): BlockInput {
  return {
    type: input.type,
    ...(input.text === undefined ? {} : { text: input.text }),
    ...(input.level === undefined
      ? {}
      : { level: input.level as HeadingLevel }),
    ...(input.language === undefined ? {} : { language: input.language }),
    ...(inline === undefined ? {} : { inline }),
  };
}

/** Shared per-server helpers; each closure keeps the registering replica and briefing. */
// biome-ignore lint/complexity/noExcessiveLinesPerFunction: This function predates the length limit.
export function createToolContext(replicas: Replicas, briefing: GuidanceBriefing, work: ServerWork, help = new HelpCatalog()) {

  /** One refusal builder; callers retain their original message and identity field. */
  const notKnownLocally = (
    uuid: string,
    source: "document" | "directory" | "doclink",
  ): ToolError => {
    const doclink = source === "doclink";
    return new ToolError(
      doclink ? "doclink_target_not_known_locally" : "doc_not_found",
      `No document ${uuid} in ${source === "document" ? "" : "the directory of "}workspace ${replicas.config.workspaceId}` +
        (doclink ? ", so an inline reference to it would point at nothing this replica can resolve" : ""),
      {
        ...(doclink ? { docId: uuid } : { uuid }),
        inDirectory: false,
        hub: replicas.sync.state(),
      },
    );
  };

  const requireNotDeleted = (uuid: string): void => {
    if (isDirectoryEntryDeleted(replicas.directory().doc, uuid)) {
      throw new ToolError("doc_deleted", `Document ${uuid} was permanently deleted`, { uuid });
    }
  };

  /**
   * Refuse unknown UUIDs before joining a room: a typo would create an empty
   * document on the hub. Known but unhydrated rooms get a separate refusal.
   */
  const requireDoc = (uuid: string): Replica => {
    requireNotDeleted(uuid);
    const stub = getDirectoryEntry(replicas.directory().doc, uuid);
    if (!replicas.known(uuid) && stub === null && !replicas.hasLog(uuid)) {
      throw notKnownLocally(uuid, "document");
    }

    const replica = replicas.replica(uuid);
    if (getMeta(replica.doc).uuid !== "") {
      // Touch only tools that access the document room; directory/index reads
      // and archive/restore do not announce document activity.
      replicas.touch(replica);
      return replica;
    }
    const hub = replicas.sync.state();
    throw new ToolError(
      "doc_not_hydrated",
      `Document ${uuid} is known but its room has not synced to this replica yet`,
      {
        uuid,
        inDirectory: stub !== null,
        hub,
        ...hydrationRecovery(hub.status),
      },
    );
  };

  /**
   * Archive/restore need only a directory stub; archived rooms may never attach.
   * Refuse unknown UUIDs to avoid publishing sticky tombstones for typos.
   */
  const requireStub = (uuid: string): DirectoryEntry => {
    requireNotDeleted(uuid);
    const stub = getDirectoryEntry(replicas.directory().doc, uuid);
    if (stub === null) {
      throw notKnownLocally(uuid, "directory");
    }
    return stub;
  };

  /**
   * Check archive state before hydration so detached archived rooms say restore.
   * Only content mutators request the decided-record lock. These checks use
   * local state at call time; they do not lock out concurrent remote edits.
   */
  const requireWritableDoc = (uuid: string, contentMutation = false): Replica => {
    requireNotDeleted(uuid);
    if (decisionTopicArchived(replicas.directory().doc, uuid)) {
      throw new ToolError(
        "doc_archived",
        `Document ${uuid} is archived — restore_doc to edit`,
        { uuid, archived: true },
      );
    }
    const replica = requireDoc(uuid);
    const meta = getMeta(replica.doc);
    if (contentMutation && decisionContentLocked(meta)) {
      throw new ToolError("decision_read_only", "A decided record's title, answer blocks and structured data are read-only; decisions have no TL;DR. Create a superseding record.", { uuid, kind: meta.kind, status: meta.status });
    }
    return replica;
  };

  const recordAnswer = (replica: Replica, answer: DecisionAnswer): void => {
    const meta = getMetaMap(replica.doc);
    meta.set("decidedBy", answer.who);
    meta.set("decidedAt", answer.when);
    meta.set("decidedWhere", answer.where);
    meta.set("agentStance", false);
    meta.set("approvalFingerprint", decisionApprovalFingerprint(replica.doc));
  };

  const decisionAuthorityJson = (replica: Replica) => {
    const meta = getMeta(replica.doc);
    if (meta.kind !== "decision") return {};
    return {
      ...(meta.agentStance === undefined ? {} : { agentStance: meta.agentStance }),
      ...(meta.decidedBy === undefined ? {} : { decidedBy: meta.decidedBy }),
      ...(meta.decidedAt === undefined ? {} : { decidedAt: meta.decidedAt }),
      ...(meta.decidedWhere === undefined ? {} : { decidedWhere: meta.decidedWhere }),
      ...(meta.rejectionReason === undefined ? {} : { rejectionReason: meta.rejectionReason }),
      approvalChanged: decisionApprovalChanged(replica.doc),
    };
  };

  /**
   * Prefer hydrated metadata over the directory's cached title.
   */
  const titleFor = (uuid: string, stub: DirectoryEntry): string =>
    replicas.hydrated(uuid)
      ? getMeta(replicas.replica(uuid).doc).title
      : stub.title;

  /** The settings doc is the one catalog authority every tag path resolves. */
  const tagCatalog = () => replicas.settings().doc;

  /** Normalize directory descriptions and resolve tags through the settings catalog. */
  const decisionEntryJson = (entry: DirectoryEntry) => ({
    ...entry, tags: readDirectoryTags(entry, tagCatalog()),
    ...(entry.kind === "decision" ? { deleted: decisionTopicArchived(replicas.directory().doc, entry.uuid) } : {}),
    description: entry.description ?? null,
  });

  const topicJson = (topic: DecisionTopicResolution) => ({
    topic: topic.topic,
    inForce: topic.inForce === null ? null : decisionEntryJson(topic.inForce),
    pending: topic.pending.map(decisionEntryJson),
    conflicts: topic.conflicts.map(decisionEntryJson),
    archived: topic.archived,
  });

  const decisionReadJson = (uuid: string) => {
    const { predecessors, successors, resolution } = decisionRelations(replicas.directory().doc, uuid);
    return {
      predecessors: predecessors.map(decisionEntryJson),
      successors: successors.map(decisionEntryJson),
      resolution: resolution === null ? null : { ...decisionEntryJson(resolution.representative), ...topicJson(resolution) },
    };
  };

  const documentTags = (replica: Replica) =>
    readDocumentTags(replica.doc, tagCatalog());

  /**
   * Local absence is not global absence; retain the doclink-specific refusal
   * and hub state. Archived targets still resolve through their stubs.
   */
  const linkTitle = (docId: string): string => {
    requireNotDeleted(docId);
    const stub = getDirectoryEntry(replicas.directory().doc, docId);
    if (stub === null) {
      throw notKnownLocally(docId, "doclink");
    }
    return titleFor(docId, stub);
  };

  /**
   * Resolve labels before writing: use the target's current title, fixed when
   * linked. Fall back to its UUID if empty, since applyInlineRuns drops empty runs.
   */
  const resolveInline = (
    runs: z.infer<typeof inlineArg>,
  ): InlineRun[] | undefined =>
    runs?.map((run) => {
      const marks = inlineMarks(run.marks);
      const docId = marks.docLink;
      if (docId === undefined) return { text: run.text, marks };
      // Validate targets even when the caller supplies a label.
      const title = linkTitle(docId);
      if (run.text !== "") return { text: run.text, marks };
      return { text: title === "" ? docId : title, marks };
    });

  /** Check newly written targets; surviving cells may already hold unresolved links. */
  const validateTableTargets = (source: string, previous?: string, mapping?: TableMapping): void => {
    const table = parseTableInput(source);
    const oldTable = previous === undefined ? undefined : parseTableInput(previous);
    const oldCells = oldTable === undefined ? [] : [oldTable.header, ...oldTable.rows];
    for (const [row, cells] of [table.header, ...table.rows].entries()) {
      for (const [column, cell] of cells.entries()) {
        const oldRow = mapping === undefined ? row : mapping.rows[row];
        const oldColumn = mapping === undefined ? column : mapping.columns[column];
        const oldCell = oldRow == null || oldColumn == null ? undefined : oldCells[oldRow]?.[oldColumn];
        if (oldCell === cell) continue;
        const oldTargets = new Set(parseTableCell(oldCell ?? "").map(run => run.marks.docLink));
        for (const run of parseTableCell(cell)) {
          if (run.marks.docLink !== undefined && !oldTargets.has(run.marks.docLink)) linkTitle(run.marks.docLink);
        }
      }
    }
  };

  /** Existing targets in a part survive even when this replica no longer knows them. */
  const validateCardTargets = (source: string, previous?: string): void => {
    const card = parseCardInput(source);
    const oldCard = previous === undefined ? undefined : parseCardInput(previous, false);
    for (const part of CARD_PARTS) {
      if (card[part] === oldCard?.[part]) continue;
      const oldTargets = new Set(parseInline(oldCard?.[part] ?? "").map(run => run.marks.docLink));
      for (const run of parseInline(card[part])) {
        if (run.marks.docLink !== undefined && !oldTargets.has(run.marks.docLink)) linkTitle(run.marks.docLink);
      }
    }
  };

  /** New caption links must resolve locally; existing targets survive header edits. */
  const validateFigmaTargets = (source: string, previous?: string): void => {
    const figma = parseFigmaInput(source);
    const oldFigma = previous === undefined ? undefined : parseFigmaInput(previous);
    if (figma.caption === oldFigma?.caption) return;
    const oldTargets = new Set(parseInline(oldFigma?.caption ?? "").map(run => run.marks.docLink));
    for (const run of parseInline(figma.caption)) {
      if (run.marks.docLink !== undefined && !oldTargets.has(run.marks.docLink)) linkTitle(run.marks.docLink);
    }
  };

  /**
   * Resolve `inline` only for prose; source blocks ignore it, and tables read
   * their cell marks from GFM. Validate all seeds before create_doc opens a room.
   */
  const blockInputFor = (
    block: z.infer<typeof blockInputSchema>,
  ): BlockInput => {
    // A bad later seed must not leave earlier blocks or metadata behind.
    if (block.type === "table") validateTableTargets(block.text ?? "");
    if (block.type === "card") validateCardTargets(block.text ?? "");
    if (block.type === "figma") validateFigmaTargets(block.text ?? "");
    return toBlockInput(
      block,
      isProseBlockType(block.type) ? resolveInline(block.inline) : undefined,
    );
  };

  /**
   * doc_links exposes prose ranges; table links stay in GFM text and its rev.
   */
  const blocksJson = (replica: Replica): Record<string, unknown>[] =>
    getBlocksWithInline(replica.doc).map(({ block, inline }) => {
      const links = docLinkRanges(block, inline);
      return { ...block, ...(links.length === 0 ? {} : { doc_links: links }) };
    });

  /**
   * create_doc requires a description, but existing documents may lack one.
   * All document writes nudge without refusing; workspace-owned rooms are exempt.
   */
  const descriptionGap = (replica: Replica): Record<string, unknown> => {
    if (replica.isDirectory || replica.isSidebar || replica.isSettings) {
      return {};
    }
    if (getMeta(replica.doc).description !== null) {
      return {};
    }
    return { description: null, descriptionHint: DESCRIPTION_NUDGE };
  };

  /** A non-blocking prompt for an untagged document when this replica has choices. */
  const tagGap = (replica: Replica): Record<string, unknown> => {
    if (replica.isDirectory || replica.isSidebar || replica.isSettings) {
      return {};
    }
    if (
      getMeta(replica.doc).tags.length > 0 ||
      activeTagCatalog(tagCatalog()).length === 0
    ) {
      return {};
    }
    return { tagHint: TAG_NUDGE };
  };

  /** A non-blocking reminder returned only after document content changes. */
  const tldrReview = (replica: Replica): Record<string, unknown> => {
    const meta = getMeta(replica.doc);
    return meta.kind === "decision" || meta.tldrOptOut === true ? {} : meta.tldr === null
      ? { tldr: null, tldrHint: TLDR_MISSING_NUDGE }
      : { tldrHint: TLDR_AFTER_CONTENT_CHANGE };
  };

  /**
   * Check health after the write: a refused append must not report applied.
   * synced means hub acknowledgement, never hub storage.
   */
  const durability = (replica: Replica): Record<string, unknown> => {
    replicas.assertHealthy();
    return {
      applied: true,
      synced: replicas.isRoomQuiet(replica.room),
      hub: replicas.sync.state(),
      ...descriptionGap(replica),
      ...tagGap(replica),
    };
  };

  /** Document-content durability plus the deliberately narrower TL;DR nudge. */
  const contentDurability = (replica: Replica): Record<string, unknown> => ({
    ...durability(replica),
    ...tldrReview(replica),
  });

  /**
   * Rooms persist and sync independently; report each and AND their synced flags.
   * Check health first so applied: true requires every append to be durable.
   */
  const durabilityAcross = (
    primary: Replica,
    rooms: { purpose: string; room: string }[],
  ): Record<string, unknown> => {
    replicas.assertHealthy();
    const detail = rooms.map((entry) => ({
      ...entry,
      applied: true,
      synced: replicas.isRoomQuiet(entry.room),
    }));
    return {
      applied: true,
      synced: detail.every((entry) => entry.synced),
      rooms: detail,
      hub: replicas.sync.state(),
      ...descriptionGap(primary),
      ...tagGap(primary),
    };
  };

  const annotationJson = (
    replica: Replica,
    annotation: Annotation,
  ): Record<string, unknown> => ({
    ...annotation,
    range: resolveAnnotationRange(replica.doc, annotation.id),
  });

  return {
    replicas,
    help,
    briefing,
    work,
    requireStub,
    requireNotDeleted,
    durability,
    tagCatalog,
    requireWritableDoc,
    blockInputFor,
    recordAnswer,
    documentTags,
    decisionAuthorityJson,
    blocksJson,
    durabilityAcross,
    tldrReview,
    requireDoc,
    decisionEntryJson,
    topicJson,
    decisionReadJson,
    annotationJson,
    validateTableTargets,
    validateCardTargets,
    validateFigmaTargets,
    contentDurability,
    titleFor,
    linkTitle,
  };
}

export type ToolContext = ReturnType<typeof createToolContext>;
