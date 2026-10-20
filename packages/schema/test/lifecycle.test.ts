import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  archiveDocument,
  archiveDecisionRecord,
  createGroup,
  getDirectoryEntry,
  listDirectory,
  pinDoc,
  readSidebar,
  upsertDirectoryEntry,
} from "../src/index.js";
import { syncDocs } from "./helpers.js";

const TOPIC = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SUCCESSOR = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OTHER_RECORD = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const NEIGHBOR = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

describe("archiveDocument", () => {
  it("unpins only an individually archived record while preserving the first record's topic pin", () => {
    const directory = new Y.Doc();
    const sidebar = new Y.Doc();
    for (const uuid of [TOPIC, SUCCESSOR, OTHER_RECORD]) {
      upsertDirectoryEntry(directory, { uuid, title: uuid, kind: "decision", status: "open", topic: TOPIC });
    }
    const group = createGroup(sidebar, "Reading");
    for (const uuid of [TOPIC, SUCCESSOR, OTHER_RECORD]) pinDoc(sidebar, group, uuid);
    expect(archiveDecisionRecord(directory, sidebar, TOPIC)).toBe(true);
    expect(readSidebar(sidebar)[0]?.docs).toEqual([TOPIC, SUCCESSOR, OTHER_RECORD]);
    expect(archiveDecisionRecord(directory, sidebar, SUCCESSOR)).toBe(true);
    expect(readSidebar(sidebar)[0]?.docs).toEqual([TOPIC, OTHER_RECORD]);
    expect(archiveDecisionRecord(directory, sidebar, OTHER_RECORD)).toBe(false);
    expect(readSidebar(sidebar)[0]?.docs).toEqual([TOPIC, OTHER_RECORD]);
  });

  it("tombstones every topic target before unpinning, including a missing first record", () => {
    const directory = new Y.Doc();
    const sidebar = new Y.Doc();
    for (const uuid of [SUCCESSOR, OTHER_RECORD]) {
      upsertDirectoryEntry(directory, {
        uuid, title: uuid, kind: "decision", status: "open", topic: TOPIC,
      });
    }
    upsertDirectoryEntry(directory, { uuid: NEIGHBOR, title: "Neighbor" });
    const group = createGroup(sidebar, "Reading");
    for (const uuid of [TOPIC, SUCCESSOR, OTHER_RECORD, NEIGHBOR]) {
      pinDoc(sidebar, group, uuid);
    }
    expect(getDirectoryEntry(directory, TOPIC)).toBeNull();

    const stages: string[] = [];
    const records = archiveDocument(directory, sidebar, SUCCESSOR, (purpose, write) => {
      stages.push(purpose);
      if (purpose === "sidebar") {
        for (const uuid of [TOPIC, SUCCESSOR, OTHER_RECORD]) {
          expect(getDirectoryEntry(directory, uuid)?.deleted).toBe(true);
        }
        expect(readSidebar(sidebar)[0]?.docs).toEqual([
          TOPIC, SUCCESSOR, OTHER_RECORD, NEIGHBOR,
        ]);
      }
      write();
    });

    expect(stages).toEqual(["directory", "sidebar"]);
    expect(records).toEqual([TOPIC, SUCCESSOR, OTHER_RECORD]);
    expect(getDirectoryEntry(directory, TOPIC)).toMatchObject({
      kind: "decision", topic: TOPIC, deleted: true,
    });
    expect(listDirectory(directory).map((entry) => entry.uuid)).toEqual([NEIGHBOR]);
    expect(readSidebar(sidebar)[0]?.docs).toEqual([NEIGHBOR]);
  });

  it.each([[1, 2], [2, 1]])(
    "hides unseen pins at the known level and permits deliberate repinning (clients %i, %i)",
    (localClient, peerClient) => {
      const directory = new Y.Doc();
      for (const uuid of [TOPIC, SUCCESSOR]) {
        upsertDirectoryEntry(directory, {
          uuid, title: uuid, kind: "decision", status: "open", topic: TOPIC,
        });
      }
      const sidebar = new Y.Doc();
      sidebar.clientID = localClient;
      const group = createGroup(sidebar, "Reading");
      pinDoc(sidebar, group, NEIGHBOR);
      const peer = new Y.Doc();
      peer.clientID = peerClient;
      syncDocs(sidebar, peer);
      pinDoc(peer, group, TOPIC);
      pinDoc(peer, group, SUCCESSOR);
      const unseenPins = Y.encodeStateAsUpdate(peer, Y.encodeStateVector(sidebar));

      archiveDocument(directory, sidebar, SUCCESSOR);
      Y.applyUpdate(sidebar, unseenPins);
      syncDocs(sidebar, peer);
      expect(readSidebar(sidebar)).toEqual(readSidebar(peer));
      expect(readSidebar(sidebar)[0]?.docs).toEqual([NEIGHBOR]);

      pinDoc(peer, group, SUCCESSOR);
      syncDocs(sidebar, peer);
      expect(readSidebar(sidebar)).toEqual(readSidebar(peer));
      expect(readSidebar(sidebar)[0]?.docs).toEqual([NEIGHBOR, SUCCESSOR]);
    },
  );

  it("stops before the sidebar when the directory stage refuses its write", () => {
    const directory = new Y.Doc();
    upsertDirectoryEntry(directory, { uuid: TOPIC, title: "Document" });
    const sidebar = new Y.Doc();
    pinDoc(sidebar, createGroup(sidebar, "Reading"), TOPIC);
    const before = Y.encodeStateAsUpdate(sidebar);
    const refusal = new Error("directory write refused");
    const stages: string[] = [];

    expect(() => archiveDocument(directory, sidebar, TOPIC, (purpose, write) => {
      stages.push(purpose);
      write();
      throw refusal;
    })).toThrow(refusal);

    expect(stages).toEqual(["directory"]);
    expect(getDirectoryEntry(directory, TOPIC)?.deleted).toBe(true);
    expect(Y.encodeStateAsUpdate(sidebar)).toEqual(before);
    expect(readSidebar(sidebar)[0]?.docs).toEqual([TOPIC]);
  });
});
