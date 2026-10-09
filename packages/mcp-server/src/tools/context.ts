import {
  decisionApprovalChanged,
  decisionApprovalFingerprint,
  decisionRelations,
  decisionTopicArchived,
  getBlocksWithInline,
  getDirectoryEntry,
  getMeta,
  getMetaMap,
  isProseBlockType,
  parseTableCell,
  parseTableInput,
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
  "This document has no description: call set_description with one or two sentences saying what it is for, so " +
  "list_docs and search can answer for it without anyone opening it.";

/** The one-line prompt a mutating tool carries when a document has no tags. */
const TAG_NUDGE =
  "This document has no tag assignments: call list_tags for the active workspace vocabulary, then call set_tags " +
  "to assign one or more tags.";

/** The stronger prompt returned when a changed document has no summary yet. */
const TLDR_MISSING_NUDGE =
  "This content change left the document without a TL;DR: call set_tldr with one or two sentences of plain " +
  "English for a person opening it.";

/**
 * One input run's marks as the model's mark set.
 *
 * Zod spells an optional property `T | undefined`; the model spells it absent —
 * and absent is what the model means, since a flag it reads as anything but
 * `true` is not that mark. So a key nobody set, and a flag explicitly set to
 * `false`, both simply do not appear.
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
 * One block input, ready for the schema.
 *
 * `inline` arrives already resolved — see `resolveInline`, which fills an empty
 * docLink label with the target's title and refuses a target this replica has
 * never heard of. Resolution happens before this because it can fail, and a
 * refusal must leave nothing written.
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
      throw notKnownLocally(uuid, "document");
    }

    const replica = replicas.replica(uuid);
    if (getMeta(replica.doc).uuid !== "") {
      // This boundary is what "working in a document" means: every tool that
      // reads or writes the room comes through here, and the ones that answer
      // from the derived index or the directory stub — `list_docs`, `search`,
      // `backlinks`, `archive_doc`, `restore_doc` — deliberately do not.
      replicas.touch(replica);
      return replica;
    }
    // Whether waiting can work is a fact about the hub, not about the document:
    // a room arrives over a connection, so a replica with none is not waiting
    // for anything. `hydrationRecovery` turns the hub state this failure is
    // already carrying into the class and the sentence that go with it.
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
   * Resolve a document for an operation that writes only its directory stub.
   *
   * Deliberately weaker than {@link requireDoc}: archiving and restoring change
   * the directory, not the document, so demanding that the document itself have
   * reached this replica would strand exactly the case that needs the tool — a
   * fresh server that knows an archived document only from the directory could
   * never restore it, because an archived room is not one `adoptKnownDocs`
   * attaches.
   *
   * A uuid the directory has never seen is still refused. Tombstoning a typo
   * would publish an entry for a document that never existed, and a tombstone
   * is sticky.
   */
  const requireStub = (uuid: string): DirectoryEntry => {
    const stub = getDirectoryEntry(replicas.directory().doc, uuid);
    if (stub === null) {
      throw notKnownLocally(uuid, "directory");
    }
    return stub;
  };

  /**
   * Resolve a document for a write. The one choke point every mutator that
   * touches a document goes through — archived means read-only. Content
   * mutators also request the decided-record refusal; comments and metadata
   * outside the approved content need only the archive check.
   *
   * The archive check comes before {@link requireDoc} on purpose: an archived
   * room is not one `adoptKnownDocs` attaches, so a replica that knows the
   * document only from the directory would otherwise answer `doc_not_hydrated`
   * — technically true, and useless. The caller needs to hear `restore_doc`.
   *
   * Scope, as the lifecycle help topic states it to agents:
   * this reads THIS replica's stub at call time. There is no cross-replica
   * lock, so an edit racing an archive that has not arrived yet is an ordinary
   * CRDT write and merges. Enforcement is refusal-at-call — a client
   * convention, which is all the spike has; real enforcement belongs to the
   * hosted-auth era.
   */
  const requireWritableDoc = (uuid: string, contentMutation = false): Replica => {
    if (decisionTopicArchived(replicas.directory().doc, uuid)) {
      throw new ToolError(
        "doc_archived",
        `Document ${uuid} is archived — restore_doc to edit`,
        { uuid, archived: true },
      );
    }
    const replica = requireDoc(uuid);
    const meta = getMeta(replica.doc);
    if (contentMutation && meta.kind === "decision" && meta.status === "decided") {
      throw new ToolError("decision_read_only", "A decided record's title, decision line, blocks and structured data are read-only; create a superseding record.", { uuid, kind: meta.kind, status: meta.status });
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
   * The document's own title where this replica holds it, the stub's cached one
   * otherwise — `meta.title` wins whenever there is a document to ask.
   */
  const titleFor = (uuid: string, stub: DirectoryEntry): string =>
    replicas.hydrated(uuid)
      ? getMeta(replicas.replica(uuid).doc).title
      : stub.title;

  /** The settings doc is the one catalog authority every tag path resolves. */
  const tagCatalog = () => replicas.settings().doc;

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

  /** A document's assignments in the public id/name/state shape. */
  const documentTags = (replica: Replica) =>
    readDocumentTags(replica.doc, tagCatalog());

  /**
   * The title an inline reference to `docId` is written with, or a refusal.
   *
   * Refusing is the honest half: offline the directory hydrates from the log
   * like any other document, so "this replica has never heard of it" is not
   * "it does not exist" — hence the named code and the hub state, rather than
   * `doc_not_found`. An ARCHIVED target resolves: a tombstoned stub is still a
   * document, and reading one is allowed.
   */
  const linkTitle = (docId: string): string => {
    const stub = getDirectoryEntry(replicas.directory().doc, docId);
    if (stub === null) {
      throw notKnownLocally(docId, "doclink");
    }
    return titleFor(docId, stub);
  };

  /**
   * Resolve an input's inline runs before a single byte is written.
   *
   * The one write that resolves a title: an empty-labelled docLink run gets the
   * target's current title, because a label is display text fixed at the moment
   * the link is made. A resolved title that is itself empty — a document the
   * web UI created and nobody has named — falls back to the uuid, since
   * `applyInlineRuns` drops an empty run and a dropped run is a link silently
   * lost.
   */
  const resolveInline = (
    runs: z.infer<typeof inlineArg>,
  ): InlineRun[] | undefined =>
    runs?.map((run) => {
      const marks = inlineMarks(run.marks);
      const docId = marks.docLink;
      if (docId === undefined) return { text: run.text, marks };
      // Resolved even when a label is already written: an unknown target is
      // refused either way, so a citation never points at nothing.
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

  /**
   * Resolve `inline` only for prose; source blocks ignore it, and tables read
   * their cell marks from GFM. Validate all seeds before create_doc opens a room.
   */
  const blockInputFor = (
    block: z.infer<typeof blockInputSchema>,
  ): BlockInput => {
    // Validate every seed before create_doc opens its first room. Schema also
    // checks at its write boundary, but a bad later seed must not leave an
    // earlier block or document metadata behind.
    if (block.type === "table") validateTableTargets(block.text ?? "");
    return toBlockInput(
      block,
      isProseBlockType(block.type) ? resolveInline(block.inline) : undefined,
    );
  };

  /**
   * A document's blocks as a read answers with them: every block exactly as it
   * has always been, plus the inline references it carries.
   *
   * `doc_links` names prose character ranges; table cell links are carried by
   * their inline markdown in `text`, which also determines the table's `rev`.
   */
  const blocksJson = (replica: Replica): Record<string, unknown>[] =>
    getBlocksWithInline(replica.doc).map(({ block, inline }) => {
      const links = docLinkRanges(block, inline);
      return { ...block, ...(links.length === 0 ? {} : { doc_links: links }) };
    });

  /**
   * The backfill nudge, on every mutating answer for a document that has no
   * description.
   *
   * Enforcement is asymmetric on purpose: `create_doc` refuses without one, but
   * the web UI creates documents that have none, and refusing to edit those
   * would punish the agent for somebody else's omission. So a write succeeds and
   * says what is missing — and it says it to exactly the right party, since an
   * agent already working inside a document is the one who can describe it.
   *
   * Sitting in {@link durability} rather than in each handler is deliberate:
   * every mutator that touches a document goes through it, including ones
   * written later. The workspace's own rooms are skipped — the directory and
   * the sidebar are not documents and have no description to miss.
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
  const tldrReview = (replica: Replica): Record<string, unknown> =>
    getMeta(replica.doc).tldr === null
      ? { tldr: null, tldrHint: TLDR_MISSING_NUDGE }
      : { tldrHint: TLDR_AFTER_CONTENT_CHANGE };

  /**
   * What a mutating tool owes its caller: the write landed locally, and whether
   * it has reached the hub — which, right after a write, it has not.
   *
   * `synced` is "the hub acknowledged it", never "the hub stored it"; see
   * the tool-contracts help topic for the window that distinction leaves open.
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
   * The same honesty for a call that mutated more than one room.
   *
   * The rooms are independently logged, independently sent and independently
   * acknowledged, so one boolean cannot describe them: `rooms` says where each
   * one stands, and the aggregate `synced` is the AND over all of them — never
   * true while a room this call touched is still pending. `applied` stays a
   * single word because it is one: {@link Replicas.assertHealthy} throws unless
   * every append reached the log, so the call either answers with all of them
   * durable or fails as `persistence_failed`.
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
    contentDurability,
    titleFor,
    linkTitle,
  };
}

export type ToolContext = ReturnType<typeof createToolContext>;
