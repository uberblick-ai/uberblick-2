import { CODE_CHECK_RESULTS, DECISION_STATUSES, DOCUMENT_KINDS, LIST_STYLES, MAX_LIST_INDENT } from "@uberblick/schema";
import { z } from "zod";
import { strictInput } from "./inputs.js";

const count = z.number().int().nonnegative();
const uuid = z.string().describe("Document identity; a UUID, never a title or path.");
const description = z.string().nullable().describe("Agent-facing document description; null when unwritten.");
const tldr = z.string().nullable().describe("Person-facing regular-document summary; null when unwritten and always null for decisions, which have no TL;DR.");
const discussion = z.string().nullable().describe("Explicit RFC discussion document UUID for this decision record; null when none. Distinct from curated links and the recorded answer.");
const status = z.enum(DECISION_STATUSES);
const codeChecks = z.array(z.object({
  repository: z.string().describe("Canonical lowercase repository as owner/name."),
  commit: z.string().describe("Full hexadecimal commit compared with the page."),
  checked_at: z.string().describe("UTC time this comparison was recorded by its writing replica."),
  result: z.enum(CODE_CHECK_RESULTS).describe("matches: page describes this code; ahead: intended behavior is missing; drift: unintended disagreement."),
  rev: z.string().optional().describe("Page revision read by this comparison; absent on legacy or older-client entries, whose compared text is unknown."),
  paths: z.array(z.string()).optional().describe("Repo-relative files or folders looked at; trailing / marks a folder. Hints, not a complete dependency list; absent when unrecorded."),
}).strict()).describe("Latest code comparison per repository on a regular page; content edits leave these entries unchanged. Empty means never checked.");
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
  status: z.enum(["disabled", "connecting", "connected", "hub-down", "auth-failed", "update-required", "quarantined", "local"]),
  url: z.string().nullable().describe("Configured hub endpoint; null when synchronization is disabled."),
  reason: z.string().optional(),
  recoveryClass: z.enum(["retry", "manual"]).optional(),
  authRecovery: z.enum(["sign-in-required", "no-workspace-access", "credential-store", "renewal-unavailable"]).optional(),
  protocolVersion: z.number().int().describe("This client's sync protocol version, including while offline."),
  hubProtocolVersion: z.number().int().optional().describe("Hub protocol version, learned from a protocol refusal."),
}).strict().describe("Current connection state; an acknowledgement does not claim hub storage.");

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
  tldr: z.null().optional().describe("Present when changed regular document content has no TL;DR and the page has not opted out."),
  tldrHint: z.string().optional().describe("Non-blocking request to review the TL;DR after changing regular document content; absent for decision records and pages with a deliberate TL;DR removal."),
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

const tag = z.object({ id: z.string(), name: z.string(), description: z.string().optional() }).strict();
const tags = z.array(tag).describe("Existing catalog tags with canonical identities, names and optional descriptions.");
const searchHitFields = { uuid, title: z.string(), description, tags, snippet: z.string() };
const searchHit = z.union([
  z.object({
    ...searchHitFields,
    kind: z.literal("regular").describe("A regular document, including a stored requirement."),
  }).strict(),
  z.object({
    ...searchHitFields,
    kind: z.literal("decision").describe("A decision record."),
    state: z.enum(["in-force", "superseded", "open", "rejected", "withdrawn", "conflict"])
      .describe("Resolved from current topic records: in-force is the current answer; superseded is a replaced answer; conflict marks competing approved answers; open, rejected and withdrawn are proposal states."),
  }).strict(),
]);

