import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  deleteDecisionTopic,
  deleteDecisionRecord,
  decisionRelations,
  decisionTopicState,
  DIRECTORY_ARCHIVED_RECORDS_KEY,
  DIRECTORY_DELETED_DECISION_RECORDS_KEY,
  DIRECTORY_DELETED_DECISION_TOPICS_KEY,
  decisionTopicArchived,
  enforceDeletedDirectoryEntries,
  getDirectoryEntry,
  getDirectoryMap,
  initDoc,
  isDirectoryEntryDeleted,
  listDeletedDirectoryUuids,
  listDirectory,
  relatedDecisionTopics,
  repairDirectoryStub,
  resolveDecisionTopics,
  restoreDirectoryEntry,
  setKind,
  tombstoneDecisionRecord,
  tombstoneDirectoryEntry,
  upsertDirectoryEntry,
} from "../src/index.js";
import { syncDocs } from "./helpers.js";

const TOPIC = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const FORMER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CURRENT = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const LATE = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const RELATED = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

function seed(directory: Y.Doc): void {
  upsertDirectoryEntry(directory, { uuid: TOPIC, title: "Question", kind: "decision", topic: TOPIC, status: "decided", related: [RELATED] });
  upsertDirectoryEntry(directory, { uuid: FORMER, title: "Former", kind: "decision", topic: TOPIC, supersedes: TOPIC, status: "decided" });
  upsertDirectoryEntry(directory, { uuid: CURRENT, title: "Current", kind: "decision", topic: TOPIC, supersedes: FORMER, status: "decided" });
}

describe("permanent decision topic deletion", () => {
  it("uses retained topic UUIDs only as evidence for an existing deletion mark", () => {
    const directory = new Y.Doc();
    try {
      seed(directory);
      tombstoneDirectoryEntry(directory, TOPIC);
      deleteDecisionTopic(directory, TOPIC);
      directory.getMap(DIRECTORY_DELETED_DECISION_TOPICS_KEY).set(LATE, TOPIC);
      enforceDeletedDirectoryEntries(directory);
      expect(isDirectoryEntryDeleted(directory, LATE)).toBe(false);
      expect(listDeletedDirectoryUuids(directory)).not.toContain(LATE);
      expect(directory.getMap("deleted-docs").has(LATE)).toBe(false);
    } finally { directory.destroy(); }
  });

  it.each([TOPIC, FORMER, CURRENT])("deletes every record through %s, including separate archives", (selected) => {
    const directory = new Y.Doc();
    try {
      seed(directory);
      expect(tombstoneDecisionRecord(directory, FORMER)).toBe(true);
      tombstoneDirectoryEntry(directory, CURRENT);
      expect(deleteDecisionTopic(directory, selected)).toEqual([TOPIC, FORMER, CURRENT]);
      expect(listDeletedDirectoryUuids(directory)).toEqual([TOPIC, FORMER, CURRENT]);
      for (const uuid of [TOPIC, FORMER, CURRENT]) {
        expect(isDirectoryEntryDeleted(directory, uuid)).toBe(true);
        expect(getDirectoryEntry(directory, uuid)).toBeNull();
        expect(getDirectoryMap(directory).has(uuid)).toBe(false);
      }
      expect(listDirectory(directory, { includeDeleted: true })).toEqual([]);
      expect(resolveDecisionTopics(directory)).toEqual([]);
      expect(relatedDecisionTopics(resolveDecisionTopics(directory), { uuid: RELATED })).toEqual([]);
    } finally { directory.destroy(); }
  });

  it.each(["after archive", "after deletion"])("keeps an unseen successor arriving %s under the topic authority", (arrival) => {
    const directory = new Y.Doc();
    const offline = new Y.Doc();
    try {
      seed(directory);
      syncDocs(directory, offline);
      tombstoneDirectoryEntry(directory, TOPIC);
      if (arrival === "after deletion") deleteDecisionTopic(directory, TOPIC);
      upsertDirectoryEntry(offline, {
        uuid: LATE, title: "Offline proposal", kind: "decision", topic: TOPIC, supersedes: CURRENT, status: "open",
      });
      if (arrival === "after deletion") {
        upsertDirectoryEntry(offline, { uuid: TOPIC, title: "Offline rename" });
        restoreDirectoryEntry(offline, TOPIC);
      }
      Y.applyUpdate(directory, Y.encodeStateAsUpdate(offline));
      expect(listDirectory(directory)).toEqual([]);
      if (arrival === "after archive") {
        expect(decisionTopicArchived(directory, LATE)).toBe(true);
        expect(resolveDecisionTopics(directory)[0]?.archived).toBe(true);
        expect(deleteDecisionTopic(directory, LATE)).toEqual([TOPIC, FORMER, CURRENT, LATE]);
      }
      expect(isDirectoryEntryDeleted(directory, LATE)).toBe(true);
      expect(getDirectoryEntry(directory, LATE)).toBeNull();
      expect(resolveDecisionTopics(directory)).toEqual([]);
      enforceDeletedDirectoryEntries(directory);
      expect(directory.getMap("deleted-docs").get(LATE)).toBe(true);
      expect(getDirectoryMap(directory).has(LATE)).toBe(false);
      syncDocs(directory, offline);
      enforceDeletedDirectoryEntries(offline);
      expect(listDeletedDirectoryUuids(offline)).toEqual([TOPIC, FORMER, CURRENT, LATE]);
      expect(listDirectory(offline, { includeDeleted: true })).toEqual([]);
      expect(resolveDecisionTopics(offline)).toEqual([]);
    } finally { directory.destroy(); offline.destroy(); }
  });
});

