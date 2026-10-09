/**
 * Successful tool answers, shared by tools/list and the server's result check.
 * Server-owned objects are closed at every level. The only untyped values are
 * caller-stored collection schemas and records, and data diagnostic details.
 */
import { DECISION_STATUSES, DOCUMENT_KINDS, REQUIREMENT_STATUSES } from "@uberblick/schema";
import { z } from "zod";
import { strictInput } from "./inputs.js";

const count = z.number().int().nonnegative();
const uuid = z.string().describe("Document identity; a UUID, never a title or path.");
const description = z.string().nullable().describe("Agent-facing document description; null when unwritten.");
const tldr = z.string().nullable().describe("Person-facing document summary or decision line; null when unwritten.");
const status = z.enum([...REQUIREMENT_STATUSES, ...DECISION_STATUSES]);
const lifecycle = {
  kind: z.enum(DOCUMENT_KINDS).optional(),
  status: status.optional(),
};
const decisionAuthority = {
  agentStance: z.boolean().optional(),
  decidedBy: z.string().optional(),
  decidedAt: z.string().optional(),
  decidedWhere: z.string().optional(),
  rejectionReason: z.string().optional(),
  approvalChanged: z.boolean().optional(),
};

const hub = z.object({
  status: z.enum(["disabled", "connecting", "connected", "hub-down", "auth-failed", "update-required", "quarantined"]),
  url: z.string().nullable().describe("Configured hub endpoint; null when synchronization is disabled."),
  reason: z.string().optional(),
  recoveryClass: z.enum(["retry", "manual"]).optional(),
  authRecovery: z.enum(["sign-in-required", "no-workspace-access", "credential-store", "renewal-unavailable"]).optional(),
  protocolVersion: z.number().int().describe("This client's sync protocol version, including while offline."),
  hubProtocolVersion: z.number().int().optional().describe("Hub protocol version, learned from a protocol refusal."),
}).strict().describe("Current connection state; an acknowledgement does not claim hub storage.");

/** The durability contract is declared once for every writing tool. */
const durability = {
  applied: z.literal(true).describe("The write is durable in this replica's local update log."),
  synced: z.boolean().describe("The hub acknowledged this write; acknowledgement does not mean hub storage."),
  hub,
};
const documentDurability = {
  ...durability,
  description: z.null().optional().describe("Present when the written document has no agent-facing description."),
  descriptionHint: z.string().optional().describe("Non-blocking request to supply the missing document description."),
  tagHint: z.string().optional().describe("Non-blocking request to assign tags from the active vocabulary."),
};
const contentReview = {
  tldr: z.null().optional().describe("Present when changed document content has no TL;DR."),
  tldrHint: z.string().describe("Non-blocking request to review the TL;DR after changing document content."),
};
const touchedRoom = z.object({
  purpose: z.string().describe("The independently written room's purpose."),
  room: z.string(),
  applied: durability.applied,
  synced: durability.synced,
}).strict();
const multipleRoomDurability = {
  ...durability,
  rooms: z.array(touchedRoom).describe("Each independently persisted room touched; top-level synced is their conjunction."),
};

const tag = z.union([
  z.object({ id: z.string(), name: z.string(), state: z.enum(["active", "retired"]) }).strict(),
  z.object({ id: z.string(), name: z.null(), state: z.literal("unresolved") }).strict(),
]);
const tags = z.array(tag).describe("Canonical tag identities, current names and active, retired or unresolved state.");

/** Directory stubs expose normalized descriptions and catalog-aware tags. */
const directoryEntry = z.object({
  uuid,
  title: z.string(),
  tags,
  description,
  deleted: z.boolean().optional(),
  createdAt: z.number().optional().describe("Creation epoch milliseconds on the creating replica's clock, where known."),
  updatedAt: z.number().optional().describe("Approximate edit epoch milliseconds on the authoring replica's clock, where known."),
  ...lifecycle,
  governs: z.string().optional(),
  topic: z.string().optional(),
  supersedes: z.string().optional(),
  tldr: z.string().optional(),
  agentStance: z.boolean().optional(),
  decidedBy: z.string().optional(),
  decidedAt: z.string().optional(),
  approvalChanged: z.boolean().optional(),
  commentCount: count.optional(),
}).strict();
const topicResolution = {
  topic: z.string().describe("First record's UUID identifying this decision topic."),
  inForce: directoryEntry.nullable().describe("Record in force, or null when the topic has no answer in force."),
  pending: z.array(directoryEntry),
  conflicts: z.array(directoryEntry),
  archived: z.boolean(),
};
const decisionTopic = directoryEntry.extend(topicResolution).strict();