const directoryEntry = z.object({
  uuid,
  title: z.string(),
  tags,
  description,
  deleted: z.boolean().optional().describe("Archived state. Permanently deleted documents never appear in directory results."),
  createdAt: z.string().optional().describe("Creation time as an ISO 8601 UTC string on the creating replica's clock. Absent when unknown or unrepresentable."),
  updatedAt: z.string().optional().describe("Approximate edit time as an ISO 8601 UTC string on the authoring replica's clock. Absent when unknown or unrepresentable."),
  ...lifecycle,
  related: z.array(z.string()).optional().describe("All regular page UUIDs this record relates to, fixed at creation."),
  topic: z.string().optional(),
  supersedes: z.string().optional(),
  answerPreview: z.string().nullable().optional().describe("Cached decision answer preview from the first paragraph or list, truncated to 300 characters. Null when neither exists; absent when the cache is unknown."),
  discussion: discussion.optional().describe("Cached RFC discussion document UUID; null when none, absent when the cache is unknown."),
  agentStance: z.boolean().optional(),
  decidedBy: z.string().optional(),
  decidedAt: z.string().optional(),
  approvalChanged: z.boolean().optional(),
  commentCount: count.optional(),
  openThreadCount: count.optional().describe("Cached count of this document's threads whose resolved is not true, including deleted anchors. Absent when unknown; each decision entry, including inForce, pending and conflicts, has its own count."),
  code_check: codeChecks.optional().describe("Cached latest code comparisons on regular documents; empty means never checked, absent means not cached yet. Decision records omit this field. Content edits leave checks unchanged."),
}).strict();
const topicRecords = {
  inForce: z.string().nullable().describe("UUID of the record in force, or null when the topic has no answer in force."),
  pending: z.array(z.string()).describe("UUIDs of pending records."),
  conflicts: z.array(z.string()).describe("UUIDs of conflicting decided records."),
};
const listEntry = z.object({
  uuid,
  title: z.string(),
  tags,
  description,
  updatedAt: z.string().optional().describe("Approximate edit time as an ISO 8601 UTC string on the authoring replica's clock. Absent when unknown or unrepresentable."),
  openThreadCount: count.optional().describe("Cached count of this document's threads whose resolved is not true. Absent when unknown."),
  deleted: z.literal(true).optional().describe("Archived; only listed with include_deleted."),
  pinned: z.boolean(),
}).strict();
const listDecision = listEntry.extend({
  kind: z.literal("decision"),
  status: status.optional(),
  related: z.array(z.string()).optional().describe("All regular page UUIDs related to this representative record, or this record in per-record listings."),
  topic: z.string().optional().describe("First record's UUID identifying this decision topic."),
  discussion: discussion.optional().describe("Cached RFC discussion document UUID; null when none, absent when the cache is unknown."),
  answerPreview: z.string().nullable().optional().describe("First answer paragraph or list, at most 300 characters; null when neither exists, absent when unknown."),
  inForce: z.string().nullable().optional().describe("Topic rows: UUID of the record in force, or null."),
  pending: z.array(z.string()).optional().describe("Topic rows: UUIDs of pending records."),
  conflicts: z.array(z.string()).optional().describe("Topic rows: UUIDs of conflicting decided records."),
}).strict();
const pageDecision = listDecision.omit({ pinned: true }).extend({
  ...topicRecords,
  relation: z.enum(["related", "linked"]).describe("Related page membership takes precedence over an indexed link from any record in the topic."),
}).strict();