describe("permanent decision record deletion", () => {
  it("deletes a middle record without changing its successors or creating a conflict", () => {
    const directory = new Y.Doc();
    try {
      seed(directory);
      tombstoneDirectoryEntry(directory, TOPIC);
      const current = getDirectoryMap(directory).get(CURRENT);
      expect(deleteDecisionRecord(directory, FORMER)).toBe(true);
      const topic = resolveDecisionTopics(directory)[0]!;
      expect(topic.allRecords.map((record) => record.uuid)).toEqual([TOPIC, CURRENT]);
      expect(topic.inForce?.uuid).toBe(CURRENT);
      expect(topic.conflicts).toEqual([]);
      expect(topic.archived).toBe(true);
      expect(getDirectoryMap(directory).get(CURRENT)).toEqual(current);
      expect(getDirectoryEntry(directory, CURRENT)?.supersedes).toBe(TOPIC);
      expect(decisionRelations(directory, CURRENT).predecessors.map((record) => record.uuid)).toEqual([TOPIC]);
      expect(decisionRelations(directory, TOPIC).successors.map((record) => record.uuid)).toEqual([CURRENT]);
      expect(decisionRelations(directory, FORMER)).toEqual({ predecessors: [], successors: [], resolution: null });
      expect(resolveDecisionTopics(listDirectory(directory, { includeDeleted: true }))).toEqual([topic]);
      restoreDirectoryEntry(directory, TOPIC);
      const restored = resolveDecisionTopics(directory)[0]!;
      expect(restored.archived).toBe(false);
      expect(restored.allRecords.map((record) => record.uuid)).toEqual([TOPIC, CURRENT]);
      expect(restored.inForce?.uuid).toBe(CURRENT);
      expect(isDirectoryEntryDeleted(directory, FORMER)).toBe(true);
    } finally { directory.destroy(); }
  });

  it("walks several deleted predecessors and brings back the last remaining decided answer", () => {
    const directory = new Y.Doc();
    try {
      seed(directory);
      upsertDirectoryEntry(directory, { uuid: LATE, title: "Latest", kind: "decision", topic: TOPIC, supersedes: CURRENT, status: "decided" });
      tombstoneDirectoryEntry(directory, TOPIC);
      expect(deleteDecisionRecord(directory, FORMER)).toBe(true);
      expect(deleteDecisionRecord(directory, CURRENT)).toBe(true);
      expect(resolveDecisionTopics(directory)[0]!.inForce?.uuid).toBe(LATE);
      expect(decisionRelations(directory, LATE).predecessors.map((record) => record.uuid)).toEqual([TOPIC]);
      expect(deleteDecisionRecord(directory, LATE)).toBe(true);
      expect(resolveDecisionTopics(directory)[0]!.inForce?.uuid).toBe(TOPIC);
      expect(resolveDecisionTopics(directory)[0]!.records.map((record) => record.uuid)).toEqual([TOPIC]);
      const before = Y.encodeStateAsUpdate(directory);
      expect(deleteDecisionRecord(directory, TOPIC)).toBe(false);
      expect(Y.encodeStateAsUpdate(directory)).toEqual(before);
    } finally { directory.destroy(); }
  });

  it("repairs surviving raw metadata without repeatedly writing its projected predecessor", () => {
    const directory = new Y.Doc();
    const document = new Y.Doc();
    try {
      seed(directory);
      initDoc(document, { uuid: CURRENT, title: "Current", topic: TOPIC, supersedes: FORMER });
      setKind(document, "decision");
      repairDirectoryStub(document, directory, CURRENT, { now: 123, changedAt: null, coarsenessMs: 100 });
      tombstoneDirectoryEntry(directory, TOPIC);
      expect(deleteDecisionRecord(directory, FORMER)).toBe(true);
      expect(getDirectoryEntry(directory, CURRENT)?.supersedes).toBe(TOPIC);
      const before = Y.encodeStateAsUpdate(directory);
      repairDirectoryStub(document, directory, CURRENT, { now: 124, changedAt: null, coarsenessMs: 100 });
      expect(Y.encodeStateAsUpdate(directory)).toEqual(before);
    } finally { directory.destroy(); document.destroy(); }
  });

  it.each(["open", "rejected", "withdrawn"] as const)("leaves an undecided topic when only %s records remain", (status) => {
    const directory = new Y.Doc();
    try {
      upsertDirectoryEntry(directory, { uuid: TOPIC, title: "Question", kind: "decision", topic: TOPIC, status });
      upsertDirectoryEntry(directory, { uuid: CURRENT, title: "Answer", kind: "decision", topic: TOPIC, supersedes: TOPIC, status: "decided" });
      tombstoneDirectoryEntry(directory, TOPIC);
      expect(deleteDecisionRecord(directory, CURRENT)).toBe(true);
      const topic = resolveDecisionTopics(directory)[0]!;
      expect(topic.inForce).toBeNull();
      expect(topic.conflicts).toEqual([]);
      expect(decisionTopicState(topic)).toBe("not-yet-decided");
      expect(topic.pending.map((record) => record.uuid)).toEqual(status === "open" ? [TOPIC] : []);
    } finally { directory.destroy(); }
  });

  it("preserves independent conflicting answers and removes a deleted pending record", () => {
    const directory = new Y.Doc();
    try {
      seed(directory);
      upsertDirectoryEntry(directory, { uuid: LATE, title: "Competing answer", kind: "decision", topic: TOPIC, supersedes: TOPIC, status: "decided" });
      upsertDirectoryEntry(directory, { uuid: RELATED, title: "Proposal", kind: "decision", topic: TOPIC, supersedes: CURRENT, status: "open" });
      tombstoneDirectoryEntry(directory, TOPIC);
      expect(deleteDecisionRecord(directory, FORMER)).toBe(true);
      expect(deleteDecisionRecord(directory, RELATED)).toBe(true);
      const topic = resolveDecisionTopics(directory)[0]!;
      expect(topic.conflicts.map((record) => record.uuid)).toEqual([CURRENT, LATE]);
      expect(topic.pending).toEqual([]);
      expect(topic.inForce).toBeNull();
    } finally { directory.destroy(); }
  });

  it("refuses a live topic and its first record without writing", () => {
    const directory = new Y.Doc();
    try {
      seed(directory);
      let before = Y.encodeStateAsUpdate(directory);
      expect(deleteDecisionRecord(directory, FORMER)).toBe(false);
      expect(deleteDecisionRecord(directory, TOPIC)).toBe(false);
      expect(Y.encodeStateAsUpdate(directory)).toEqual(before);
      tombstoneDirectoryEntry(directory, TOPIC);
      before = Y.encodeStateAsUpdate(directory);
      expect(deleteDecisionRecord(directory, TOPIC)).toBe(false);
      expect(Y.encodeStateAsUpdate(directory)).toEqual(before);
    } finally { directory.destroy(); }
  });

  it("keeps only the UUID mark and graph edges, including for a live stub that joined an archived topic", () => {
    const directory = new Y.Doc();
    const compacted = new Y.Doc();
    try {
      seed(directory);
      tombstoneDirectoryEntry(directory, TOPIC);
      upsertDirectoryEntry(directory, {
        uuid: LATE, title: "private deleted title", tags: ["private deleted tag"], kind: "decision", topic: TOPIC,
        supersedes: CURRENT, status: "open", description: "private deleted description", answerPreview: "private deleted answer",
        related: [RELATED], updatedAt: 123, commentCount: 2,
      });
      expect(getDirectoryEntry(directory, LATE)?.deleted).toBeUndefined();
      expect(deleteDecisionRecord(directory, LATE)).toBe(true);
      expect(directory.getMap("deleted-docs").get(LATE)).toBe(true);
      expect(getDirectoryMap(directory).get(LATE)).toEqual({ deleted: true });
      expect(directory.getMap(DIRECTORY_DELETED_DECISION_RECORDS_KEY).get(LATE)).toEqual({ topic: TOPIC, supersedes: CURRENT });
      expect(directory.getMap("decision-related-pages").has(LATE)).toBe(false);
      expect([...directory.getMap("updatedAt").keys()].some((key) => key.startsWith(LATE))).toBe(false);
      expect(getDirectoryEntry(directory, LATE)).toBeNull();
      expect(listDeletedDirectoryUuids(directory)).toEqual([LATE]);
      Y.applyUpdate(compacted, Y.encodeStateAsUpdate(directory));
      expect(Buffer.from(Y.encodeStateAsUpdate(compacted)).toString("utf8")).not.toContain("private deleted");
      getDirectoryMap(directory).set(LATE, { title: "stale private title", tags: [], kind: "decision", topic: TOPIC });
      enforceDeletedDirectoryEntries(directory);
      expect(getDirectoryMap(directory).get(LATE)).toEqual({ deleted: true });
      getDirectoryMap(directory).delete(LATE);
      enforceDeletedDirectoryEntries(directory);
      expect(getDirectoryMap(directory).has(LATE)).toBe(false);
    } finally { directory.destroy(); compacted.destroy(); }
  });

  it("removes a separately archived record's archive mark and removes witnesses when deleting the topic", () => {
    const directory = new Y.Doc();
    try {
      seed(directory);
      expect(tombstoneDecisionRecord(directory, FORMER)).toBe(true);
      tombstoneDirectoryEntry(directory, TOPIC);
      expect(deleteDecisionRecord(directory, FORMER)).toBe(true);
      expect(directory.getMap(DIRECTORY_ARCHIVED_RECORDS_KEY).has(FORMER)).toBe(false);
      deleteDecisionTopic(directory, TOPIC);
      expect(getDirectoryMap(directory).has(FORMER)).toBe(false);
      expect(resolveDecisionTopics(directory)).toEqual([]);
    } finally { directory.destroy(); }
  });

  it("never treats graph references as a deletion mark or crosses a foreign topic", () => {
    const directory = new Y.Doc();
    try {
      seed(directory);
      directory.getMap(DIRECTORY_DELETED_DECISION_RECORDS_KEY).set(FORMER, { topic: TOPIC, supersedes: TOPIC });
      expect(isDirectoryEntryDeleted(directory, FORMER)).toBe(false);
      expect(getDirectoryEntry(directory, CURRENT)?.supersedes).toBe(FORMER);
      directory.getMap("deleted-docs").set(FORMER, true);
      directory.getMap(DIRECTORY_DELETED_DECISION_RECORDS_KEY).set(FORMER, { topic: LATE, supersedes: TOPIC });
      enforceDeletedDirectoryEntries(directory);
      expect(getDirectoryEntry(directory, CURRENT)?.supersedes).toBe(FORMER);
      expect(resolveDecisionTopics(directory)[0]!.conflicts.map((record) => record.uuid)).toEqual([TOPIC, CURRENT]);
    } finally { directory.destroy(); }
  });
});
