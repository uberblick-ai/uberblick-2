import * as Y from "yjs";
import {
  appendBlock,
  COMMENT_MARK,
  decisionAnswerShapeFailure,
  decisionApprovalFingerprint,
  decisionTopicTitle,
  documentStubFields,
  getBlocks,
  getBlocksFragment,
  getBlocksWithInline,
  getDirectoryEntry,
  getMeta,
  getMetaMap,
  initDoc,
  isDirectoryEntryDeleted,
  listTagCatalog,
  parseRoom,
  repairDuplicateBlocks,
  resolveDecisionTopics,
  roomForDoc,
  setDiscussion,
  setKind,
  setStatus,
  upsertDirectoryEntry,
} from "@uberblick/schema";
import type { AwarenessUser } from "./identity.js";
import { acquireRoom, refused } from "./rooms.js";
import type { RoomConnection } from "./rooms.js";

/** The caller owns this isolated draft and destroys it when the editor closes. */
export function createDecisionDraft(source: Y.Doc): Y.Doc {
  const draft = new Y.Doc();
  const fragment = getBlocksFragment(draft);
  // Native clones preserve cell marks and links, list attributes and code languages.
  fragment.insert(0, getBlocksFragment(source).toArray().map((block) => {
    if (!(block instanceof Y.XmlElement || block instanceof Y.XmlText)) {
      throw new Error("The answer contains an unsupported XML node.");
    }
    return block.clone();
  }));
  repairDuplicateBlocks(draft);
  // Anchors belong to the source's comment threads, which the draft does not copy.
  for (const node of fragment.createTreeWalker(() => true)) {
    if (node instanceof Y.XmlText) node.format(0, node.length, { [COMMENT_MARK]: null });
  }
  return draft;
}

interface AlterDecisionInput {
  source: RoomConnection;
  directory: RoomConnection;
  draft: Y.Doc;
  identity: AwarenessUser;
  mode: "decide" | "rfc";
  reason: string;
  displayName: string;
  tagCatalog: Y.Doc;
  signal: AbortSignal;
}

type RefusalCode =
  | "decision_answer_empty" | "decision_block_unsupported" | "decision_answer_too_long"
  | "reason_empty" | "display_name_empty" | "stale_decision"
  | "source_unwritable" | "directory_unwritable" | "destination_unwritable"
  | "destination_exists" | "abandoned";

type Refusal = { ok: false; code: RefusalCode; message: string };
type AnswerProblem = {
  code: "decision_answer_empty" | "decision_block_unsupported" | "decision_answer_too_long";
  blockTypes: string[];
};
export type AlterDecisionResult = {
  ok: true;
  decision: string;
  rfc?: string;
  /** Release after the reader has acquired the new rooms and directory. */
  release(): void;
} | Refusal;

const messages: Record<RefusalCode, string> = {
  decision_answer_empty: "Write a non-blank answer.",
  decision_block_unsupported: "Use only paragraphs, lists, code blocks or tables in the answer.",
  decision_answer_too_long: "Shorten the answer to at most two blocks; adjacent list items count as one block.",
  reason_empty: "Give a reason for the decision.",
  display_name_empty: "Set a display name before recording the decision.",
  stale_decision: "This record is no longer the answer in force on a live topic. Reopen the current answer.",
  source_unwritable: "Wait for the current answer's room to synchronize and become writable.",
  directory_unwritable: "Wait for the workspace directory to synchronize and become writable.",
  destination_unwritable: "A new document's room cannot be written. Reconnect and try again.",
  destination_exists: "A new document's identity is already in use. Try again.",
  abandoned: "The pending change was abandoned; nothing was written.",
};

function refuse(code: RefusalCode): Refusal {
  return { ok: false, code, message: messages[code] };
}

