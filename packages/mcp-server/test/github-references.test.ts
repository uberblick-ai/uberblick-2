/** GitHub references remain derived from decision prose, across clients and upgrades. */

import { DatabaseSync } from "node:sqlite";
import {
  getDirectoryEntry,
  roomForDoc,
  setKind,
  setStatus,
  upsertDirectoryEntry,
} from "@uberblick/schema";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { blockText } from "../src/replica.js";
import { MirrorStore } from "../src/store.js";
import {
  removeTempDirs,
  startServer,
  tempDatabasePath,
  testConfig,
  WORKSPACE,
} from "./helpers.js";
import type { Rig } from "./helpers.js";

const rigs: Rig[] = [];
const stores: MirrorStore[] = [];
const docs: Y.Doc[] = [];
const REFERENCE = "owner/repo#42";
const HREF = "https://github.com/Owner/Repo/issues/42";

async function server(databasePath = tempDatabasePath()): Promise<Rig> {
  const rig = await startServer(testConfig({ databasePath }));
  rigs.push(rig);
  return rig;
}

async function decision(rig: Rig, title: string, href = HREF): Promise<any> {
  return rig.ok("create_doc", {
    title,
    description: "Records a choice linked to GitHub work.",
    kind: "decision",
    blocks: [
      {
        type: "paragraph",
        text: "",
        inline: [{ text: "Work item", marks: { link: href } }],
      },
    ],
  });
}

async function lookup(rig: Rig, githubRef = REFERENCE): Promise<any> {
  return rig.ok("find_decisions", { github_ref: githubRef });
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const rig of rigs.splice(0)) await rig.close();
  for (const store of stores.splice(0)) store.close();
  for (const doc of docs.splice(0)) doc.destroy();
});

afterAll(removeTempDirs);