const docLink = z.object({
  start: count,
  end: count,
  docId: z.string(),
}).strict();
const blockFields = {
  id: z.string(),
  text: z.string().describe("Plain prose or source text; tables carry canonical GFM, while cards and Figma blocks carry canonical container content with inline formatting."),
  rev: z.string().describe("Content hash to assert on a later block edit."),
};
const linkRanges = {
  doc_links: z.array(docLink).optional().describe("Prose character ranges that reference documents; absent when there are none."),
};
function blockSchema(withLinks: boolean, withRev = true) {
  const fields = { id: blockFields.id, text: blockFields.text, ...(withRev ? { rev: blockFields.rev } : {}) };
  const prose = { ...fields, ...(withLinks ? linkRanges : {}) };
  return z.union([
    z.object({ ...prose, type: z.enum(["paragraph", "quote"]) }).strict(),
    z.object({ ...prose, type: z.literal("heading"), level: z.number().int().min(1).max(6) }).strict(),
    z.object({ ...prose, type: z.literal("list-item"), list: z.enum(LIST_STYLES), indent: z.number().int().min(0).max(MAX_LIST_INDENT) }).strict(),
    z.object({ ...fields, type: z.literal("code"), language: z.string() }).strict(),
    z.object({ ...fields, type: z.enum(["table", "terminal", "chart", "card"]) }).strict(),
    z.object({ ...fields, type: z.literal("figma"), figma: z.object({
      kind: z.enum(["frame", "file", "prototype", "board", "slides", "community file"]),
      file: z.string(),
      fileName: z.string().optional(),
      node: z.string().optional(),
    }).strict().optional().describe("Read-only view identity derived from the normalized Figma link; absent when the stored link cannot be normalized.") }).strict(),
  ]);
}
const writtenBlock = z.object({ id: z.string(), rev: blockFields.rev }).strict();
const readBlocks = z.array(blockSchema(true)).describe("Visible document blocks in stored order.");
const annotation = z.object({
  id: z.string(),
  blockId: z.string().describe("Block containing range; the recorded block id when range is null."),
  comments: z.array(z.object({ author: z.string(), text: z.string(), createdAt: z.string() }).strict()),
  resolved: z.boolean().optional(),
  range: z.object({
    row: count.optional(),
    column: count.optional(),
    part: z.enum(["label", "title", "body", "footer", "caption"]).optional(),
    start: count,
    end: count,
    collapsed: z.boolean(),
  }).strict().nullable().describe("Current anchored range in blockId, or null when no visible block carries the thread's mark."),
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
const revisionId = z.string().describe("Hub revision ID from list_revisions, distinct from page and block rev hashes.");

/**
 * The SDK requires a root object; strictInput validates each mode through this
 * advertised superset.
 */
const getData = strictInput({
  uuid,
  revision: revisionId.optional().describe("Present when reading this hub revision's data instead of the live document."),
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

const revisionAuthor = z.object({
  githubUsername: z.string().describe("Current GitHub username."),
  surface: z.object({ kind: z.string(), name: z.string() }).strict(),
}).strict().nullable();
const revisionName = z.object({
  text: z.string(),
  namer: revisionAuthor.describe("Account and surface that named the revision; separate from its author."),
  namedAt: z.string().describe("Naming time as an ISO 8601 UTC string; renaming preserves this time."),
  canManage: z.boolean().describe("Whether this account may rename or remove this name."),
}).strict().nullable();
const revisionEntry = z.object({
  id: revisionId,
  author: revisionAuthor.describe("Verified GitHub account and surface, or null when unknown."),
  startedAt: z.string().nullable().describe("Start as an ISO 8601 UTC string; null only for content predating history."),
  endedAt: z.string().nullable().describe("End as an ISO 8601 UTC string; null means this revision is still open."),
  name: revisionName.describe("The revision's name, namer and time, or null when unnamed."),
}).strict();

/** All registered tools use these exact objects for advertisement and checking. */
export const outputSchemas = {
  get_help: getHelp,
  list_revisions: z.object({
    uuid,
    revisions: z.array(revisionEntry).describe("Hub-confirmed revisions, newest first; empty only when the hub confirms no history."),
  }).strict(),
  name_revision: z.object({
    uuid,
    revision: revisionEntry,
    applied: z.literal(true).describe("The name was applied in the hub's revision store; no local document-log write is made."),
    synced: z.literal(true).describe("The hub acknowledged this naming transaction."),
    hub,
  }).strict(),
  restore_revision: z.object({
    uuid,
    revision: revisionEntry,
    applied: z.boolean().describe("True when restored; false when the live title, blocks and data already match, with no new revision."),
    synced: z.literal(true).describe("The hub acknowledged this restore result; content arrives through normal sync."),
    hub,
  }).strict(),
  get_revision: z.object({
    uuid,
    revision: revisionId,
    title: z.string(),
    blocks: z.array(blockSchema(true, false)).describe("Historical visible blocks in stored order, without edit-assertion rev hashes."),
    data: dataSummary.nullable(),
  }).strict(),
  list_tags: z.object({
    workspace: z.string(),
    complete: z.boolean(),
    catalogHint: z.string().optional().describe("Why tags may be missing; present only when complete is false."),
    tags,
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
    related: z.array(z.string()).optional().describe("All related regular page UUIDs, fixed at creation."),
    topic: z.string().optional(),
    supersedes: z.string().optional(),
    discussion: discussion.optional(),
    tldr: tldr.optional(),
    tldrHint: contentReview.tldrHint.optional(),
    ...decisionAuthority,
    blocks: z.array(writtenBlock).describe("Created blocks in order; read their content with get_doc."),
    sidebar: z.object({ group: groupIdentity, position: z.number().int() }).strict().optional(),
  }).strict(),
  get_doc: z.object({
    uuid,
    createdAt: z.string().optional().describe("Creation time as an ISO 8601 UTC string on the creating replica's clock. Absent when unknown or unrepresentable."),
    rev: z.string().describe("Revision of the page's ordered block content, identical to the web status row. Applies to regular pages and decisions; excludes metadata and comments."),
    title: z.string(),
    description,
    tldr,
    code_check: codeChecks.optional().describe("Regular documents return their latest comparison per repository, or [] when never checked. Decision records omit this field. Content edits leave checks unchanged."),
    tldrOptOut: z.literal(true).optional().describe("Present only when a person removed a regular page's TL;DR on purpose and tldr is null. Content writes omit TL;DR hints. To opt back in, pass tldr_opt_in: true with a non-null tldr to set_metadata; the web's Add TL;DR also lifts the mark. Absent when summary text exists and on decision records."),
    tags,
    links: z.array(z.string()),
    ...lifecycle,
    related: z.array(z.string()).optional().describe("All related regular page UUIDs, fixed at creation."),
    topic: z.string().optional(),
    supersedes: z.string().optional(),
    discussion: discussion.optional(),
    ...decisionAuthority,
    approvalFingerprint: z.string().optional(),
    room: z.string(),
    decisions: z.array(pageDecision).describe("Decision topics of a regular page, one row each; get_doc a listed UUID for its record."),
    predecessors: z.array(directoryEntry).optional(),
    successors: z.array(directoryEntry).optional(),
    resolution: z.object({ ...topicRecords, archived: z.boolean() }).strict().nullable().optional()
      .describe("This record's topic state by record UUID; null when the topic cannot be resolved."),
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
    complete: z.boolean().describe("Whether the hub has delivered the whole document directory to this replica."),
    directoryHint: z.string().optional().describe("Why documents may be missing; present only when complete is false."),
    docs: z.array(z.union([listEntry, listDecision])),
    hub,
  }).strict(),
  search: z.object({
    query: z.string(),
    tag: z.union([z.string(), z.array(z.string())]).optional(),
    kind: z.enum(["regular", "decision"]).optional(),
    hits: z.array(searchHit),
  }).strict(),
  backlinks: z.object({
    uuid,
    backlinks: z.array(z.object({ uuid, title: z.string(), description }).strict()),
  }).strict(),
  find_decisions: z.object({
    github_ref: z.string(),
    decisions: z.array(z.object({ uuid, title: z.string(), status: status.nullable() }).strict()),
  }).strict(),
  edit_block: z.object({ uuid, block: writtenBlock.nullable(), ...documentDurability, ...contentReview }).strict(),
  insert_block: z.object({ uuid, blocks: z.array(writtenBlock).min(1), ...documentDurability, ...contentReview }).strict(),
  move_block: z.object({
    uuid,
    blocks: z.array(writtenBlock).min(1),
    ...documentDurability,
    ...contentReview,
  }).strict(),
  delete_block: z.object({ uuid, blockId: z.string(), ...documentDurability, ...contentReview }).strict(),
  set_metadata: z.object({
    uuid,
    ...documentDurability,
    rooms: z.array(touchedRoom).optional().describe("Independently persisted document, topic-title and directory rooms when a rename targets another record; top-level synced is their conjunction."),
    title: z.string(),
    description,
    tldr,
    code_check: codeChecks.optional(),
    tags,
    links: z.array(z.string()),
    discussion: discussion.optional(),
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
    archived: z.boolean().describe("Whether the addressed document remains archived after removing one archive layer."),
    indexed: z.boolean(),
    ...multipleRoomDurability,
  }).strict(),
  delete_doc: z.object({
    uuid,
    title: z.string(),
    records: z.array(z.string()).describe("Every UUID permanently deleted by this call: the regular document or every record of the decision topic."),
    deleted: z.literal(true).describe("The archived document or decision topic was permanently deleted; its record UUIDs cannot be restored or reused."),
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
    caughtUp: z.boolean().describe("Nothing is waiting to reach or arrive from the hub; check this before reporting work as delivered."),
    unsyncedChanges: count.describe("Number of rooms with local changes not acknowledged by the hub."),
    pendingRooms: z.array(z.object({ room: z.string(), seq: count }).strict()),
    lastSync: z.string().nullable(),
    inFlightUpdates: count.describe("Provider sync messages awaiting acknowledgement on this connection."),
    rooms: z.array(z.object({ room: z.string(), appliedSeq: count, synced: durability.synced }).strict()),
    logEntries: count,
    persistence: z.object({ room: z.string(), message: z.string() }).strict().nullable(),
  }).strict(),
  get_sidebar: z.object({ ...sidebar, hub }).strict(),
  pin_doc: z.object({ uuid, group: groupIdentity, moved: z.boolean(), ...durability }).strict(),
  unpin_doc: z.object({
    uuid,
    unpinned: z.boolean(),
    groupHint: z.string().optional().describe("Present when this unpin left its group empty: how to delete the group."),
    ...durability,
  }).strict(),
  sidebar_group: z.object({ action: z.enum(["rename", "delete", "move"]), group: groupIdentity, ...sidebar, ...durability }).strict(),
} satisfies Record<string, z.ZodObject>;
