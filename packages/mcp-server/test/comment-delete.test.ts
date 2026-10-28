import { randomUUID } from "node:crypto";
import { startDeviceSyncHub } from "@uberblick/hub/test-device-sync";
import {
  addComment, createAnnotation, editComment, getAnnotation, getAnnotationCommentIds,
  moveAnnotation, setAnnotationResolved, CARD_PARTS, COMMENT_MARK, cardPartTexts,
  figmaCaptionTexts, findBlockElement, listAnnotationRanges, tableCellTexts, tableRows,
} from "@uberblick/schema";
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { removeHubLogin, writeHubLogin } from "../src/auth-store.js";
import { cleanupTestResources, startServer, tempDir, testConfig, WORKSPACE } from "./helpers.js";
import type { Rig } from "./helpers.js";

const clients: Rig[] = [];
const hubs: Array<Awaited<ReturnType<typeof startDeviceSyncHub>>> = [];
afterEach(async () => {
  await cleanupTestResources({
    clients: clients.splice(0).map(client => () => client.close()),
    hubs: hubs.splice(0).map(hub => () => hub.close()),
  });
});

async function signedIn() {
  const hub = await startDeviceSyncHub({ directory: tempDir() });
  hubs.push(hub);
  const login = hub.issue({ workspaces: [WORKSPACE] });
  const env = { XDG_CONFIG_HOME: tempDir() };
  await writeHubLogin(hub.origin, login, env);
  const config = { ...testConfig({ hubUrl: hub.url }), authEnv: env };
  const rig = await startServer(config, undefined, { name: "Codex", version: "1" });
  clients.push(rig);
  return { rig, hub, login, env, config };
}

async function document(rig: Rig) {
  const created = await rig.ok("create_doc", {
    title: "Delete comments", description: "Own comments can be permanently removed.",
    blocks: [{ type: "paragraph", text: "Original context" }, { type: "paragraph", text: "New context" }],
  });
  return { ...created, ydoc: rig.instance.replicas.replica(created.uuid).doc };
}

async function opened(rig: Rig, doc: { uuid: string; blocks: { id: string }[] }) {
  return (await rig.ok("annotate", {
    uuid: doc.uuid, block_id: doc.blocks[0]!.id, start: 0, end: 3, text: "Opening",
  })).annotation;
}

function deletion(uuid: string, threadId: string, commentId: string) {
  return { uuid, action: "delete", thread_id: threadId, comment_id: commentId };
}

async function refusesWithoutWrite(rig: Rig, uuid: string, args: Record<string, unknown>, expected: Record<string, unknown>) {
  const replica = rig.instance.replicas.replica(uuid);
  const before = Y.encodeStateAsUpdate(replica.doc);
  const logged = rig.instance.store.updateCount(replica.room);
  const result = await rig.call("annotate", args);
  expect(result).toMatchObject({ isError: true, payload: {
    applied: false, partial: false, synced: false, ...expected,
  } });
  expect(Y.encodeStateAsUpdate(replica.doc)).toEqual(before);
  expect(rig.instance.store.updateCount(replica.room)).toBe(logged);
  return result.payload;
}