const docLink = z.object({
  start: count,
  end: count,
  docId: z.string(),
}).strict();
const blockFields = {
  id: z.string(),
  text: z.string().describe("Plain prose or source text; tables carry canonical GFM with cell formatting."),
  rev: z.string().describe("Content hash to assert on a later block edit."),
};
const linkRanges = {
  doc_links: z.array(docLink).optional().describe("Prose character ranges that reference documents; absent when there are none."),
};
function blockSchema(withLinks: boolean) {
  const prose = { ...blockFields, ...(withLinks ? linkRanges : {}) };
  return z.union([
    z.object({ ...prose, type: z.enum(["paragraph", "quote"]) }).strict(),
    z.object({ ...prose, type: z.literal("heading"), level: z.number().int().min(1).max(6) }).strict(),
    z.object({ ...prose, type: z.literal("list-item"), list: z.enum(["bullet", "ordered"]), indent: z.number().int().min(0).max(3) }).strict(),
    z.object({ ...blockFields, type: z.literal("code"), language: z.string() }).strict(),
    z.object({ ...blockFields, type: z.enum(["mermaid", "table", "terminal", "chart"]) }).strict(),
  ]);
}
const block = blockSchema(false);
const readBlocks = z.array(blockSchema(true)).describe("Visible document blocks in stored order.");
const annotation = z.object({
  id: z.string(),
  blockId: z.string(),
  comments: z.array(z.object({ author: z.string(), text: z.string(), createdAt: z.string() }).strict()),
  resolved: z.boolean().optional(),
  range: z.object({
    row: count.optional(),
    column: count.optional(),
    start: count,
    end: count,
    collapsed: z.boolean(),
  }).strict().nullable().describe("Current anchored range, or null after the marked span was deleted."),
}).strict();
const collectionCount = z.object({ name: z.string(), recordCount: count }).strict();
const dataIssue = z.object({
  code: z.string(),
  reason: z.string(),
  details: z.record(z.string(), z.unknown()).describe("Free-form diagnostic context from the shared data validator."),
}).strict();
const dataSummary = z.object({
  collections: z.array(collectionCount.extend({ valid: z.boolean(), invalidRecordCount: count }).strict()),
  bytes: count.describe("Canonical UTF-8 JSON bytes of the whole document data area."),
  valid: z.boolean(),
  errorCount: count,
}).strict();

/**
 * The SDK requires a root object. The existing mode primitive keeps this
 * superset's runtime branch rules and advertised oneOf in one definition.
 */
const getData = strictInput({
  uuid,
  data: dataSummary.nullable().optional(),
  collection: z.string().optional(),
  schema: z.unknown().optional().describe("Raw caller-stored schema, including missing or unsupported schemas; never normalized."),
  valid: z.boolean().optional(),
  errors: z.array(dataIssue).optional(),
  recordCount: count.optional(),
  invalidRecordCount: count.optional(),
  records: z.array(z.object({
    id: z.string(),
    value: z.unknown().describe("Raw caller-stored JSON value; never normalized or repaired."),
    valid: z.boolean(),
    errors: z.array(dataIssue),
  }).strict()).optional(),
  bytes: count.optional().describe("Canonical UTF-8 bytes of this page's {id, value} array, excluding schemas and diagnostics."),
  complete: z.boolean().optional(),
  next_after: z.string().nullable().optional().describe("Last returned record id when more remain; null when complete."),
  missing_ids: z.array(z.string()).optional(),
}, [
  {
    title: "Area summary",
    when: { field: "collection", present: false },
    requires: ["data"],
    forbids: ["schema", "valid", "errors", "recordCount", "invalidRecordCount", "records", "bytes", "complete", "next_after", "missing_ids"],
  },
  {
    title: "Collection page",
    when: { field: "collection", present: true },
    requires: ["schema", "valid", "errors", "recordCount", "invalidRecordCount", "records", "bytes", "complete", "next_after"],
    forbids: ["data"],
  },
]);

const groupIdentity = z.object({ id: z.string(), name: z.string() }).strict();
const helpTopic = z.object({
  id: z.string().describe("Help topic id; registered tool names identify per-tool help."),
  title: z.string(),
  description: z.string(),
  uri: z.string().describe("MCP resource URI for this help topic."),
}).strict();
const getHelp = strictInput({
  topic: z.string().optional(),
  title: z.string().optional(),
  description: z.string().optional(),
  uri: z.string().optional(),
  text: z.string().optional().describe("The same Markdown text as the topic's MCP resource."),
  topics: z.array(helpTopic).optional(),
}, [
  { title: "Help catalog", when: { field: "topic", present: false }, requires: ["topics"], forbids: ["title", "description", "uri", "text"] },
  { title: "Help topic", when: { field: "topic", present: true }, requires: ["title", "description", "uri", "text"], forbids: ["topics"] },
]);
const sidebar = {
  workspace: z.string(),
  groups: z.array(groupIdentity.extend({
    docs: z.array(z.object({
      uuid,
      title: z.string().nullable().describe("Directory-cached title, or null when no stub is known."),
      status: z.enum(["ok", "archived", "unknown"]),
    }).strict()).describe("Pinned document identities in stored order."),
  }).strict()).describe("Curated sidebar groups in stored order."),
};

