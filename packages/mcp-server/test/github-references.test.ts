/** GitHub references remain derived from decision prose, across clients and upgrades. */

import { DatabaseSync } from "node:sqlite";
import { roomForDoc, setKind, setStatus } from "@uberblick/schema";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { blockText } from "../src/replica.js";
import { MirrorStore } from "../src/store.js";
import { removeTempDirs, startServer, tempDatabasePath, testConfig, WORKSPACE } from "./helpers.js";
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
