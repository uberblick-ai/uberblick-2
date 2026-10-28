import {
  decisionApprovalChanged,
  decisionApprovalFingerprint,
  decisionContentLocked,
  decisionRelations,
  isDirectoryEntryArchived,
  decisionTopicArchived,
  decisionTopicTitle,
  getBlocksWithInline,
  getDirectoryEntry,
  getMeta,
  getMetaMap,
  isProseBlockType,
  isCalloutVariant,
  isCalloutIcon,
  InvalidCalloutError,
  parseTableCell,
  parseTableInput,
  parseCardInput,
  parseFigmaInput,
  parseInline,
  CARD_PARTS,
  readDirectoryTags,
  readDocumentTags,
  resolveAnnotationAnchors,
  resolveDecisionTopics,
} from "@uberblick/schema";
import type {
  Annotation,
  AnnotationAnchor,
  BlockInput,
  CalloutVariant,
  DecisionTopicResolution,
  DirectoryEntry,
  HeadingLevel,
  InlineMarkSet,
  InlineRun,
  ListIndent,
  TableMapping,
} from "@uberblick/schema";
import type { z } from "zod";
import {
  ToolError,
  hydrationRecovery,
} from "../failures.js";
import { docLinkRanges } from "../replica.js";
import type { Replica, Replicas } from "../replica.js";
import type { ServerWork } from "../server-work.js";
import { HelpCatalog } from "../help.js";
import { activeTagCatalog } from "../tag-catalog.js";
import { isoTimestamp } from "../timestamps.js";
import { TLDR_AFTER_CONTENT_CHANGE } from "./descriptions.js";
import type { DecisionAnswer, blockInputSchema, inlineArg } from "./schemas.js";

/** The one-line prompt a mutating tool carries when a document has none. */
const DESCRIPTION_NUDGE =
  "This document has no description: call set_metadata with `description`. Only agents read it, never people: write " +
  "whatever best helps an agent find this page with list_docs and search and decide whether to open it, such as what it " +
  "covers and the terms someone would search for. A keyword list is fine.";

/** The one-line prompt a mutating tool carries when a document has no tags. */
const TAG_NUDGE =
  "This document has no tags: to add some, call list_tags for the workspace vocabulary, then set_metadata with " +
  "`tags`; leave it untagged if no tag fits.";

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
    ...(input.list === undefined ? {} : { list: input.list }),
    ...(input.indent === undefined ? {} : { indent: input.indent as ListIndent }),
    ...(input.variant === undefined ? {} : { variant: input.variant as CalloutVariant }),
    ...(input.icon === undefined ? {} : { icon: input.icon }),
    ...(inline === undefined ? {} : { inline }),
  };
}

/** A directory row; a decision topic's row also names its records by UUID. */
export type TopicRowEntry = DirectoryEntry & {
  resolution?: { inForce: string | null; pending: string[]; conflicts: string[] };
};