export function alteredDecisionAnswerProblem(draft: Y.Doc): AnswerProblem | null {
  const unsupported = getBlocksFragment(draft).toArray().filter((block) =>
    !(block instanceof Y.XmlElement) || !["paragraph", "list-item", "code", "table"].includes(block.nodeName));
  const blockTypes = [...new Set(unsupported.map((block) => block instanceof Y.XmlElement ? block.nodeName : "unknown"))];
  if (unsupported.length > 0) return { code: "decision_block_unsupported", blockTypes };
  // Reserve the third schema answer block for Decide's reason in either mode.
  const shape = decisionAnswerShapeFailure([...getBlocks(draft), { type: "paragraph" }]);
  if (shape !== null) return { code: shape, blockTypes };
  const hasText = getBlocksWithInline(draft).some(({ block, table }) =>
    table === undefined ? block.text.trim() !== "" : table.flat(2).some((run) => run.text.trim() !== ""));
  return hasText ? null : { code: "decision_answer_empty", blockTypes };
}

function sourceFailure(input: AlterDecisionInput): Refusal | null {
  if (input.signal.aborted) return refuse("abandoned");
  if (!input.source.status.writable || !input.source.status.synced) return refuse("source_unwritable");
  if (!input.directory.status.writable || !input.directory.status.synced) return refuse("directory_unwritable");
  const meta = getMeta(input.source.ydoc, parseRoom(input.source.room).uuid);
  const topic = resolveDecisionTopics(input.directory.ydoc).find((entry) => entry.topic === meta.topic);
  if (meta.kind !== "decision" || meta.status !== "decided" || topic === undefined ||
    topic.archived || topic.conflicts.length > 0 || topic.inForce?.uuid !== meta.uuid) {
    return refuse("stale_decision");
  }
  return null;
}

type Destination = { uuid: string; handle: ReturnType<typeof acquireRoom> };

function destinationState(destinations: Destination[], directory: Y.Doc): Refusal | "pending" | null {
  let ready = true;
  for (const { uuid, handle } of destinations) {
    const { status, ydoc } = handle.connection;
    if (refused(status)) return refuse("destination_unwritable");
    if (!status.writable || !status.synced) { ready = false; continue; }
    if (getMeta(ydoc).uuid !== "" || getBlocksFragment(ydoc).length > 0 ||
      getDirectoryEntry(directory, uuid) !== null || isDirectoryEntryDeleted(directory, uuid)) {
      return refuse("destination_exists");
    }
  }
  return ready ? null : "pending";
}

function stageDocument(doc: Y.Doc, now: number) {
  return { update: Y.encodeStateAsUpdate(doc), stub: {
    ...documentStubFields(doc), createdAt: now, updatedAt: now,
  } };
}

function stageDecision(input: AlterDecisionInput, draft: Y.Doc, uuid: string, rfc: string | undefined, now: number) {
  const predecessor = getMeta(input.source.ydoc, parseRoom(input.source.room).uuid);
  const topic = resolveDecisionTopics(input.directory.ydoc).find((entry) => entry.topic === predecessor.topic);
  if (topic === undefined) throw new Error(messages.stale_decision);
  const record = createDecisionDraft(draft);
  try {
    initDoc(record, {
      uuid, title: decisionTopicTitle(topic),
      ...(predecessor.description == null ? {} : { description: predecessor.description }),
      tags: predecessor.tags, topic: predecessor.topic ?? predecessor.uuid,
      supersedes: predecessor.uuid,
      ...(predecessor.governs === undefined ? {} : { governs: predecessor.governs }),
    });
    setKind(record, "decision");
    setStatus(record, input.mode === "decide" ? "decided" : "open");
    if (rfc !== undefined) setDiscussion(record, rfc);
    else {
      appendBlock(record, { type: "paragraph", text: input.reason.trim() });
      const meta = getMetaMap(record);
      meta.set("decidedBy", input.displayName.trim());
      meta.set("decidedAt", new Date(now).toISOString());
      meta.set("decidedWhere", "Uberblick web: Alter decision");
      meta.set("agentStance", false);
      meta.set("approvalFingerprint", decisionApprovalFingerprint(record));
    }
    return stageDocument(record, now);
  } finally {
    record.destroy();
  }
}

