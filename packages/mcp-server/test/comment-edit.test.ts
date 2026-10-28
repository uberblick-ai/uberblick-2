import { randomUUID } from "node:crypto";
import { startDeviceSyncHub } from "@uberblick/hub/test-device-sync";
import { addComment, createAnnotation, getAnnotation, getAnnotationCommentIds, setAnnotationResolved } from "@uberblick/schema";
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
    title: "Edit comments", description: "Own comments can be corrected in place.",
    blocks: [{ type: "paragraph", text: "Original context" }],
  });
  return { ...created, ydoc: rig.instance.replicas.replica(created.uuid).doc };
}

async function opened(rig: Rig, doc: { uuid: string; blocks: { id: string }[] }) {
  return (await rig.ok("annotate", {
    uuid: doc.uuid, block_id: doc.blocks[0]!.id, start: 0, end: 3, text: "Opening",
  })).annotation;
}

function editing(uuid: string, threadId: string, commentId: string, text = "Corrected text") {
  return { uuid, action: "edit", thread_id: threadId, comment_id: commentId, text };
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

describe("editing comments through annotate", () => {
  it.each(["agent", "person"] as const)("edits a same-account %s comment after replies without changing attribution or position", async kind => {
    const { rig, login } = await signedIn();
    const doc = await document(rig);
    const thread = await opened(rig, doc);
    if (kind === "person") addComment(doc.ydoc, thread.id, "Browser name", "Handwritten", {
      kind: "person", account: login.identity.githubUsername.toUpperCase(),
    });
    addComment(doc.ydoc, thread.id, "Someone else", "Later reply", { kind: "person", account: "other-person" });
    const index = kind === "agent" ? 0 : 1;
    const before = (await rig.ok("get_doc", { uuid: doc.uuid })).annotations[0];
    for (const comment of before.comments) expect(comment).not.toHaveProperty("editedAt");
    const original = before.comments[index];
    const stored = getAnnotation(doc.ydoc, thread.id)!;
    const room = rig.instance.replicas.replica(doc.uuid).room;
    const logged = rig.instance.store.updateCount(room);

    const result = await rig.ok("annotate", editing(doc.uuid, thread.id, original.id));

    expect(result).toMatchObject({ applied: true, synced: false, hub: { status: expect.any(String) } });
    expect(rig.instance.store.updateCount(room)).toBe(logged + 1);
    const expectedComments = before.comments.map((comment: Record<string, unknown>, position: number) => position === index
      ? { ...comment, text: "Corrected text", editedAt: expect.any(String) }
      : comment);
    expect(result.annotation).toEqual({ ...before, comments: expectedComments });
    expect(Number.isFinite(Date.parse(result.annotation.comments[index].editedAt))).toBe(true);
    expect((await rig.ok("get_doc", { uuid: doc.uuid })).annotations[0]).toEqual(result.annotation);
    expect(getAnnotationCommentIds(doc.ydoc, thread.id)).toEqual(before.comments.map((comment: { id: string }) => comment.id));
    expect(getAnnotation(doc.ydoc, thread.id)).toEqual({
      ...stored,
      comments: stored.comments.map((comment, position) => position === index
        ? { ...comment, text: "Corrected text", editedAt: result.annotation.comments[index].editedAt }
        : comment),
    });
    expect(getAnnotation(doc.ydoc, thread.id)!.comments[index]!.kind).toBe(kind);
    if (kind === "person") expect(result.annotation.comments[index]).not.toHaveProperty("agent");
    else expect(result.annotation.comments[index].agent).toBe("codex");
  });

  it.each([
    ["someone else's comment", "other-person", false, "Correction", "comment_not_owned", /someone else's/],
    ["legacy comment", undefined, false, "Correction", "comment_account_missing", /without an account/],
    ["resolved conversation", "owner", true, "Correction", "thread_resolved", /resolved conversation/],
    ["empty text", "owner", false, "", "empty_text", /empty|non-empty/],
    ["whitespace-only text", "owner", false, " \n\t ", "empty_text", /empty|non-empty/],
  ] as const)("refuses %s without a write and names its reason", async (_label, account, resolved, text, reason, wording) => {
    const { rig, login } = await signedIn();
    const doc = await document(rig);
    const thread = createAnnotation(doc.ydoc, doc.blocks[0].id, 0, 3, "Display name", "Opening", undefined,
      account === undefined ? undefined : { kind: "person", account: account === "owner" ? login.identity.githubUsername : account });
    if (resolved) setAnnotationResolved(doc.ydoc, thread.id, true);
    const result = await refusesWithoutWrite(rig, doc.uuid,
      editing(doc.uuid, thread.id, getAnnotationCommentIds(doc.ydoc, thread.id)[0]!, text),
      { error: "comment_edit_refused", recoveryClass: "manual", reason });
    expect(result.recovery).toMatch(wording);
  });

  it("uses the current workspace sign-in and refuses signed-out and local sessions", async () => {
    const { rig, hub, env, config } = await signedIn();
    const doc = await document(rig);
    const thread = await opened(rig, doc);
    const args = editing(doc.uuid, thread.id, thread.comments[0].id);
    const replacement = hub.issue({ workspaces: [WORKSPACE], principalId: randomUUID() });
    replacement.identity.githubUsername = "different-person";
    await writeHubLogin(hub.origin, replacement, env);
    await refusesWithoutWrite(rig, doc.uuid, args, { error: "comment_edit_refused", reason: "comment_not_owned", recoveryClass: "manual" });
    await removeHubLogin(hub.origin, env);
    const result = await refusesWithoutWrite(rig, doc.uuid, args, { error: "comment_edit_refused", reason: "account_required", recoveryClass: "manual" });
    expect(result.recovery).toContain("no signed-in account");
    await writeHubLogin(hub.origin, replacement, env);
    const local = await startServer({ ...config, localWorkspace: true, databasePath: testConfig().databasePath });
    clients.push(local);
    const localDoc = await document(local);
    const localThread = await opened(local, localDoc);
    await refusesWithoutWrite(local, localDoc.uuid, editing(localDoc.uuid, localThread.id, localThread.comments[0].id),
      { error: "comment_edit_refused", reason: "account_required", recoveryClass: "manual" });
  });

  it("rereads missing ids and keeps the archived document refusal", async () => {
    const { rig } = await signedIn();
    const doc = await document(rig);
    const thread = await opened(rig, doc);
    await refusesWithoutWrite(rig, doc.uuid, editing(doc.uuid, "missing", "missing"), { error: "thread_not_found", recoveryClass: "reread" });
    await refusesWithoutWrite(rig, doc.uuid, editing(doc.uuid, thread.id, "missing"), { error: "comment_not_found", recoveryClass: "reread" });
    await rig.ok("archive_doc", { uuid: doc.uuid });
    await refusesWithoutWrite(rig, doc.uuid, editing(doc.uuid, thread.id, thread.comments[0].id), { error: "doc_archived", recoveryClass: "manual" });
  });

  it("rejects mixed or incomplete edit shapes before writing and identifies the field", async () => {
    const { rig } = await signedIn();
    const doc = await document(rig);
    const thread = await opened(rig, doc);
    const base = editing(doc.uuid, thread.id, thread.comments[0].id);
    const replica = rig.instance.replicas.replica(doc.uuid);
    const before = Y.encodeStateAsUpdate(doc.ydoc);
    const logged = rig.instance.store.updateCount(replica.room);
    for (const [field, value] of Object.entries({ author: "Other", block_id: doc.blocks[0].id, start: 0, end: 3, row: 0, column: 0, resolved: false })) {
      const result = await rig.call("annotate", { ...base, [field]: value });
      expect(result).toMatchObject({ isError: true, payload: { error: "schema_validation" } });
      expect(result.payload.message).toContain(field);
    }
    for (const field of ["thread_id", "comment_id", "text"]) {
      const args: Record<string, unknown> = { ...base };
      delete args[field];
      const result = await rig.call("annotate", args);
      expect(result).toMatchObject({ isError: true, payload: { error: "schema_validation" } });
      expect(result.payload.message).toContain(field);
    }
    for (const args of [
      { uuid: doc.uuid, thread_id: thread.id, text: "" },
      { uuid: doc.uuid, block_id: doc.blocks[0].id, start: 0, end: 3, text: "" },
      { uuid: doc.uuid, thread_id: thread.id, block_id: doc.blocks[0].id, start: 0, end: 3, text: "" },
    ]) {
      const result = await rig.call("annotate", args);
      expect(result).toMatchObject({ isError: true, payload: { error: "schema_validation" } });
      expect(result.payload.message).toContain("text");
    }
    expect(Y.encodeStateAsUpdate(doc.ydoc)).toEqual(before);
    expect(rig.instance.store.updateCount(replica.room)).toBe(logged);
  });

  it("preserves and orders concurrent replies when an existing comment is edited", async () => {
    const { rig } = await signedIn();
    const doc = await document(rig);
    const thread = await opened(rig, doc);
    await rig.ok("annotate", { uuid: doc.uuid, thread_id: thread.id, text: "Existing reply" });
    const base = Y.encodeStateAsUpdate(doc.ydoc);
    const vector = Y.encodeStateVector(doc.ydoc);
    const peer = new Y.Doc();
    try {
      Y.applyUpdate(peer, base);
      addComment(peer, thread.id, "Other", "Remote reply", { kind: "person", account: "other-person" });
      const remote = Y.encodeStateAsUpdate(peer, vector);
      await rig.ok("annotate", editing(doc.uuid, thread.id, thread.comments[0].id));
      await rig.ok("annotate", { uuid: doc.uuid, thread_id: thread.id, text: "Local reply" });
      const local = Y.encodeStateAsUpdate(doc.ydoc, vector);
      let converged: ReturnType<typeof getAnnotation> | undefined;
      for (const updates of [[local, remote], [remote, local]]) {
        const reader = new Y.Doc();
        try {
          Y.applyUpdate(reader, base);
          for (const update of updates) Y.applyUpdate(reader, update);
          const annotation = getAnnotation(reader, thread.id)!;
          expect(annotation.comments.slice(0, 2).map(comment => comment.text)).toEqual(["Corrected text", "Existing reply"]);
          expect(annotation.comments.slice(2).map(comment => comment.text).sort()).toEqual(["Local reply", "Remote reply"]);
          if (converged !== undefined) expect(annotation).toEqual(converged);
          converged = annotation;
        } finally {
          reader.destroy();
        }
      }
      Y.applyUpdate(doc.ydoc, remote);
      Y.applyUpdate(peer, local);
      expect(getAnnotation(doc.ydoc, thread.id)).toEqual(converged);
      expect(getAnnotation(peer, thread.id)).toEqual(converged);
      const read = (await rig.ok("get_doc", { uuid: doc.uuid })).annotations[0];
      expect(read.comments.map((comment: { text: string }) => comment.text)).toEqual(converged!.comments.map(comment => comment.text));
      expect(read.comments.map((comment: { id: string }) => comment.id)).toEqual(getAnnotationCommentIds(peer, thread.id));
      expect(read.comments[0].id).toBe(thread.comments[0].id);
      expect(read.comments[0].editedAt).toBe(converged!.comments[0]!.editedAt);
    } finally {
      peer.destroy();
    }
  });

  it("documents edit ownership, replacement, refusal and the edited marker", async () => {
    const { rig } = await signedIn();
    const annotate = await rig.ok("get_help", { topic: "annotate" });
    expect(annotate.text).toMatch(/action.*edit/);
    expect(annotate.text).toContain("workspace sign-in");
    expect(annotate.text).toMatch(/resolved/);
    expect(annotate.text).toMatch(/replaces|replaced/);
    expect(annotate.text).toMatch(/no earlier version|no edit history|no history/);
    const getDoc = await rig.ok("get_help", { topic: "get_doc" });
    expect(getDoc.text).toContain("editedAt");
  });
});