/** Shared per-server helpers; each closure keeps the registering replicas. */
// biome-ignore lint/complexity/noExcessiveLinesPerFunction: This function predates the length limit.
export function createToolContext(replicas: Replicas, work: ServerWork, help = new HelpCatalog()) {

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
        hub: replicas.hubState(),
      },
    );
  };

  const requireNotDeleted = (uuid: string): void => {
    if (replicas.isDeleted(uuid)) {
      throw new ToolError("doc_deleted", `Document ${uuid} was permanently deleted`, { uuid });
    }
  };

  /** Refuse unknown UUIDs before a room join can create an empty hub document. */
  const requireKnownDoc = (uuid: string): DirectoryEntry | null => {
    requireNotDeleted(uuid);
    const stub = getDirectoryEntry(replicas.directory().doc, uuid);
    if (!replicas.known(uuid) && stub === null && !replicas.hasLog(uuid)) {
      throw notKnownLocally(uuid, "document");
    }
    return stub;
  };

  /** Live reads also need hydrated content; hub revision reads do not. */
  const requireDoc = (uuid: string): Replica => {
    const stub = requireKnownDoc(uuid);
    const replica = replicas.replica(uuid);
    if (getMeta(replica.doc, replica.id).uuid !== "") {
      // Touch only tools that access the document room; directory/index reads
      // and archive/restore do not announce document activity.
      replicas.touch(replica);
      return replica;
    }
    const hub = replicas.hubState();
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
    if (isDirectoryEntryArchived(replicas.directory().doc, uuid)) {
      throw new ToolError(
        "doc_archived",
        `Document ${uuid} is archived — restore_doc to edit`,
        { uuid, archived: true },
      );
    }
    const replica = requireDoc(uuid);
    const meta = getMeta(replica.doc, replica.id);
    if (contentMutation && decisionContentLocked(meta)) {
      throw new ToolError("decision_read_only", "A decided record's answer blocks and structured data are read-only; decisions have no TL;DR. Create a superseding record.", { uuid, kind: meta.kind, status: meta.status });
    }
    return replica;
  };

  const recordAnswer = (replica: Replica, answer: DecisionAnswer): void => {
    const meta = getMetaMap(replica.doc);
    meta.set("decidedBy", answer.who);
    meta.set("decidedAt", new Date(answer.when).toISOString());
    meta.set("decidedWhere", answer.where);
    meta.set("agentStance", false);
    meta.set("approvalFingerprint", decisionApprovalFingerprint(replica.doc));
  };

  const decisionAuthorityJson = (replica: Replica) => {
    const meta = getMeta(replica.doc, replica.id);
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
   * Decision titles are topic-wide; regular documents prefer hydrated metadata.
   */
  const titleFor = (uuid: string, stub: DirectoryEntry, topics?: ReadonlyMap<string, DecisionTopicResolution>): string => {
    if (stub.kind === "decision") {
      const topic = topics === undefined
        ? resolveDecisionTopics(replicas.directory().doc).find((entry) => entry.topic === (stub.topic ?? uuid))
        : topics.get(stub.topic ?? uuid);
      if (topic !== undefined) return decisionTopicTitle(topic);
    }
    return replicas.hydrated(uuid) ? getMeta(replicas.replica(uuid).doc).title : stub.title;
  };

  /** The settings doc is the one catalog authority every tag path resolves. */
  const tagCatalog = () => replicas.settings().doc;

  /** Normalize directory descriptions and resolve tags through the settings catalog. */
  const decisionEntryJson = (entry: DirectoryEntry, title: string, archived: boolean) => {
    // `governs` stays stored for released clients; answers name every page in `related`.
    const { recordArchived: _recordArchived, governs: _governs, createdAt: storedCreatedAt, updatedAt: storedUpdatedAt, ...fields } = entry;
    const createdAt = isoTimestamp(storedCreatedAt);
    const updatedAt = isoTimestamp(storedUpdatedAt);
    return {
      ...fields, title, tags: readDirectoryTags(entry, tagCatalog()),
      ...(createdAt === undefined ? {} : { createdAt }),
      ...(updatedAt === undefined ? {} : { updatedAt }),
      ...(entry.kind === "decision" ? { deleted: archived || entry.recordArchived === true } : {}),
      description: entry.description ?? null,
    };
  };

  /** Name a topic's records by UUID; get_doc on one of them reads its details. */
  const topicRecordsJson = (topic: DecisionTopicResolution) => ({
    inForce: topic.inForce?.uuid ?? null,
    pending: topic.pending.map(entry => entry.uuid),
    conflicts: topic.conflicts.map(entry => entry.uuid),
  });

  /** A topic presented by its record in force, else pending, else first record. */
  const topicRow = (topic: DecisionTopicResolution): TopicRowEntry => ({
    ...topic.representative,
    topic: topic.topic,
    title: decisionTopicTitle(topic),
    deleted: topic.archived,
    resolution: topicRecordsJson(topic),
  });

  /** One row shape for list_docs and a regular page's get_doc decisions. */
  const directoryRowJson = (entry: TopicRowEntry, pinned?: boolean): Record<string, unknown> => {
    const updatedAt = isoTimestamp(entry.updatedAt);
    return {
      uuid: entry.uuid,
      title: entry.title,
      tags: readDirectoryTags(entry, tagCatalog()),
      // Keep absent descriptions explicit as null.
      description: entry.description ?? null,
      ...(updatedAt === undefined ? {} : { updatedAt }),
      ...(entry.openThreadCount === undefined ? {} : { openThreadCount: entry.openThreadCount }),
      ...(entry.deleted === true ? { deleted: true as const } : {}),
      ...(pinned === undefined ? {} : { pinned }),
      ...(entry.kind === "decision" ? {
        kind: "decision" as const,
        status: entry.status,
        topic: entry.topic,
        ...(entry.related === undefined ? {} : { related: entry.related }),
        ...(entry.discussion === undefined ? {} : { discussion: entry.discussion }),
        ...(entry.answerPreview === undefined ? {} : { answerPreview: entry.answerPreview }),
        ...entry.resolution,
      } : {}),
    };
  };

  const decisionReadJson = (uuid: string) => {
    const directory = replicas.directory().doc;
    const { predecessors, successors, resolution } = decisionRelations(directory, uuid);
    const topics = new Map(resolveDecisionTopics(directory).map(topic => [topic.topic, topic]));
    const entryJson = (entry: DirectoryEntry) => decisionEntryJson(entry, titleFor(entry.uuid, entry, topics), decisionTopicArchived(directory, entry.uuid));
    return {
      ...(resolution === null ? {} : { title: decisionTopicTitle(resolution) }),
      predecessors: predecessors.map(entryJson),
      successors: successors.map(entryJson),
      resolution: resolution === null ? null : { ...topicRecordsJson(resolution), archived: resolution.archived },
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

  /** Existing targets are exempt only within the same surviving inline part. */
  const validateBlockTargets = (type: BlockInput["type"], source: string, previous?: string, mapping?: TableMapping): void => {
    let parts: { text: string; oldText: string | undefined }[];
    let parse = parseInline;
    if (type === "table") {
      const table = parseTableInput(source);
      const oldTable = previous === undefined ? undefined : parseTableInput(previous);
      const oldCells = oldTable === undefined ? [] : [oldTable.header, ...oldTable.rows];
      parse = parseTableCell;
      parts = [table.header, ...table.rows].flatMap((cells, row) => cells.map((text, column) => {
        const oldRow = mapping === undefined ? row : mapping.rows[row];
        const oldColumn = mapping === undefined ? column : mapping.columns[column];
        return { text, oldText: oldRow == null || oldColumn == null ? undefined : oldCells[oldRow]?.[oldColumn] };
      }));
    } else if (type === "card") {
      const card = parseCardInput(source);
      const oldCard = previous === undefined ? undefined : parseCardInput(previous, false);
      parts = CARD_PARTS.map(part => ({ text: card[part], oldText: oldCard?.[part] }));
    } else if (type === "figma") {
      const figma = parseFigmaInput(source);
      const oldFigma = previous === undefined ? undefined : parseFigmaInput(previous);
      parts = [{ text: figma.caption, oldText: oldFigma?.caption }];
    } else {
      return;
    }
    for (const { text, oldText } of parts) {
      if (text === oldText) continue;
      const oldTargets = new Set(parse(oldText ?? "").map(run => run.marks.docLink));
      for (const run of parse(text)) {
        if (run.marks.docLink !== undefined && !oldTargets.has(run.marks.docLink)) linkTitle(run.marks.docLink);
      }
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
    if (block.type === "divider" && ((block.text ?? "") !== "" || (block.inline?.length ?? 0) > 0)) {
      throw new ToolError("invalid_divider", "A divider has no text or inline content.");
    }
    if (block.type === "callout") {
      if (block.variant !== undefined && !isCalloutVariant(block.variant)) {
        throw new InvalidCalloutError("variant must be note, tip, important, warning or caution");
      }
      if (block.icon !== undefined && !isCalloutIcon(block.icon)) {
        throw new InvalidCalloutError("icon must be one emoji or a curated :name: icon");
      }
    }
    validateBlockTargets(block.type, block.text ?? "");
    return toBlockInput(
      block,
      isProseBlockType(block.type) ? resolveInline(block.inline) : undefined,
    );
  };

  /**
   * doc_links exposes prose ranges; table links stay in GFM text and its rev.
   * Formatted prose also returns its runs in insert_block's shape, so a read
   * shows where marks landed; plain prose keeps the answer to its text.
   */
  const blocksJson = (replica: Pick<Replica, "doc">): Record<string, unknown>[] =>
    getBlocksWithInline(replica.doc).map(({ block, inline }) => {
      const links = docLinkRanges(block, inline);
      const formatted = isProseBlockType(block.type) && inline.some(run => Object.keys(run.marks).length > 0);
      return {
        ...block,
        ...(links.length === 0 ? {} : { doc_links: links }),
        ...(formatted ? { inline: inline.map(({ text, marks }) => ({ text, marks: { ...marks } })) } : {}),
      };
    });

  /**
   * create_doc requires a description, but existing documents may lack one.
   * All document writes nudge without refusing; workspace-owned rooms are exempt.
   */
  const descriptionGap = (replica: Replica): Record<string, unknown> => {
    if (replica.isDirectory || replica.isSidebar || replica.isSettings) {
      return {};
    }
    if (getMeta(replica.doc, replica.id).description !== null) {
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
      getMeta(replica.doc, replica.id).tags.length > 0 ||
      activeTagCatalog(tagCatalog()).length === 0
    ) {
      return {};
    }
    return { tagHint: TAG_NUDGE };
  };

  /** A non-blocking reminder returned only after document content changes. */
  const tldrReview = (replica: Replica): Record<string, unknown> => {
    const meta = getMeta(replica.doc, replica.id);
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
      hub: replicas.hubState(),
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
      hub: replicas.hubState(),
      ...descriptionGap(primary),
      ...tagGap(primary),
    };
  };

  const annotationJson = (
    replica: Replica,
    annotation: Annotation,
    anchors: ReadonlyMap<string, AnnotationAnchor> = resolveAnnotationAnchors(replica.doc),
  ): Record<string, unknown> => {
    const anchor = anchors.get(annotation.id);
    return {
      ...annotation,
      comments: annotation.comments.map(({ author, text, createdAt, account, agent }) => ({
        author,
        text,
        createdAt,
        ...(account === undefined ? {} : { account }),
        ...(agent === undefined ? {} : { agent }),
      })),
      blockId: anchor?.blockId ?? annotation.blockId,
      range: anchor?.range ?? null,
    };
  };

  return {
    replicas,
    help,
    work,
    requireStub,
    requireKnownDoc,
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
    topicRow,
    directoryRowJson,
    decisionReadJson,
    annotationJson,
    validateBlockTargets,
    contentDurability,
    titleFor,
    linkTitle,
  };
}

export type ToolContext = ReturnType<typeof createToolContext>;
