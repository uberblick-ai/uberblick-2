import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  deleteDecisionTopic,
  DIRECTORY_DELETED_DECISION_TOPICS_KEY,
  decisionTopicArchived,
  enforceDeletedDirectoryEntries,
  getDirectoryEntry,
  getDirectoryMap,
  isDirectoryEntryDeleted,
  listDeletedDirectoryUuids,
  listDirectory,
  relatedDecisionTopics,
  resolveDecisionTopics,
  restoreDirectoryEntry,
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
