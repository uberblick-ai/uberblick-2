import { randomUUID } from "node:crypto";
import {
  encodeRevisionResponseFrames, getMeta, getMetaMap, readRevisionRequest, readRevisionResponse, roomForDoc,
  snapshotRevision, tombstoneDirectoryEntry, upsertDirectoryEntry,
  type RevisionRequest, type RevisionResponse,
} from "@uberblick/schema";
import { startDeviceSyncHub } from "@uberblick/hub/test-device-sync";
import { issueCredential } from "@uberblick/hub/test-device-credentials";
import { createTeamHub } from "@uberblick/hub/team";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { writeHubLogin } from "../src/auth-store.js";
import { RevisionClientError } from "../src/revision-client.js";
import { tools } from "../src/tool-table.js";
import {
  cleanupTestResources, hubUrl, LIVE_HUB_SETTLE, startHub, startServer,
  tempDir, TEST_SECRET, testConfig, WAIT_TIMEOUT_MS,
  type Rig, type TestConfigOptions, type ToolCall, WORKSPACE,
} from "./helpers.js";

const clients: Array<() => unknown> = [];
const hubs: Array<() => unknown> = [];
const revision = "historical-revision";
const textSchema = {
  version: 1,
  schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false },
};

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupTestResources({ clients: clients.splice(0), hubs: hubs.splice(0) });
});

async function server(options: TestConfigOptions = {}): Promise<Rig> {
  const rig = await startServer(testConfig(options));
  clients.push(() => rig.close());
  return rig;
}

async function admitted() {
  const hub = await startHub();
  hubs.push(() => hub.stop());
  const rig = await server({ authSecret: TEST_SECRET, hubUrl: hubUrl(hub.port), ...LIVE_HUB_SETTLE });
  const created = await rig.ok("create_doc", {
    title: "Current document", description: "Historical MCP reads fixture.",
    blocks: [{ type: "paragraph", text: "Current content" }],
  });
  expect(await rig.instance.replicas.waitForSettled({ deadline: performance.now() + WAIT_TIMEOUT_MS }))
    .toMatchObject({ caughtUp: true });
  const room = roomForDoc(rig.config.workspaceId, created.uuid);
  const connection = hub.hocuspocus.documents.get(room)?.getConnections()[0];
  if (connection === undefined) throw new Error("The document did not retain its admitted connection.");
  return {
    rig, uuid: created.uuid, hub,
    reply(handler: (request: RevisionRequest, send: (response: RevisionResponse) => void) => void) {
      const original = connection.callbacks.statelessCallback;
      connection.onStatelessCallback(async payload => {
        const request = readRevisionRequest(payload.payload);
        if (request === null) { await original(payload); return; }
        handler(request, response => {
          for (const frame of encodeRevisionResponseFrames(response)) connection.sendStateless(frame);
        });
      });
    },
  };
}

function calls(uuid: string): Array<[string, Record<string, unknown>]> {
  return [
    ["list_revisions", { uuid }],
    ["get_revision", { uuid, revision }],
    ["get_data", { uuid, revision, collection: "observations" }],
  ];
}

function writeCalls(uuid: string): Array<[string, Record<string, unknown>]> {
  return [
    ["name_revision", { uuid, name: "Reviewed" }],
    ["restore_revision", { uuid, revision }],
  ];
}

function refusal(result: ToolCall, code: string) {
  expect(result).toMatchObject({ isError: true, payload: {
    error: code, message: expect.any(String),
    recoveryClass: expect.stringMatching(/^(retry|reread|manual)$/), recovery: expect.any(String),
  } });
  expect(result.payload.recovery.length).toBeGreaterThan(0);
  expect(result.payload).not.toHaveProperty("applied");
  expect(result.payload).not.toHaveProperty("revisions");
  expect(result.payload).not.toHaveProperty("blocks");
  expect(result.payload).not.toHaveProperty("records");
}