/** All registered tools use these exact objects for advertisement and checking. */
export const outputSchemas = {
  get_help: getHelp,
  list_tags: z.object({
    workspace: z.string(),
    complete: z.boolean(),
    tags: z.array(z.object({ id: z.string(), name: z.string() }).strict()),
    hub,
  }).strict(),
  create_doc: z.object({
    ...documentDurability,
    ...multipleRoomDurability,
    uuid,
    room: z.string(),
    title: z.string(),
    description: z.string(),
    tags,
    ...lifecycle,
    governs: z.string().optional(),
    topic: z.string().optional(),
    supersedes: z.string().optional(),
    tldr: tldr.optional(),
    tldrHint: contentReview.tldrHint.optional(),
    ...decisionAuthority,
    blocks: readBlocks,
    sidebar: z.object({ group: groupIdentity, position: z.number().int() }).strict().optional(),
  }).strict(),
  get_doc: z.object({
    uuid,
    title: z.string(),
    description,
    tldr,
    changelogSuggestion: z.string().nullable().optional(),
    tags,
    links: z.array(z.string()),
    ...lifecycle,
    governs: z.string().optional(),
    topic: z.string().optional(),
    supersedes: z.string().optional(),
    ...decisionAuthority,
    approvalFingerprint: z.string().optional(),
    room: z.string(),
    decisions: z.array(decisionTopic),
    predecessors: z.array(directoryEntry).optional(),
    successors: z.array(directoryEntry).optional(),
    resolution: decisionTopic.nullable().optional(),
    blocks: readBlocks,
    annotations: z.array(annotation),
    data: z.object({ collections: z.array(collectionCount), readWith: z.literal("get_data") }).strict().optional(),
  }).strict(),
  get_data: getData,
  update_data: z.object({
    uuid,
    changed: z.boolean(),
    collections: z.array(collectionCount.extend({ deleted: z.boolean() }).strict()),
    ...documentDurability,
  }).strict(),
  list_docs: z.object({
    workspace: z.string(),
    docs: z.array(z.union([
      directoryEntry.extend({ pinned: z.boolean() }).strict(),
      decisionTopic.extend({ pinned: z.boolean() }).strict(),
    ])),
    hub,
  }).strict(),
  search: z.object({
    query: z.string(),
    tag: z.string().optional(),
    hits: z.array(z.object({ uuid, title: z.string(), description, tags, snippet: z.string() }).strict()),
  }).strict(),
  backlinks: z.object({
    uuid,
    backlinks: z.array(z.object({ uuid, title: z.string(), description }).strict()),
  }).strict(),
  find_decisions: z.object({
    github_ref: z.string(),
    decisions: z.array(z.object({ uuid, title: z.string(), status: status.nullable() }).strict()),
  }).strict(),
  edit_block: z.object({ uuid, block: block.nullable(), ...documentDurability, ...contentReview }).strict(),
  insert_block: z.object({ uuid, block: block.nullable(), ...documentDurability, ...contentReview }).strict(),
  delete_block: z.object({ uuid, blockId: z.string(), ...documentDurability, ...contentReview }).strict(),
  set_metadata: z.object({
    uuid,
    ...documentDurability,
    title: z.string(),
    description,
    tldr,
    tags,
    links: z.array(z.string()),
  }).strict(),
  set_status: z.object({
    uuid,
    kind: z.enum(DOCUMENT_KINDS),
    status,
    ...decisionAuthority,
    ...documentDurability,
  }).strict(),
  archive_doc: z.object({
    uuid,
    title: z.string(),
    records: z.array(z.string()),
    archived: z.literal(true),
    unpinned: z.literal(true),
    indexed: z.boolean(),
    ...multipleRoomDurability,
  }).strict(),
  restore_doc: z.object({
    uuid,
    title: z.string(),
    records: z.array(z.string()),
    archived: z.literal(false),
    indexed: z.boolean(),
    ...multipleRoomDurability,
  }).strict(),
  annotate: z.object({ uuid, annotation, ...documentDurability }).strict(),
  link_range: z.object({ uuid, blockId: z.string(), docId: z.string(), title: z.string(), rev: z.string(), ...documentDurability }).strict(),
  export_markdown: z.object({ uuid, markdown: z.string() }).strict(),
  sync_status: z.object({
    session: z.string(),
    agent: z.string(),
    workspace: z.string(),
    database: z.string(),
    hub,
    unsyncedChanges: count.describe("Number of rooms with local changes not acknowledged by the hub."),
    pendingRooms: z.array(z.object({ room: z.string(), seq: count }).strict()),
    lastSync: z.string().nullable(),
    inFlightUpdates: count.describe("Provider sync messages awaiting acknowledgement on this connection."),
    rooms: z.array(z.object({ room: z.string(), appliedSeq: count, synced: durability.synced }).strict()),
    logEntries: count,
    persistence: z.object({ room: z.string(), message: z.string() }).strict().nullable(),
  }).strict(),
  get_sidebar: z.object({ ...sidebar, hub }).strict(),
  pin_doc: z.object({ uuid, group: groupIdentity, moved: z.boolean(), ...sidebar, ...durability }).strict(),
  unpin_doc: z.object({ uuid, unpinned: z.boolean(), ...sidebar, ...durability }).strict(),
  sidebar_group: z.object({ action: z.enum(["rename", "delete", "move"]), group: groupIdentity, ...sidebar, ...durability }).strict(),
} satisfies Record<string, z.ZodObject>;

export type OutputToolName = keyof typeof outputSchemas;