describe("deleting comments through annotate", () => {
  it("addresses stable ids, deletes only a reply, then permanently removes an all-owned conversation", async () => {
    const { rig, login } = await signedIn();
    const doc = await document(rig);
    const thread = await opened(rig, doc);
    const replied = await rig.ok("annotate", { uuid: doc.uuid, thread_id: thread.id, text: "My reply" });
    const id = replied.annotation.comments[1].id;
    expect(id).toBe(getAnnotationCommentIds(doc.ydoc, thread.id)[1]);
    editComment(doc.ydoc, thread.id, id, login.identity.githubUsername, "Edited reply");
    const read = await rig.ok("get_doc", { uuid: doc.uuid });
    expect(read.annotations[0].comments[1]).toMatchObject({ id, text: "Edited reply" });
    const room = rig.instance.replicas.replica(doc.uuid).room;
    const logged = rig.instance.store.updateCount(room);
    const removed = await rig.ok("annotate", deletion(doc.uuid, thread.id, id));
    expect(removed).toMatchObject({ removed: "comment", applied: true, synced: false, hub: { status: expect.any(String) } });
    expect(rig.instance.store.updateCount(room)).toBe(logged + 1);
    expect(removed.annotation.comments).toEqual(thread.comments);
    expect((await rig.ok("get_doc", { uuid: doc.uuid })).annotations[0].comments).toEqual(thread.comments);
    await rig.ok("annotate", { uuid: doc.uuid, thread_id: thread.id, text: "Another own reply" });
    const gone = await rig.ok("annotate", deletion(doc.uuid, thread.id, thread.comments[0].id));
    expect(gone).toMatchObject({ removed: "thread", applied: true, synced: false, hub: { status: expect.any(String) } });
    expect(gone).not.toHaveProperty("annotation");
    expect((await rig.ok("get_doc", { uuid: doc.uuid })).annotations).toEqual([]);
    expect((await rig.ok("list_docs")).docs).toMatchObject([{ uuid: doc.uuid, openThreadCount: 0 }]);
    expect((await rig.ok("export_markdown", { uuid: doc.uuid, annotations: "html-comments" })).markdown).not.toMatch(/Opening|My reply|Another own reply|annotation/);
    await rig.ok("annotate", { uuid: doc.uuid, block_id: doc.blocks[0].id, start: 0, end: 3, text: "New comment over old text" });
  });

  it("compares accounts without case and deletes an opening comment with no replies", async () => {
    const { rig, login } = await signedIn();
    const doc = await document(rig);
    const thread = createAnnotation(doc.ydoc, doc.blocks[0].id, 0, 3, "Browser", "Owned", undefined,
      { account: login.identity.githubUsername.toUpperCase(), kind: "person" });
    const id = getAnnotationCommentIds(doc.ydoc, thread.id)[0]!;
    expect(await rig.ok("annotate", deletion(doc.uuid, thread.id, id))).toMatchObject({ removed: "thread", applied: true });
  });

  it.each([
    ["someone else's comment", "other-account", undefined, false, "comment_not_owned", /someone else's/],
    ["legacy comment", undefined, undefined, false, "comment_account_missing", /without an account/],
    ["another account's reply", "owner", "other-account", false, "reply_not_owned", /another account has replied/],
    ["legacy reply", "owner", null, false, "reply_account_missing", /reply has no stored account/],
    ["resolved conversation", "owner", undefined, true, "thread_resolved", /resolved conversation/],
  ] as const)("refuses %s without a write and names the reason", async (_label, opener, reply, resolved, reason, wording) => {
    const { rig, login } = await signedIn();
    const doc = await document(rig);
    const owner = login.identity.githubUsername;
    const thread = createAnnotation(doc.ydoc, doc.blocks[0].id, 0, 3, "Display name", "Opening", undefined,
      opener === undefined ? undefined : { kind: "person", account: opener === "owner" ? owner : opener });
    if (reply !== undefined) addComment(doc.ydoc, thread.id, "Reply", "Reply", reply === null ? undefined : { kind: "person", account: reply });
    if (resolved) setAnnotationResolved(doc.ydoc, thread.id, true);
    const result = await refusesWithoutWrite(rig, doc.uuid, deletion(doc.uuid, thread.id, getAnnotationCommentIds(doc.ydoc, thread.id)[0]!),
      { error: "comment_delete_refused", recoveryClass: "manual", reason });
    expect(result.recovery).toMatch(wording);
  });

  it("uses the current workspace sign-in and refuses signed-out and local sessions", async () => {
    const { rig, hub, env, config } = await signedIn();
    const doc = await document(rig);
    const thread = await opened(rig, doc);
    const args = deletion(doc.uuid, thread.id, thread.comments[0].id);
    const replacement = hub.issue({ workspaces: [WORKSPACE], principalId: randomUUID() });
    replacement.identity.githubUsername = "different-person";
    await writeHubLogin(hub.origin, replacement, env);
    await refusesWithoutWrite(rig, doc.uuid, args, { error: "comment_delete_refused", reason: "comment_not_owned", recoveryClass: "manual" });
    await removeHubLogin(hub.origin, env);
    const result = await refusesWithoutWrite(rig, doc.uuid, args, { error: "comment_delete_refused", reason: "account_required", recoveryClass: "manual" });
    expect(result.recovery).toContain("no signed-in account");
    await writeHubLogin(hub.origin, replacement, env);
    const local = await startServer({ ...config, localWorkspace: true, databasePath: testConfig().databasePath });
    clients.push(local);
    const localDoc = await document(local);
    const localThread = await opened(local, localDoc);
    await refusesWithoutWrite(local, localDoc.uuid, deletion(localDoc.uuid, localThread.id, localThread.comments[0].id),
      { error: "comment_delete_refused", reason: "account_required", recoveryClass: "manual" });
  });

  it("rereads missing ids and keeps archived document refusal", async () => {
    const { rig } = await signedIn();
    const doc = await document(rig);
    const thread = await opened(rig, doc);
    await refusesWithoutWrite(rig, doc.uuid, deletion(doc.uuid, "missing", "missing"), { error: "thread_not_found", recoveryClass: "reread" });
    await refusesWithoutWrite(rig, doc.uuid, deletion(doc.uuid, thread.id, "missing"), { error: "comment_not_found", recoveryClass: "reread" });
    await rig.ok("archive_doc", { uuid: doc.uuid });
    await refusesWithoutWrite(rig, doc.uuid, deletion(doc.uuid, thread.id, thread.comments[0].id), { error: "doc_archived", recoveryClass: "manual" });
  });

  it("refuses mixed delete shapes and preserves text requirements on other modes", async () => {
    const { rig } = await signedIn();
    const doc = await document(rig);
    const thread = await opened(rig, doc);
    const base = deletion(doc.uuid, thread.id, thread.comments[0].id);
    for (const fields of [{ text: "No" }, { author: "No" }, { resolved: false }, { block_id: doc.blocks[0].id }, { start: 0 }, { end: 3 }, { row: 0 }, { column: 0 }]) {
      expect((await rig.call("annotate", { ...base, ...fields })).payload.error).toBe("schema_validation");
    }
    for (const args of [
      { uuid: doc.uuid, action: "delete", thread_id: thread.id },
      { uuid: doc.uuid, action: "delete", comment_id: thread.comments[0].id },
      { uuid: doc.uuid, thread_id: thread.id },
      { uuid: doc.uuid, block_id: doc.blocks[1].id, start: 0, end: 3 },
      { uuid: doc.uuid, thread_id: thread.id, block_id: doc.blocks[1].id, start: 0, end: 3 },
      { uuid: doc.uuid, thread_id: thread.id, text: "Reply", comment_id: thread.comments[0].id },
    ]) expect((await rig.call("annotate", args)).payload.error).toBe("schema_validation");
    expect(getAnnotation(doc.ydoc, thread.id)!.comments).toHaveLength(1);
    const help = await rig.ok("get_help", { topic: "annotate" });
    expect(help.text).toContain("Delete permanently");
    expect(help.text).toContain("every reply is yours");
    expect(help.text).toContain("workspace sign-in");
  });

  it.each(["reply", "resolve", "move"] as const)("drops a concurrent %s after an MCP whole-thread delete", async mode => {
    const { rig, login } = await signedIn();
    const doc = await document(rig);
    const thread = await opened(rig, doc);
    const base = Y.encodeStateAsUpdate(doc.ydoc);
    const vector = Y.encodeStateVector(doc.ydoc);
    const peer = new Y.Doc();
    Y.applyUpdate(peer, base);
    if (mode === "reply") addComment(peer, thread.id, "Other", "Concurrent", { kind: "person", account: "other" });
    if (mode === "resolve") setAnnotationResolved(peer, thread.id, true);
    if (mode === "move") moveAnnotation(peer, thread.id, doc.blocks[1].id, 0, 3, "Other", "Moved", undefined, { kind: "person", account: login.identity.githubUsername });
    const remote = Y.encodeStateAsUpdate(peer, vector);
    await rig.ok("annotate", deletion(doc.uuid, thread.id, thread.comments[0].id));
    const deleted = Y.encodeStateAsUpdate(doc.ydoc, vector);
    for (const updates of [[deleted, remote], [remote, deleted]]) {
      const reader = new Y.Doc();
      Y.applyUpdate(reader, base);
      for (const update of updates) Y.applyUpdate(reader, update);
      expect(getAnnotation(reader, thread.id)).toBeNull();
      reader.destroy();
    }
    Y.applyUpdate(doc.ydoc, remote);
    Y.applyUpdate(peer, deleted);
    expect((await rig.ok("get_doc", { uuid: doc.uuid })).annotations).toEqual([]);
    expect(getAnnotation(peer, thread.id)).toBeNull();
    peer.destroy();
  });

  it.each(["reply", "same-comment edit"] as const)("preserves a concurrent %s when deleting only one reply", async mode => {
    const { rig, login } = await signedIn();
    const doc = await document(rig);
    const thread = await opened(rig, doc);
    const replied = await rig.ok("annotate", { uuid: doc.uuid, thread_id: thread.id, text: "Target" });
    const id = replied.annotation.comments[1].id;
    const sibling = await rig.ok("annotate", { uuid: doc.uuid, thread_id: thread.id, text: "Sibling" });
    const base = Y.encodeStateAsUpdate(doc.ydoc);
    const vector = Y.encodeStateVector(doc.ydoc);
    const peer = new Y.Doc();
    Y.applyUpdate(peer, base);
    if (mode === "reply") addComment(peer, thread.id, "Other", "Concurrent reply", { kind: "person", account: "someone" });
    else editComment(peer, thread.id, id, login.identity.githubUsername, "Concurrent edit");
    const remote = Y.encodeStateAsUpdate(peer, vector);
    const removed = await rig.ok("annotate", deletion(doc.uuid, thread.id, id));
    expect(removed.annotation.comments.map((comment: { id: string }) => comment.id)).toEqual([thread.comments[0].id, sibling.annotation.comments[2].id]);
    const deleted = Y.encodeStateAsUpdate(doc.ydoc, vector);
    const expectedTexts = mode === "reply" ? ["Opening", "Sibling", "Concurrent reply"] : ["Opening", "Concurrent edit", "Sibling"];
    for (const updates of [[deleted, remote], [remote, deleted]]) {
      const reader = new Y.Doc();
      Y.applyUpdate(reader, base);
      for (const update of updates) Y.applyUpdate(reader, update);
      expect(getAnnotation(reader, thread.id)!.comments.map(comment => comment.text)).toEqual(expectedTexts);
      reader.destroy();
    }
    Y.applyUpdate(doc.ydoc, remote);
    Y.applyUpdate(peer, deleted);
    const remaining = (await rig.ok("get_doc", { uuid: doc.uuid })).annotations[0];
    expect(remaining.comments.map((comment: { text: string }) => comment.text)).toEqual(expectedTexts);
    expect(remaining.comments.map((comment: { id: string }) => comment.id)).toEqual(getAnnotationCommentIds(peer, thread.id));
    if (mode === "same-comment edit") {
      expect(remaining.comments[1].id).toBe(id);
      await rig.ok("annotate", deletion(doc.uuid, thread.id, id));
      expect((await rig.ok("get_doc", { uuid: doc.uuid })).annotations[0].comments.map((comment: { text: string }) => comment.text)).toEqual(["Opening", "Sibling"]);
    }
    peer.destroy();
  });

  it("removes prose, table, card-part and Figma-caption marks through one delete", async () => {
    const { rig } = await signedIn();
    const doc = await document(rig);
    const thread = await opened(rig, doc);
    const added = await rig.ok("insert_block", { uuid: doc.uuid, blocks: [
      { type: "table", text: "| Header |\n| --- |\n| Cell |" },
      { type: "card", text: "label: Label\ntitle: Title\nfooter: Footer\n\nBody" },
      { type: "figma", text: "url: https://www.figma.com/design/Abc123/File\n\nCaption" },
    ] });
    const table = findBlockElement(doc.ydoc, added.blocks[0].id)!;
    const card = findBlockElement(doc.ydoc, added.blocks[1].id)!;
    const figma = findBlockElement(doc.ydoc, added.blocks[2].id)!;
    const texts = [
      ...tableRows(table).flatMap(row => row.flatMap(cell => tableCellTexts(cell))),
      ...CARD_PARTS.flatMap(part => cardPartTexts(card, part)),
      ...figmaCaptionTexts(figma),
    ];
    for (const text of texts) text.format(0, text.length, { [COMMENT_MARK]: { threadId: thread.id } });
    expect((await rig.ok("export_markdown", { uuid: doc.uuid, annotations: "html-comments" })).markdown).toContain("Opening");
    const room = rig.instance.replicas.replica(doc.uuid).room;
    const logged = rig.instance.store.updateCount(room);
    await rig.ok("annotate", deletion(doc.uuid, thread.id, thread.comments[0].id));
    expect(rig.instance.store.updateCount(room)).toBe(logged + 1);
    for (const block of [doc.blocks[0], ...added.blocks]) expect(listAnnotationRanges(doc.ydoc, block.id)).toEqual([]);
    expect((await rig.ok("export_markdown", { uuid: doc.uuid, annotations: "html-comments" })).markdown).not.toMatch(/Opening|annotation/);
    expect((await rig.ok("get_doc", { uuid: doc.uuid })).annotations).toEqual([]);
  });
});