describe("historical reads through the MCP boundary", () => {
  it("restores through the hub as a closed revision, synchronizes peers and leaves later edits writable", async () => {
    const hub = await createTeamHub({ address: "127.0.0.1", port: 0, databasePath: ":memory:",
      github: { clientId: "Iv1.0123456789abcdef" }, log() {} }, { deviceCredentials: true });
    hubs.push(() => hub.stop());
    const principal = hub.principals!.identify("12345", "revision-restorer");
    hub.memberships!.grant({ workspaceId: WORKSPACE, principalId: principal.id, role: "admin" });
    const issued = issueCredential(hub.credentials!, { principalId: principal.id, deviceId: randomUUID(), workspaces: [WORKSPACE] });
    const env = { XDG_CONFIG_HOME: tempDir() };
    const { replacedAt: _replacedAt, ...record } = issued.record;
    await writeHubLogin(`http://127.0.0.1:${hub.port}`, { identity: principal,
      credential: { record, key: Buffer.from(issued.keyBytes).toString("base64url") } }, env);
    const config = () => ({ ...testConfig({ hubUrl: hubUrl(hub.port), ...LIVE_HUB_SETTLE }), deviceLogin: { env } });
    const rig = await startServer(config());
    clients.push(() => rig.close());
    const { uuid } = await rig.ok("create_doc", { title: "Earlier title", description: "Preserve description",
      tldr: "Preserve TL;DR", blocks: [{ type: "paragraph", text: "Earlier prose" }, { type: "paragraph", text: "Retained prose" }] });
    await rig.ok("update_data", { uuid, operations: [{ collection: "observations", schema: textSchema,
      upsert: [{ id: "value", value: { text: "Earlier data" } }] }] });
    expect(await rig.instance.replicas.waitForSettled()).toMatchObject({ caughtUp: true });
    const earlier = await rig.ok("name_revision", { uuid, name: "Earlier" });
    const original = await rig.ok("get_doc", { uuid });
    await rig.ok("set_metadata", { uuid, title: "Latest title" });
    await rig.ok("edit_block", { uuid, block_id: original.blocks[0].id, old_text: original.blocks[0].text,
      new_text: "Latest prose", rev: original.blocks[0].rev });
    await rig.ok("update_data", { uuid, operations: [{ collection: "observations",
      upsert: [{ id: "value", value: { text: "Latest data" } }] }] });
    expect(await rig.instance.replicas.waitForSettled()).toMatchObject({ caughtUp: true });
    const before = (await rig.ok("list_revisions", { uuid })).revisions;
    const peer = await startServer(config());
    clients.push(() => peer.close());
    expect((await peer.ok("get_doc", { uuid })).title).toBe("Latest title");
    const restored = await rig.ok("restore_revision", { uuid, revision: earlier.revision.id });
    expect(restored).toMatchObject({ uuid, applied: true, synced: true, revision: { endedAt: expect.any(String), name: null,
      author: { githubUsername: "revision-restorer", surface: { kind: "mcp" } } } });
    expect(await rig.instance.replicas.waitForSettled()).toMatchObject({ caughtUp: true });
    expect(await peer.instance.replicas.waitForSettled()).toMatchObject({ caughtUp: true });
    const live = await rig.ok("get_doc", { uuid });
    const remote = await peer.ok("get_doc", { uuid });
    expect(remote).toMatchObject({ title: "Earlier title", description: "Preserve description", tldr: "Preserve TL;DR",
      blocks: [{ text: "Earlier prose" }, { id: original.blocks[1].id, rev: original.blocks[1].rev, text: "Retained prose" }] });
    expect((await peer.ok("get_data", { uuid, collection: "observations" })).records)
      .toMatchObject([{ id: "value", value: { text: "Earlier data" } }]);
    const history = (await rig.ok("list_revisions", { uuid })).revisions;
    expect(history).toHaveLength(before.length + 1);
    expect(history[0]).toEqual(restored.revision);
    expect(history.slice(1).map((entry: { id: string }) => entry.id)).toEqual(before.map((entry: { id: string }) => entry.id));
    expect(history[1].endedAt).toEqual(expect.any(String));
    expect(await rig.ok("restore_revision", { uuid, revision: earlier.revision.id }))
      .toMatchObject({ applied: false, synced: true, revision: restored.revision });
    expect((await rig.ok("list_revisions", { uuid })).revisions).toEqual(history);
    await peer.ok("edit_block", { uuid, block_id: remote.blocks[1].id, old_text: remote.blocks[1].text,
      new_text: "Later peer edit", rev: remote.blocks[1].rev });
    expect(await peer.instance.replicas.waitForSettled()).toMatchObject({ caughtUp: true });
    expect((await rig.ok("list_revisions", { uuid })).revisions[0]).toMatchObject({ endedAt: null });
    expect((await rig.ok("get_doc", { uuid })).blocks[1].text).toBe("Later peer edit");
    await rig.ok("restore_revision", { uuid, revision: before[0].id });
    expect(await rig.instance.replicas.waitForSettled()).toMatchObject({ caughtUp: true });
    expect(await rig.ok("get_doc", { uuid })).toMatchObject({ title: "Latest title",
      blocks: [{ text: "Latest prose" }, { text: "Retained prose" }] });
    expect((await rig.ok("get_data", { uuid, collection: "observations" })).records)
      .toMatchObject([{ id: "value", value: { text: "Latest data" } }]);
    expect(live.blocks[1].rev).toBe(original.blocks[1].rev);
    await rig.ok("archive_doc", { uuid });
    expect(await rig.call("restore_revision", { uuid, revision: earlier.revision.id }))
      .toMatchObject({ isError: true, payload: { error: "doc_archived", applied: false, partial: false, synced: false } });
  });

  it("reports restore refusals and unknown outcomes through the writing-tool boundary", async () => {
    const fixture = await admitted();
    const { rig, uuid } = fixture;
    for (const [error, code] of [["stale-state", "revision_stale_state"], ["forbidden", "revisions_forbidden"],
      ["archived", "doc_archived"], ["revision-not-found", "revision_not_found"]] as const) {
      fixture.reply((request, send) => send({ requestId: request.requestId, ok: false, error }));
      expect(await rig.call("restore_revision", { uuid, revision })).toMatchObject({ isError: true,
        payload: { error: code, applied: false, partial: false, synced: false } });
    }
    fixture.reply((request, send) => send({ requestId: request.requestId, ok: false, error: "unavailable" }));
    expect(await rig.call("restore_revision", { uuid, revision })).toMatchObject({ isError: true,
      payload: { error: "revision_restore_outcome_unknown", applied: null, partial: false, synced: false,
        recoveryClass: "reread", reason: "unreachable" } });
  });
  it("serves recorded team-hub revisions, refuses foreign IDs, and reads archived history on a fresh replica", async () => {
    const hub = await createTeamHub({
      address: "127.0.0.1", port: 0, databasePath: ":memory:",
      github: { clientId: "Iv1.0123456789abcdef", fetch: vi.fn(() => { throw new Error("unexpected GitHub request"); }) },
      log() {},
    }, { deviceCredentials: true });
    hubs.push(() => hub.stop());
    if (hub.credentials === undefined || hub.memberships === undefined || hub.principals === undefined) throw new Error("Team authority missing.");
    const author = hub.principals.identify("12345", "revision-author");
    hub.memberships.grant({ workspaceId: WORKSPACE, principalId: author.id, role: "admin" });
    const issued = issueCredential(hub.credentials, { principalId: author.id, deviceId: randomUUID(), workspaces: [WORKSPACE] });
    const env = { XDG_CONFIG_HOME: tempDir() };
    const { replacedAt: _replacedAt, ...record } = issued.record;
    await writeHubLogin(`http://127.0.0.1:${hub.port}`, {
      identity: { id: author.id, githubAccountId: "12345", githubUsername: "revision-author" },
      credential: { record, key: Buffer.from(issued.keyBytes).toString("base64url") },
    }, env);
    const config = () => ({ ...testConfig({ hubUrl: hubUrl(hub.port), ...LIVE_HUB_SETTLE }), deviceLogin: { env } });
    const rig = await startServer(config());
    clients.push(() => rig.close());
    const { uuid } = await rig.ok("create_doc", { title: "Earlier team title", description: "Recorded revisions fixture.",
      blocks: [{ type: "paragraph", text: "Earlier team prose" }] });
    await rig.ok("update_data", { uuid, operations: [{ collection: "observations", schema: textSchema,
      upsert: [{ id: "earlier", value: { text: "earlier team data" } }] }] });
    expect(await rig.instance.replicas.waitForSettled({ deadline: performance.now() + WAIT_TIMEOUT_MS })).toMatchObject({ caughtUp: true });
    const before = await rig.ok("list_revisions", { uuid });
    expect(before.revisions).toHaveLength(1);
    const id = before.revisions[0].id;
    expect(before.revisions[0]).toMatchObject({ author: { githubUsername: "revision-author", surface: { kind: "mcp" } }, startedAt: expect.any(String), endedAt: null });
    expect(before.revisions[0].name).toBeNull();
    const currentState = Y.encodeStateAsUpdate(rig.instance.replicas.replica(uuid).doc);
    const logSize = rig.instance.store.logSize();
    const named = await rig.ok("name_revision", { uuid, name: "Reviewed after auth rewrite" });
    expect(named).toMatchObject({ uuid, applied: true, synced: true, revision: {
      id, author: before.revisions[0].author, endedAt: expect.any(String), name: {
        text: "Reviewed after auth rewrite", namer: { githubUsername: "revision-author", surface: { kind: "mcp" } },
        namedAt: expect.any(String), canManage: true,
      },
    } });
    expect(named.revision.endedAt).toBe(named.revision.name.namedAt);
    expect(Y.encodeStateAsUpdate(rig.instance.replicas.replica(uuid).doc)).toEqual(currentState);
    expect(rig.instance.store.logSize()).toBe(logSize);
    expect(await rig.call("name_revision", { uuid, name: "Duplicate name" })).toMatchObject({ isError: true,
      payload: { error: "revision_already_named", applied: false, partial: false, synced: false,
        existingName: { text: "Reviewed after auth rewrite", namer: { githubUsername: "revision-author" } } } });
    expect((await rig.ok("list_revisions", { uuid })).revisions[0]).toEqual(named.revision);
    await rig.ok("archive_doc", { uuid });
    expect(await rig.instance.replicas.waitForSettled({ deadline: performance.now() + WAIT_TIMEOUT_MS })).toMatchObject({ caughtUp: true });
    await rig.ok("restore_doc", { uuid });
    const live = await rig.ok("get_doc", { uuid });
    await rig.ok("set_metadata", { uuid, title: "Live team title" });
    await rig.ok("edit_block", { uuid, block_id: live.blocks[0].id, old_text: live.blocks[0].text,
      new_text: "Live team prose", rev: live.blocks[0].rev });
    await rig.ok("update_data", { uuid, operations: [{ collection: "observations", deleteRecords: ["earlier"],
      upsert: [{ id: "live", value: { text: "live team data" } }] }] });
    expect(await rig.instance.replicas.waitForSettled({ deadline: performance.now() + WAIT_TIMEOUT_MS })).toMatchObject({ caughtUp: true });
    const listed = await rig.ok("list_revisions", { uuid });
    expect(listed.revisions).toHaveLength(2);
    expect(listed.revisions[0]).toMatchObject({ endedAt: null, startedAt: expect.any(String) });
    expect(listed.revisions[1]).toMatchObject({ id, endedAt: expect.any(String) });
    expect(Date.parse(listed.revisions[0].startedAt)).toBeGreaterThanOrEqual(Date.parse(listed.revisions[1].startedAt));
    expect(await rig.ok("get_revision", { uuid, revision: id })).toMatchObject({ title: "Earlier team title",
      blocks: [{ text: "Earlier team prose" }], data: { collections: [{ name: "observations", recordCount: 1 }] } });
    expect((await rig.ok("get_data", { uuid, revision: id, collection: "observations" })).records)
      .toMatchObject([{ id: "earlier", value: { text: "earlier team data" } }]);
    const other = await rig.ok("create_doc", { title: "Foreign revision", description: "Revision IDs remain document scoped." });
    await rig.ok("insert_block", { uuid: other.uuid, blocks: [{ type: "paragraph", text: "Foreign revision content" }] });
    expect(await rig.instance.replicas.waitForSettled({ deadline: performance.now() + WAIT_TIMEOUT_MS })).toMatchObject({ caughtUp: true });
    const foreign = (await rig.ok("list_revisions", { uuid: other.uuid })).revisions[0].id;
    for (const invalid of ["unknown-revision", foreign]) {
      refusal(await rig.call("get_revision", { uuid, revision: invalid }), "revision_not_found");
      refusal(await rig.call("get_data", { uuid, revision: invalid, collection: "observations" }), "revision_not_found");
    }
    await rig.ok("archive_doc", { uuid });
    expect(await rig.instance.replicas.waitForSettled({ deadline: performance.now() + WAIT_TIMEOUT_MS })).toMatchObject({ caughtUp: true });
    const fresh = await startServer(config());
    clients.push(() => fresh.close());
    expect(await fresh.instance.replicas.waitForSettled({ deadline: performance.now() + WAIT_TIMEOUT_MS })).toMatchObject({ caughtUp: true });
    expect(fresh.instance.replicas.hydrated(uuid)).toBe(false);
    expect((await fresh.ok("list_revisions", { uuid })).revisions.map((entry: { id: string }) => entry.id)).toEqual(listed.revisions.map((entry: { id: string }) => entry.id));
    expect(await fresh.ok("get_revision", { uuid, revision: id })).toMatchObject({ title: "Earlier team title", blocks: [{ text: "Earlier team prose" }] });
    expect((await fresh.ok("get_data", { uuid, revision: id, collection: "observations" })).records)
      .toMatchObject([{ id: "earlier", value: { text: "earlier team data" } }]);

    await rig.ok("restore_doc", { uuid });
    expect(await rig.instance.replicas.waitForSettled({ deadline: performance.now() + WAIT_TIMEOUT_MS })).toMatchObject({ caughtUp: true });
    let droppedReply = false;
    const dropped = hub.hocuspocus.documents.get(roomForDoc(WORKSPACE, uuid))!.getConnections().map(connection => {
      const send = connection.sendStateless.bind(connection);
      return vi.spyOn(connection, "sendStateless").mockImplementation(frame => {
        const response = readRevisionResponse(frame);
        if (response?.ok === true && "revision" in response) {
          droppedReply = true;
          queueMicrotask(() => hub.hocuspocus.closeConnections());
          return;
        }
        send(frame);
      });
    });
    expect(await rig.call("name_revision", { uuid, name: "Committed before the reply was lost" }))
      .toMatchObject({ isError: true, payload: { error: "revision_naming_outcome_unknown", applied: null,
        partial: false, synced: false, reason: "unreachable", recoveryClass: "reread" } });
    expect(droppedReply).toBe(true);
    for (const spy of dropped) spy.mockRestore();
    const afterLoss = await startServer(config());
    clients.push(() => afterLoss.close());
    expect((await afterLoss.ok("list_revisions", { uuid })).revisions[0])
      .toMatchObject({ name: { text: "Committed before the reply was lost" } });
  });

  it("reads hub history in get_doc block shapes and pages historical data independently of live content", async () => {
    const fixture = await admitted();
    const { rig, uuid } = fixture;
    const target = await rig.ok("create_doc", { title: "Linked target", description: "An inline link target." });
    const document = rig.instance.replicas.replica(uuid).doc;
    await rig.ok("set_metadata", { uuid, title: "Earlier title", description: "Excluded description", tldr: "Excluded summary" });
    const inserted = await rig.ok("insert_block", { uuid, blocks: [
      { type: "paragraph", text: "", inline: [
        { text: "Earlier ", marks: { bold: true } },
        { text: "target", marks: { docLink: target.uuid } },
      ] },
      { type: "table", text: `| Label | Reference |\n| :--- | ---: |\n| **Earlier** | [Target](${target.uuid}) |` },
      { type: "card", text: "footer: Foot\ntitle: **Earlier card**\nlabel: Label\n\nA *body*." },
      { type: "figma", text: "height: 560\ntitle: Earlier design\nurl: https://www.figma.com/design/k3Lm9QzT2x/Checkout-flow?node-id=12-345\n\nA **caption**." },
    ] });
    await rig.ok("annotate", { uuid, block_id: inserted.blocks[0].id, start: 0, end: 7, text: "Excluded comment" });
    await rig.ok("update_data", { uuid, operations: [{ collection: "observations", schema: textSchema, upsert: [
      { id: "c", value: { text: "earlier c" } }, { id: "a", value: { text: "earlier a" } }, { id: "b", value: { text: "earlier b" } },
    ] }] });
    const earlier = await rig.ok("get_doc", { uuid });
    const earlierData = await rig.ok("get_data", { uuid });
    const snapshot = snapshotRevision(document).state;
    const expectedBlocks = earlier.blocks.map(({ rev: _rev, ...block }: Record<string, unknown>) => block);
    await rig.ok("set_metadata", { uuid, title: "Live title" });
    await rig.ok("edit_block", { uuid, block_id: earlier.blocks[0].id, old_text: earlier.blocks[0].text,
      new_text: "Live content", rev: earlier.blocks[0].rev });
    await rig.ok("update_data", { uuid, operations: [{ collection: "observations", deleteRecords: ["b", "c"], upsert: [
      { id: "a", value: { text: "live a" } },
    ] }] });
    const entries = [
      { id: "current-open", author: { githubUsername: "current-handle", surface: { kind: "mcp", name: "Codex" } }, startedAt: 200, endedAt: null },
      { id: revision, author: { githubUsername: "person", surface: { kind: "web", name: "Browser" } }, startedAt: 100, endedAt: 200 },
      { id: "before-history", author: null, startedAt: null, endedAt: 100 },
    ];
    const requests: RevisionRequest[] = [];
    fixture.reply((request, send) => {
      requests.push(request);
      send(request.operation === "list"
        ? { requestId: request.requestId, ok: true, revisions: entries }
        : { requestId: request.requestId, ok: true, state: snapshot });
    });
    const liveState = Y.encodeStateAsUpdate(document);
    expect(await rig.ok("list_revisions", { uuid })).toEqual({ uuid, revisions: [
      { ...entries[0], startedAt: "1970-01-01T00:00:00.200Z", name: null },
      { ...entries[1], startedAt: "1970-01-01T00:00:00.100Z", endedAt: "1970-01-01T00:00:00.200Z", name: null },
      { ...entries[2], endedAt: "1970-01-01T00:00:00.100Z", name: null },
    ] });
    const historical = await rig.ok("get_revision", { uuid, revision });
    expect(historical).toEqual({ uuid, revision, title: "Earlier title", blocks: expectedBlocks, data: earlierData.data });
    expect(historical.blocks.find((block: { type: string }) => block.type === "paragraph" && "doc_links" in block)?.doc_links)
      .toEqual([{ start: 8, end: 14, docId: target.uuid }]);
    expect(historical.blocks.find((block: { type: string }) => block.type === "table").text)
      .toBe(`| Label | Reference |\n| --- | --- |\n| **Earlier** | [Target](${target.uuid}) |`);
    expect(historical.blocks.find((block: { type: string }) => block.type === "card").text)
      .toBe("label: Label\ntitle: **Earlier card**\nfooter: Foot\n\nA *body*.");
    expect(historical.blocks.find((block: { type: string }) => block.type === "figma").figma)
      .toEqual({ kind: "frame", file: "k3Lm9QzT2x", fileName: "Checkout flow", node: "12:345" });
    expect(await rig.ok("get_data", { uuid, revision })).toEqual({ ...earlierData, revision });
    const first = await rig.ok("get_data", { uuid, revision, collection: "observations", limit: 1 });
    expect(first).toMatchObject({ uuid, revision, recordCount: 3, records: [{ id: "a", value: { text: "earlier a" } }], complete: false, next_after: "a" });
    const next = await rig.ok("get_data", { uuid, revision, collection: "observations", after: first.next_after, limit: 1 });
    expect(next).toMatchObject({ revision, records: [{ id: "b", value: { text: "earlier b" } }], complete: false, next_after: "b" });
    const selected = await rig.ok("get_data", { uuid, revision, collection: "observations", after: "a", ids: ["c", "missing", "a"], max_bytes: 1 });
    expect(selected).toMatchObject({ revision, records: [{ id: "c", value: { text: "earlier c" } }], missing_ids: ["missing"], complete: true, next_after: null });
    const missing = await rig.call("get_data", { uuid, revision, collection: "absent" });
    refusal(missing, "data_collection_not_found");
    expect(missing.payload).toMatchObject({ uuid, revision, collection: "absent", recovery: expect.stringContaining("uuid and revision") });
    expect(requests).toHaveLength(7);
    for (const request of requests.slice(1)) expect(request).toMatchObject({ operation: "get", revisionId: revision });
    expect(Y.encodeStateAsUpdate(document)).toEqual(liveState);
    expect(getMeta(document).title).toBe("Live title");
    expect((await rig.ok("get_data", { uuid, collection: "observations" })).records)
      .toMatchObject([{ id: "a", value: { text: "live a" } }]);
  });

  it("returns an empty history only after a positive hub reply", async () => {
    const fixture = await admitted();
    let requests = 0;
    fixture.reply((request, send) => { requests += 1; send({ requestId: request.requestId, ok: true, revisions: [] }); });
    expect(await fixture.rig.ok("list_revisions", { uuid: fixture.uuid })).toEqual({ uuid: fixture.uuid, revisions: [] });
    expect(requests).toBe(1);
  });

  it("projects both revision tools' declared fields and ISO times while preserving nulls", async () => {
    const fixture = await admitted();
    const { rig, uuid } = fixture;
    const entries = [
      {
        id: "named-revision", title: "Historical title", futureField: "entry",
        author: { githubUsername: "author", futureField: "author",
          surface: { kind: "web", name: "Browser", futureField: "author surface" } },
        startedAt: 0, endedAt: 100,
        name: { text: "Named state", futureField: "name",
          namer: { githubUsername: "namer", futureField: "namer",
            surface: { kind: "mcp", name: "Codex", futureField: "namer surface" } },
          namedAt: Date.parse("2026-10-21T18:36:13.213Z"), canManage: true },
      },
      { id: "unknown-author", author: null, startedAt: null, endedAt: null,
        name: { text: "Unknown attribution", namer: null, namedAt: -1, canManage: false } },
      { id: "unnamed-revision", author: null, startedAt: null, endedAt: 0, name: null },
      { id: "legacy-revision", author: null, startedAt: null, endedAt: 0 },
    ];
    const expected = [
      { id: "named-revision", author: { githubUsername: "author", surface: { kind: "web", name: "Browser" } },
        startedAt: "1970-01-01T00:00:00.000Z", endedAt: "1970-01-01T00:00:00.100Z",
        name: { text: "Named state", namer: { githubUsername: "namer", surface: { kind: "mcp", name: "Codex" } },
          namedAt: "2026-10-21T18:36:13.213Z", canManage: true } },
      { id: "unknown-author", author: null, startedAt: null, endedAt: null,
        name: { text: "Unknown attribution", namer: null, namedAt: "1969-12-31T23:59:59.999Z", canManage: false } },
      { id: "unnamed-revision", author: null, startedAt: null, endedAt: "1970-01-01T00:00:00.000Z", name: null },
      { id: "legacy-revision", author: null, startedAt: null, endedAt: "1970-01-01T00:00:00.000Z", name: null },
    ];
    fixture.reply((request, send) => {
      if (request.operation === "list") {
        expect(request).toMatchObject({ includeNames: true });
        expect(request).not.toHaveProperty("includeTitles");
      }
      send(request.operation === "list"
        ? { requestId: request.requestId, ok: true, revisions: entries }
        : { requestId: request.requestId, ok: true,
          revision: request.name === "Named state" ? entries[0]! : entries[1]! });
    });
    expect(await rig.ok("list_revisions", { uuid })).toEqual({ uuid, revisions: expected });
    for (const entry of expected.slice(0, 2)) {
      const named = await rig.ok("name_revision", { uuid, name: entry.name!.text });
      expect(named).toMatchObject({ uuid, applied: true, synced: true });
      expect(named.revision).toEqual(entry);
    }
  });

  it("fails rather than changing unrepresentable revision times into null or another time", async () => {
    const fixture = await admitted();
    const base = { id: revision, author: null, startedAt: 0, endedAt: 100,
      name: { text: "Named state", namer: null, namedAt: 100, canManage: true } };
    let entry = base;
    fixture.reply((request, send) => send(request.operation === "list"
      ? { requestId: request.requestId, ok: true, revisions: [entry] }
      : { requestId: request.requestId, ok: true, revision: entry }));
    for (const stamp of [Number.MAX_VALUE, 100.5]) {
      for (const field of ["startedAt", "endedAt", "namedAt"]) {
        entry = field === "namedAt" ? { ...base, name: { ...base.name, namedAt: stamp } }
          : { ...base, [field]: stamp };
        for (const [tool, args] of [
          ["list_revisions", { uuid: fixture.uuid }],
          ["name_revision", { uuid: fixture.uuid, name: "Named state" }],
        ] as const) {
          expect(await fixture.rig.call(tool, args), `${tool} accepted unrepresentable ${field}: ${stamp}`)
            .toMatchObject({ isError: true, payload: { error: "internal_error" } });
        }
      }
    }
  });

  it("refuses unknown and permanently deleted UUIDs before joining a room or requesting hub history", async () => {
    const fixture = await admitted();
    const { rig, uuid } = fixture;
    await rig.ok("archive_doc", { uuid });
    await rig.ok("delete_doc", { uuid });
    const request = vi.spyOn(rig.instance.replicas.sync, "requestRevisions");
    const open = vi.spyOn(rig.instance.replicas, "replica");
    const unknown = randomUUID();
    for (const [tool, args] of calls(unknown)) refusal(await rig.call(tool, args), "doc_not_found");
    for (const [tool, args] of calls(uuid)) {
      const result = await rig.call(tool, args);
      refusal(result, "doc_deleted");
      expect(result.payload).toHaveProperty("uuid", uuid);
    }
    for (const [target, code] of [[unknown, "doc_not_found"], [uuid, "doc_deleted"]] as const) {
      for (const [tool, args] of writeCalls(target)) {
        expect(await rig.call(tool, args)).toMatchObject({ isError: true,
          payload: { error: code, uuid: target, applied: false, partial: false, synced: false } });
      }
    }
    expect(request).not.toHaveBeenCalled();
    expect(open.mock.calls.some(([id]) => id === unknown || id === uuid)).toBe(false);
  });

  it("refuses every decision state and archived record uniformly without hydration, hub requests or writes", async () => {
    const rig = await server();
    const replicas = rig.instance.replicas;
    const request = vi.spyOn(replicas.sync, "requestRevisions");
    for (const status of ["open", "decided", "rejected", "withdrawn"] as const) {
      for (const archived of [false, true]) {
        const uuid = randomUUID();
        const topic = randomUUID();
        upsertDirectoryEntry(replicas.directory().doc, { uuid, title: "Decision elsewhere", kind: "decision", topic, status });
        if (archived) tombstoneDirectoryEntry(replicas.directory().doc, uuid);
        expect(replicas.hydrated(uuid)).toBe(false);
        const logged = rig.instance.store.logSize();
        for (const [tool, args] of [...calls(uuid), ["get_data", { uuid, revision }] as const, ...writeCalls(uuid)]) {
          const result = await rig.call(tool, args);
          expect(result).toMatchObject({ isError: true, payload: {
            error: "decision_no_history", message: expect.stringContaining("Decision records have no history"),
            uuid, topic, recoveryClass: "manual", recovery: expect.stringContaining("topic's records"),
          } });
          if (tool === "name_revision" || tool === "restore_revision") {
            expect(result.payload).toMatchObject({ applied: false, partial: false, synced: false });
          } else {
            refusal(result, "decision_no_history");
          }
        }
        expect(rig.instance.store.logSize()).toBe(logged);
        expect(replicas.hydrated(uuid)).toBe(false);
      }
    }
    expect(request).not.toHaveBeenCalled();
  });

  it("prefers no-history to the decided content lock while preserving live decision data reads", async () => {
    const rig = await server();
    const { uuid } = await rig.ok("create_doc", { title: "Why this choice?", description: "A settled decision.",
      kind: "decision", status: "decided", blocks: [{ type: "paragraph", text: "Use the existing primitive." }] });
    const request = vi.spyOn(rig.instance.replicas.sync, "requestRevisions");
    const logged = rig.instance.store.logSize();
    for (const [tool, args] of writeCalls(uuid)) {
      expect(await rig.call(tool, args)).toMatchObject({ isError: true, payload: {
        error: "decision_no_history", uuid, topic: uuid, applied: false, partial: false, synced: false,
      } });
    }
    expect(await rig.ok("get_data", { uuid })).toEqual({ uuid, data: null });
    expect(rig.instance.store.logSize()).toBe(logged);
    expect(request).not.toHaveBeenCalled();
  });

  it("reads a known archived document without depending on live room hydration", async () => {
    const rig = await server({ authSecret: TEST_SECRET, hubUrl: "ws://127.0.0.1:1" });
    const uuid = randomUUID();
    upsertDirectoryEntry(rig.instance.replicas.directory().doc, { uuid, title: "Archived elsewhere" });
    tombstoneDirectoryEntry(rig.instance.replicas.directory().doc, uuid);
    expect(rig.instance.replicas.hydrated(uuid)).toBe(false);
    const snapshot = new Y.Doc();
    clients.push(() => snapshot.destroy());
    getMetaMap(snapshot).set("title", "Earlier archived title");
    const state = Y.encodeStateAsUpdate(snapshot);
    const request = vi.spyOn(rig.instance.replicas.sync, "requestRevisions").mockImplementation(async (_room, operation) =>
      operation.operation === "list"
        ? { requestId: "fixture", ok: true, revisions: [] }
        : { requestId: "fixture", ok: true, state });
    expect(await rig.ok("list_revisions", { uuid })).toEqual({ uuid, revisions: [] });
    expect(await rig.ok("get_revision", { uuid, revision })).toEqual({ uuid, revision, title: "Earlier archived title", blocks: [], data: null });
    expect(await rig.ok("get_data", { uuid, revision })).toEqual({ uuid, revision, data: null });
    expect(request).toHaveBeenCalledTimes(3);
    expect(rig.instance.replicas.hydrated(uuid)).toBe(false);
  });

  it.each([
    ["unsupported", "revisions_unsupported"], ["forbidden", "revisions_forbidden"],
    ["deleted", "doc_deleted"], ["revision-not-found", "revision_not_found"], ["unavailable", "revisions_unreachable"],
  ] as const)("maps the hub's %s refusal for every historical read", async (error, code) => {
    const fixture = await admitted();
    fixture.reply((request, send) => send({ requestId: request.requestId, ok: false, error }));
    for (const [tool, args] of calls(fixture.uuid)) {
      const result = await fixture.rig.call(tool, args);
      refusal(result, code);
      if (error === "deleted") expect(result.payload).toHaveProperty("uuid", fixture.uuid);
    }
    if (error === "deleted") {
      expect(await fixture.rig.call("name_revision", { uuid: fixture.uuid, name: "Deleted state" }))
        .toMatchObject({ isError: true,
          payload: { error: "doc_deleted", uuid: fixture.uuid, applied: false, partial: false, synced: false } });
    }
  });

  it("keeps the UUID when the hub refuses permanent deletion during room admission", async () => {
    const { rig, uuid } = await admitted();
    vi.spyOn(rig.instance.replicas.sync, "requestRevisions").mockRejectedValue(new RevisionClientError("deleted"));
    for (const [tool, args] of calls(uuid)) {
      const result = await rig.call(tool, args);
      refusal(result, "doc_deleted");
      expect(result.payload).toHaveProperty("uuid", uuid);
    }
    expect(await rig.call("name_revision", { uuid, name: "Deleted state" })).toMatchObject({ isError: true,
      payload: { error: "doc_deleted", uuid, applied: false, partial: false, synced: false } });
  });

  it("distinguishes a local-only workspace from missing sign-in for all historical reads", async () => {
    const local = await server();
    const uuid = randomUUID();
    upsertDirectoryEntry(local.instance.replicas.directory().doc, { uuid, title: "Known local document" });
    for (const [tool, args] of calls(uuid)) refusal(await local.call(tool, args), "revisions_local_only");

    const hub = await startDeviceSyncHub({ directory: tempDir() });
    hubs.push(() => hub.close());
    const loginConfig = { ...testConfig({ hubUrl: hub.url }), deviceLogin: { env: { XDG_CONFIG_HOME: tempDir() } } };
    const noLogin = await startServer(loginConfig);
    clients.push(() => noLogin.close());
    upsertDirectoryEntry(noLogin.instance.replicas.directory().doc, { uuid, title: "Known team document" });
    for (const [tool, args] of calls(uuid)) refusal(await noLogin.call(tool, args), "revisions_sign_in_required");
  });

  it("advertises revision help and permits historical writes only through restore_revision", async () => {
    const rig = await server();
    const advertised = (await rig.client.listTools()).tools;
    const revisionProperties = {
      startedAt: { type: ["string", "null"] },
      endedAt: { type: ["string", "null"] },
      name: { anyOf: [{ properties: { namedAt: { type: "string" } } }, { type: "null" }] },
    };
    expect(advertised.find(tool => tool.name === "list_revisions")?.outputSchema).toMatchObject({
      properties: { revisions: { items: { properties: revisionProperties } } },
    });
    expect(advertised.find(tool => tool.name === "name_revision")?.outputSchema).toMatchObject({
      properties: { revision: { properties: revisionProperties } },
    });
    for (const name of ["list_revisions", "name_revision"]) {
      expect(JSON.stringify(advertised.find(tool => tool.name === name)?.outputSchema)).not.toContain("epoch milliseconds");
    }
    for (const name of ["list_revisions", "get_revision", "get_data"]) {
      expect(advertised.find(tool => tool.name === name)?.annotations)
        .toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
      const help = await rig.ok("get_help", { topic: name });
      expect(help.text).toContain(name);
      expect(help.text).toContain("revision");
      expect(help.text).toContain("Example");
      if (name === "list_revisions") {
        expect(help.text).toContain("ISO 8601 UTC");
        expect(help.text).not.toContain("epoch milliseconds");
      }
    }
    const contracts = await rig.ok("get_help", { topic: "tool-contracts" });
    expect(advertised.find(tool => tool.name === "name_revision")?.annotations)
      .toEqual({ readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    expect(advertised.find(tool => tool.name === "restore_revision")?.annotations)
      .toEqual({ readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false });
    expect((await rig.ok("get_help", { topic: "restore_revision" })).text).toContain("revision_restore_outcome_unknown");
    expect((await rig.ok("get_help", { topic: "name_revision" })).text).toContain("only when a person asks");
    for (const name of ["list_revisions", "get_revision", "get_data", "name_revision", "restore_revision"]) {
      expect((await rig.ok("get_help", { topic: name })).text).toContain("decision_no_history");
    }
    for (const code of ["revisions_local_only", "revisions_unreachable", "revisions_sign_in_required", "revisions_forbidden", "revisions_unsupported", "revision_not_found", "doc_deleted", "decision_no_history"]) {
      expect(contracts.text).toContain(code);
    }
    for (const tool of tools.filter(tool => tool.writes !== null && tool.name !== "restore_revision")) {
      const parsed = tool.input.safeParse({ ...tool.example, revision });
      expect(parsed.success, `${tool.name} accepted a historical revision`).toBe(false);
      if (!parsed.success) expect(parsed.error.issues).toContainEqual(expect.objectContaining({ code: "unrecognized_keys", keys: ["revision"] }));
    }
    const logged = rig.instance.store.logSize();
    expect(await rig.call("get_revision", { uuid: randomUUID(), revision: "" }))
      .toMatchObject({ isError: true, payload: { error: "schema_validation" } });
    expect(rig.instance.store.logSize()).toBe(logged);
  });
});