function stageRfc(input: AlterDecisionInput, uuid: string, decision: string, now: number) {
  const discussion = new Y.Doc();
  try {
    const source = getMeta(input.source.ydoc, parseRoom(input.source.room).uuid);
    const topic = resolveDecisionTopics(input.directory.ydoc).find((entry) => entry.topic === source.topic);
    if (topic === undefined) throw new Error(messages.stale_decision);
    const title = decisionTopicTitle(topic);
    const tag = listTagCatalog(input.tagCatalog).find((entry) => entry.name === "rfc" && entry.state === "active");
    initDoc(discussion, { uuid, title, tags: tag === undefined ? [] : [tag.id] });
    appendBlock(discussion, { type: "paragraph", inline: [
      { text: "Proposed change to ", marks: {} },
      { text: title, marks: { docLink: decision } },
      { text: ".", marks: {} },
    ] });
    const reason = input.reason.trim();
    if (reason !== "") appendBlock(discussion, { type: "paragraph", text: reason });
    return stageDocument(discussion, now);
  } finally {
    discussion.destroy();
  }
}

/**
 * Admission precedes every mutation. Abort abandons a pending operation, even
 * if a room joins later. The commit is synchronous and has no admission waits.
 */
export async function recordAlteredDecision(request: AlterDecisionInput): Promise<AlterDecisionResult> {
  const input = { ...request, reason: request.reason.trim(), displayName: request.displayName.trim() };
  const problem = alteredDecisionAnswerProblem(input.draft);
  if (problem !== null) return refuse(problem.code);
  if (input.mode === "decide" && input.reason === "") return refuse("reason_empty");
  if (input.mode === "decide" && input.displayName === "") return refuse("display_name_empty");
  const failure = sourceFailure(input);
  if (failure !== null) return failure;

  const draft = createDecisionDraft(input.draft);
  const decision = crypto.randomUUID();
  const rfc = input.mode === "rfc" ? crypto.randomUUID() : undefined;
  const workspace = parseRoom(input.source.room).workspaceId;
  const destinations = (rfc === undefined ? [decision] : [rfc, decision]).map((uuid) => ({
    uuid, handle: acquireRoom(roomForDoc(workspace, uuid), input.identity, { presence: false }),
  }));
  const directoryHandle = acquireRoom(input.directory.room, input.identity, { presence: false });
  const release = (): void => {
    for (const { handle } of destinations) handle.release();
    directoryHandle.release();
  };
  let committed = false;
  const stops: Array<() => void> = [];
  try {
    return await new Promise<AlterDecisionResult>((resolve, reject) => {
      let finished = false;
      const finish = (result: AlterDecisionResult): void => {
        finished = true;
        resolve(result);
      };
      const attempt = (): void => {
        // Status subscriptions seed synchronously; let all unsubscribe handles settle first.
        queueMicrotask(() => {
          if (finished) return;
          const currentFailure = sourceFailure(input) ?? destinationState(destinations, input.directory.ydoc);
          if (currentFailure === "pending") return;
          if (currentFailure !== null) return finish(currentFailure);

          try {
            const now = Date.now();
            // Build every update and stub before publishing: schema errors cannot leave partial records.
            const staged = destinations.map(({ uuid, handle }) => ({ handle,
              ...(uuid === rfc ? stageRfc(input, uuid, decision, now) : stageDecision(input, draft, uuid, rfc, now)),
            }));
            finished = true;
            committed = true;
            // RFC first: no published proposal can reference an unwritten discussion.
            for (const { handle, update, stub } of staged) {
              Y.applyUpdate(handle.connection.ydoc, update);
              upsertDirectoryEntry(input.directory.ydoc, stub);
            }
            resolve({ ok: true, decision, ...(rfc === undefined ? {} : { rfc }), release });
          } catch (error) {
            finished = true;
            reject(error);
          }
        });
      };
      const abandon = (): void => { if (!finished) finish(refuse("abandoned")); };
      input.signal.addEventListener("abort", abandon, { once: true });
      stops.push(() => input.signal.removeEventListener("abort", abandon));
      for (const connection of [input.source, input.directory, ...destinations.map(({ handle }) => handle.connection)]) {
        stops.push(connection.onStatusChange(attempt));
      }
      input.directory.ydoc.on("update", attempt);
      stops.push(() => input.directory.ydoc.off("update", attempt));
      attempt();
    });
  } finally {
    for (const stop of stops) stop();
    if (!committed) release();
    draft.destroy();
  }
}