describe("decision records linking GitHub work", () => {
  it("matches URL spellings once per record, ordered by binary title then UUID, with stub status", async () => {
    const rig = await server();
    const lower = await decision(rig, "alpha");
    const first = await decision(rig, "Alpha");
    const second = await decision(rig, "Alpha", "http://github.com/OWNER/REPO/pull/00042/files?view=split#diff-1");
    const last = await decision(rig, "Zebra");
    await rig.ok("insert_block", {
      uuid: first.uuid,
      type: "list-item",
      text: "",
      inline: [{ text: "Same item again", marks: { link: "https://github.com/owner/repo/pull/42#issuecomment-123" } }],
    });
    const elsewhere = await decision(rig, "Other repository", "https://github.com/owner/other/issues/42");

    // Status belongs to the directory, not the title index or an opened room.
    const directory = rig.instance.replicas.directory().doc;
    const entry = getDirectoryEntry(directory, second.uuid);
    expect(entry).not.toBeNull();
    upsertDirectoryEntry(directory, { ...entry!, status: "decided" });
    setStatus(rig.instance.replicas.replica(last.uuid).doc, "");

    const tied = [
      { uuid: first.uuid, title: "Alpha", status: "open" },
      { uuid: second.uuid, title: "Alpha", status: "decided" },
    ].sort((a, b) => a.uuid < b.uuid ? -1 : a.uuid > b.uuid ? 1 : 0);
    const expected = {
      github_ref: REFERENCE,
      decisions: [
        ...tied,
        { uuid: last.uuid, title: "Zebra", status: null },
        { uuid: lower.uuid, title: "alpha", status: "open" },
      ],
    };
    for (const input of [
      "OWNER/Repo#00042",
      HREF,
      "http://GITHUB.COM/owner/repo/pull/42/files",
      "https://github.com/OWNER/REPO/issues/42/comments?sort=oldest#issuecomment-1",
      "https://github.com/owner/repo/pull/42?view=split#discussion_r1",
    ]) {
      expect(await lookup(rig, input), input).toEqual(expected);
    }
    expect(await lookup(rig, "owner/other#42")).toEqual({
      github_ref: "owner/other#42",
      decisions: [{ uuid: elsewhere.uuid, title: "Other repository", status: "open" }],
    });
  });

  it("uses only external href marks in decision prose, ignoring labels and foreign source-block marks", async () => {
    const rig = await server();
    const target = await rig.ok("create_doc", {
      title: "Document target",
      description: "The target of a document reference.",
    });
    const record = await rig.ok("create_doc", {
      title: "Href owns identity",
      description: "Exercises links in prose and non-links in source.",
      kind: "decision",
      blocks: [
        { type: "heading", level: 2, text: "", inline: [{ text: "owner/repo#90", marks: { link: HREF } }] },
        { type: "quote", text: "", inline: [{ text: "Issue", marks: { link: HREF } }] },
        { type: "list-item", text: "", inline: [{ text: "Pull request", marks: { link: "https://github.com/owner/repo/pull/42" } }] },
        { type: "paragraph", text: "owner/repo#91 https://github.com/owner/repo/issues/92" },
        { type: "paragraph", text: "Both marks after a merge" },
        ...[
          "https://example.com/owner/repo/issues/60",
          "https://github.example.com/owner/repo/issues/61",
          "https://github.com/owner/repo/commit/62",
          "https://github.com/owner/repo/discussions/63",
          "https://github.com/owner/repo/issues",
          "https://github.com/owner/repo",
        ].map((href) => ({ type: "paragraph", text: "", inline: [{ text: "owner/repo#64", marks: { link: href } }] })),
        ...["code", "mermaid", "table", "terminal"].map((type, index) => ({
          type,
          text: `https://github.com/owner/repo/issues/${70 + index}`,
        })),
      ],
    });
    const replica = rig.instance.replicas.replica(record.uuid);
    replica.doc.transact(() => {
      const both = blockText(replica.doc, record.blocks[4].id)!;
      both.format(0, both.length, {
        link: { href: "https://github.com/owner/repo/issues/80" },
        docLink: { docId: target.uuid },
      });
      for (const block of record.blocks.slice(-4)) {
        const source = blockText(replica.doc, block.id)!;
        source.format(0, source.length, { link: { href: source.toString() } });
      }
    });
    for (const kind of [undefined, "requirement"]) {
      await rig.ok("create_doc", {
        title: `Non-decision ${kind ?? "ordinary"}`,
        description: "Links outside decision records do not count.",
        ...(kind === undefined ? {} : { kind }),
        blocks: [{ type: "paragraph", text: "", inline: [{ text: "Work", marks: { link: "https://github.com/owner/repo/issues/81" } }] }],
      });
    }

    expect((await lookup(rig)).decisions).toEqual([
      { uuid: record.uuid, title: "Href owns identity", status: "open" },
    ]);
    for (const number of [60, 61, 62, 63, 64, 70, 71, 72, 73, 80, 81, 90, 91, 92]) {
      expect((await lookup(rig, `owner/repo#${number}`)).decisions, String(number)).toEqual([]);
    }
  });

  it("replays another client's link edits and additions or removals of the decision kind", async () => {
    const databasePath = tempDatabasePath();
    const rig = await server(databasePath);
    const created = await rig.ok("create_doc", {
      title: "Another client's record",
      description: "A document changed through another client's Yjs updates.",
      blocks: [{ type: "paragraph", text: "Work item" }],
    });
    const foreign = new Y.Doc();
    docs.push(foreign);
    Y.applyUpdate(foreign, Y.encodeStateAsUpdate(rig.instance.replicas.replica(created.uuid).doc));
    const writer = new MirrorStore(databasePath, WORKSPACE);
    stores.push(writer);
    const room = roomForDoc(WORKSPACE, created.uuid);
    const text = blockText(foreign, created.blocks[0].id)!;
    const change = (write: () => void): void => {
      const before = Y.encodeStateVector(foreign);
      foreign.transact(write);
      writer.appendUpdate(room, Y.encodeStateAsUpdate(foreign, before), "remote");
    };
    const matches = async (githubRef = REFERENCE): Promise<string[]> =>
      (await lookup(rig, githubRef)).decisions.map((row: { uuid: string }) => row.uuid);

    change(() => text.format(0, text.length, { link: { href: HREF } }));
    expect(await matches()).toEqual([]);
    change(() => { setKind(foreign, "decision"); setStatus(foreign, "open"); });
    expect(await matches()).toEqual([created.uuid]);
    change(() => text.format(0, text.length, { link: { href: "https://github.com/owner/repo/pull/43/files" } }));
    expect(await matches()).toEqual([]);
    expect(await matches("owner/repo#43")).toEqual([created.uuid]);
    change(() => text.format(0, text.length, { link: null }));
    expect(await matches("owner/repo#43")).toEqual([]);
    change(() => text.format(0, text.length, { link: { href: HREF } }));
    expect(await matches()).toEqual([created.uuid]);
    change(() => setKind(foreign, ""));
    expect(await matches()).toEqual([]);
    change(() => setKind(foreign, "decision"));
    expect((await lookup(rig)).decisions).toEqual([
      { uuid: created.uuid, title: "Another client's record", status: null },
    ]);
  });

  it("removes archived records and rebuilds references solely from live record text", async () => {
    const rig = await server();
    const first = await decision(rig, "First");
    const second = await decision(rig, "Second");
    await rig.ok("archive_doc", { uuid: first.uuid });
    const expected = [{ uuid: second.uuid, title: "Second", status: "open" }];
    expect((await lookup(rig)).decisions).toEqual(expected);

    // A fabricated cache row must disappear without any corresponding text edit.
    const db = new DatabaseSync(rig.config.databasePath);
    db.prepare("INSERT INTO decision_github_refs (source, target) VALUES (?, ?)").run(second.uuid, "owner/repo#99");
    db.close();
    expect((await lookup(rig, "owner/repo#99")).decisions).toHaveLength(1);
    rig.instance.replicas.rebuildIndex();
    expect((await lookup(rig)).decisions).toEqual(expected);
    expect((await lookup(rig, "owner/repo#99")).decisions).toEqual([]);

    await rig.ok("restore_doc", { uuid: first.uuid });
    expect((await lookup(rig)).decisions).toEqual([
      { uuid: first.uuid, title: "First", status: "open" },
      ...expected,
    ]);
  });

  it("refuses a value naming no GitHub item, and answers indexed reads without opening or touching decision rooms", async () => {
    const rig = await server();
    const record = await decision(rig, "Indexed read");
    await rig.instance.replicas.settle();
    const before = rig.instance.store.logSize();
    const opening = vi.spyOn(rig.instance.replicas, "replica");
    const touching = vi.spyOn(rig.instance.replicas, "touch");

    expect((await lookup(rig)).decisions).toEqual([
      { uuid: record.uuid, title: "Indexed read", status: "open" },
    ]);
    expect(await lookup(rig, "owner/repo#999")).toEqual({ github_ref: "owner/repo#999", decisions: [] });
    for (const input of [
      "owner/repo#0", "owner/repo#42 owner/repo#43",
      "https://github.example.com/owner/repo/issues/42",
      "https://github.com/owner/repo/pull/42oops",
    ]) {
      const refusal = await rig.call("find_decisions", { github_ref: input });
      expect(refusal.isError, input).toBe(true);
      expect(refusal.payload, input).toMatchObject({ error: "invalid_github_reference" });
    }
    expect(opening).not.toHaveBeenCalled();
    expect(touching).not.toHaveBeenCalled();
    expect(rig.instance.store.logSize()).toBe(before);
  });

  it("discovers previously indexed decision records after upgrading, without editing their log", async () => {
    const databasePath = tempDatabasePath();
    const original = await server(databasePath);
    const record = await decision(original, "Already indexed before upgrade");
    expect((await lookup(original)).decisions).toHaveLength(1);
    const before = original.instance.store.logSize();
    await original.close();
    rigs.splice(rigs.indexOf(original), 1);

    // Preserve the old guarded index generations, but remove exactly the schema
    // this feature adds. Startup must derive equal-cut records once, without an edit.
    const legacy = new DatabaseSync(databasePath);
    const generation = legacy.prepare("SELECT indexed_through_seq, catalog_through_seq FROM doc_index_seq WHERE uuid = ?").get(record.uuid);
    legacy.exec("DROP TABLE decision_github_refs; ALTER TABLE doc_index_seq DROP COLUMN github_refs_indexed");
    legacy.close();

    const upgraded = await server(databasePath);
    expect(await lookup(upgraded)).toEqual({
      github_ref: REFERENCE,
      decisions: [{ uuid: record.uuid, title: "Already indexed before upgrade", status: "open" }],
    });
    expect(upgraded.instance.store.logSize()).toBe(before);
    const db = new DatabaseSync(databasePath, { readOnly: true });
    expect(db.prepare("SELECT indexed_through_seq, catalog_through_seq FROM doc_index_seq WHERE uuid = ?").get(record.uuid)).toEqual(generation);
    expect(db.prepare("SELECT github_refs_indexed FROM doc_index_seq WHERE uuid = ?").get(record.uuid)).toMatchObject({ github_refs_indexed: 1 });
    db.close();
  });
});
