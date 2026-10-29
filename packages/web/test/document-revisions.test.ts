// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { appendBlock, getBlocks, getMeta, initDoc, snapshotRevision } from "@uberblick/schema";
import { createHash } from "node:crypto";
import { createDocumentRevisionsClient, documentRevisionChecksum, DocumentHistoryError } from "../src/shell/document-revisions.js";
import { mintHubAuthMessage } from "../src/collab/rooms.js";
import { localSessionHeaders } from "../src/collab/local-session.js";

vi.mock("../src/collab/rooms.js", () => ({ mintHubAuthMessage: vi.fn(async () => "local-browser-proof") }));
vi.mock("../src/collab/local-session.js", () => ({ localSessionHeaders: vi.fn(async () => ({ "X-Uberblick-Session": "page-session" })) }));

const UUID = "9f3c1a2b-0000-4000-8000-0123456789ab";
const entries = [
  { id: "newest", author: { githubUsername: "ben", surface: { kind: "mcp", name: "Claude Code" } }, startedAt: 100, endedAt: null },
  { id: "earlier", author: null, startedAt: null, endedAt: 100 },
];
const documents: Y.Doc[] = [];
const history = { complete: true, lastRefresh: "2026-10-28T12:00:00.000Z", refreshFailed: false, offline: false, newestDownloadedRevision: "newest" };
beforeEach(() => vi.clearAllMocks());
afterEach(() => { for (const doc of documents.splice(0)) doc.destroy(); });

function client(body: unknown, status = 200) {
  const fetchImpl = vi.fn<typeof fetch>(async () => Response.json(
    body !== null && typeof body === "object" && !Array.isArray(body) ? { history, ...body } : body, { status }));
  return { api: createDocumentRevisionsClient("workspace", "browser", fetchImpl as typeof fetch), fetchImpl };
}

describe("document revision reads", () => {
  it("captures the displayed document's content before hashing yields to later edits", async () => {
    const source = new Y.Doc();
    documents.push(source);
    initDoc(source, { uuid: UUID, title: "Displayed state" });
    appendBlock(source, { type: "paragraph", text: "Reviewed words" });
    const expected = createHash("sha256").update(snapshotRevision(source).checksum).digest("hex");
    const checksum = documentRevisionChecksum(source);
    appendBlock(source, { type: "paragraph", text: "Later incoming edit" });
    await expect(checksum).resolves.toBe(expected);
    await expect(documentRevisionChecksum(source)).resolves.not.toBe(expected);
  });

  it("preserves opt-in naming metadata and writes the browser's captured checksum with local authorization", async () => {
    const revision = { ...entries[0], endedAt: 120, name: {
      text: "Reviewed", namer: { githubUsername: "ben", surface: { kind: "browser", name: "Browser" } }, namedAt: 120, canManage: true,
    } };
    await expect(client({ revisions: [revision] }).api.list(UUID, new AbortController().signal)).resolves.toEqual({ revisions: [revision], history });
    const { api, fetchImpl } = client({ revision });
    const controller = new AbortController();
    await expect(api.name(UUID, "Reviewed", "browser-sha", controller.signal)).resolves.toEqual(revision);
    const [path, request] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe("/api/revisions");
    expect(request).toMatchObject({ method: "POST", cache: "no-store", headers: {
      "Content-Type": "application/json", Authorization: "Bearer local-browser-proof", "X-Uberblick-Session": "page-session",
    } });
    expect(JSON.parse(request.body as string)).toEqual({ uuid: UUID, operation: "name", name: "Reviewed", expectedHash: "browser-sha" });
    await api.rename(UUID, "newest", "Accepted", controller.signal);
    expect(JSON.parse(fetchImpl.mock.calls[1]![1]!.body as string)).toEqual({ uuid: UUID, operation: "rename", revisionId: "newest", name: "Accepted" });
    await api.removeName(UUID, "newest", controller.signal);
    expect(JSON.parse(fetchImpl.mock.calls[2]![1]!.body as string)).toEqual({ uuid: UUID, operation: "remove_name", revisionId: "newest" });
  });

  it.each([
    ["stale-state", /review the current content/], ["invalid-name", /1 to 100/],
    ["already-named", /already has a name/], ["archived", /Archived documents/],
  ])("explains a refused %s naming write", async (reason, message) => {
    await expect(client({ reason }, 409).api.name(UUID, "Reviewed", "hash", new AbortController().signal)).rejects.toThrow(message);
  });

  it("identifies an existing name and namer when naming the same state is refused", async () => {
    await expect(client({ reason: "already-named", existingName: { text: "Previously accepted", namer: { githubUsername: "alice" } } }, 409)
      .api.name(UUID, "Reviewed", "hash", new AbortController().signal)).rejects.toThrow("This revision is already named “Previously accepted” by alice. Open history to see it.");
  });

  it.each([
    [{ kind: "browser", name: "Browser" }, "in the browser"],
    [{ kind: "mcp", name: "CLAUDE Desktop" }, "via Claude"],
    [{ kind: "mcp", name: "codex" }, "via Codex"],
    [{ kind: "Claude", name: "Other client" }, "via Claude"],
    [{ kind: "CODEX", name: "Other client" }, "via Codex"],
    [{ kind: "mcp", name: "Review client" }, "via Review client"],
    [{ kind: "unknown", name: "" }, "via unknown"],
  ])("names the existing revision's namer surface %j as %s", async (surface, label) => {
    await expect(client({ reason: "already-named", existingName: {
      text: "Previously accepted", namer: { githubUsername: "alice", surface },
    } }, 409).api.name(UUID, "Reviewed", "hash", new AbortController().signal))
      .rejects.toThrow(`This revision is already named “Previously accepted” by alice ${label}. Open history to see it.`);
  });

  it.each([true, false])("restores by revision id with the reviewed live checksum and reports applied=%s", async applied => {
    const { api, fetchImpl } = client({ revision: entries[0], applied });
    await expect(api.restore(UUID, "earlier", "history-open-sha", new AbortController().signal))
      .resolves.toEqual({ revision: entries[0], applied });
    expect(JSON.parse(fetchImpl.mock.calls[0]![1]!.body as string)).toEqual({
      uuid: UUID, operation: "restore", revisionId: "earlier", expectedHash: "history-open-sha",
    });
  });

  it("explains stale restores and distinguishes a lost restore reply from a refusal", async () => {
    const signal = new AbortController().signal;
    await expect(client({ reason: "stale-state" }, 409).api.restore(UUID, "earlier", "hash", signal))
      .rejects.toThrow("This document changed. Review the newer changes in history and try again.");
    await expect(client({ reason: "archived" }, 409).api.restore(UUID, "earlier", "hash", signal))
      .rejects.toThrow("This document is archived. Restore the document first, then restore a revision.");
    await expect(client({ reason: "restore-outcome-unknown" }, 503).api.restore(UUID, "earlier", "hash", signal))
      .rejects.toThrow("The restore may have completed. Review the latest document and history before trying again.");
    const lost = createDocumentRevisionsClient("workspace", "browser", async () => { throw new Error("Lost reply"); });
    await expect(lost.restore(UUID, "earlier", "hash", signal))
      .rejects.toThrow("The restore may have completed. Review the latest document and history before trying again.");
    await expect(client({ revision: entries[0] }).api.restore(UUID, "earlier", "hash", signal))
      .rejects.toThrow("The restore may have completed. Review the latest document and history before trying again.");
  });

  it("keeps newest-first metadata and authenticates uncached local requests with the page session", async () => {
    const { api, fetchImpl } = client({ revisions: entries });
    const controller = new AbortController();
    await expect(api.list(UUID, controller.signal)).resolves.toEqual({ revisions: entries, history });
    await api.list(UUID, controller.signal);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(mintHubAuthMessage).toHaveBeenNthCalledWith(1, "workspace", "browser");
    expect(mintHubAuthMessage).toHaveBeenCalledTimes(2);
    expect(localSessionHeaders).toHaveBeenCalledTimes(2);
    const [path, request] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe(`/api/revisions?uuid=${UUID}`);
    expect(path).not.toContain("local-browser-proof");
    expect(path).not.toContain("page-session");
    expect(request).toMatchObject({ cache: "no-store", headers: {
      Accept: "application/json", Authorization: "Bearer local-browser-proof", "X-Uberblick-Session": "page-session",
    } });
    expect(request.signal?.aborted).toBe(false);
    controller.abort();
    expect(request.signal?.aborted).toBe(true);
  });

  it("decodes each historical document into an independent copy without changing its source", async () => {
    const source = new Y.Doc();
    documents.push(source);
    initDoc(source, { uuid: UUID, title: "Historical title" });
    appendBlock(source, { type: "paragraph", text: "Original words" });
    source.getMap("data").set('["record","sales","first"]', { amount: 42 });
    const { api, fetchImpl } = client({ state: Buffer.from(Y.encodeStateAsUpdate(source)).toString("base64") });
    const snapshot = await api.get(UUID, "open revision&one", new AbortController().signal);
    documents.push(snapshot);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(`/api/revisions?uuid=${UUID}&revision=open%20revision%26one`);
    expect(getMeta(snapshot).title).toBe("Historical title");
    expect(getBlocks(snapshot)).toMatchObject([{ text: "Original words" }]);
    expect(snapshot.getMap("data").get('["record","sales","first"]')).toEqual({ amount: 42 });
    appendBlock(snapshot, { type: "paragraph", text: "Only in detached copy" });
    snapshot.getMap("data").set('["record","sales","first"]', { amount: 99 });
    expect(getBlocks(source)).toHaveLength(1);
    expect(source.getMap("data").get('["record","sales","first"]')).toEqual({ amount: 42 });
  });

  it("accepts an empty list only after a successful well-formed reply", async () => {
    await expect(client({ revisions: [] }).api.list(UUID, new AbortController().signal)).resolves.toEqual({ revisions: [], history });
    await expect(client({ revisions: [] }, 503).api.list(UUID, new AbortController().signal)).rejects.toBeInstanceOf(DocumentHistoryError);
  });

  it("carries cache status, explicit refresh and the missing offline revision through the local transport", async () => {
    const offline = { ...history, offline: true, complete: false, refreshFailed: true };
    const { api, fetchImpl } = client({ revisions: entries, history: offline });
    await expect(api.list(UUID, new AbortController().signal, { refresh: true })).resolves.toEqual({ revisions: entries, history: offline });
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(`/api/revisions?uuid=${UUID}&refresh=true`);
    const missing = client({ reason: "not-downloaded", revision: "earlier", history: offline }, 503);
    await expect(missing.api.get(UUID, "earlier", new AbortController().signal)).rejects.toMatchObject({
      reason: "not-downloaded", revision: "earlier", history: offline,
      message: "Revision “earlier” is not downloaded on this computer. Connect to download it.",
    });
    await expect(client({ reason: "downloading" }, 503).api.list(UUID, new AbortController().signal))
      .rejects.toThrow("History is still downloading");
    await expect(client({ reason: "not-downloaded" }, 503).api.list(UUID, new AbortController().signal))
      .rejects.toThrow("Connect once to download history.");
  });

  it.each([undefined, null, {}, { ...history, complete: "yes" }])("rejects unusable cache status %j", async history => {
    await expect(client({ revisions: entries, history }).api.list(UUID, new AbortController().signal)).rejects.toBeInstanceOf(DocumentHistoryError);
  });

  it("resumes the original bounded read and recovers an expired continuation without losing its target", async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ reason: "downloading", readId: "pending-read" }, { status: 503 }))
      .mockResolvedValueOnce(Response.json({ error: "invalid_history_read" }, { status: 400 }))
      .mockResolvedValueOnce(Response.json({ revisions: entries, history }));
    const api = createDocumentRevisionsClient("workspace", "browser", fetchImpl);
    const signal = new AbortController().signal;
    await expect(api.list(UUID, signal, { refresh: true })).rejects.toMatchObject({ reason: "downloading" });
    await expect(api.list(UUID, signal, { refresh: true })).resolves.toEqual({ revisions: entries, history });
    expect(fetchImpl.mock.calls.map(call => call[0])).toEqual([
      `/api/revisions?uuid=${UUID}&refresh=true`,
      `/api/revisions?uuid=${UUID}&refresh=true&readId=pending-read`,
      `/api/revisions?uuid=${UUID}&refresh=true`,
    ]);
  });

  it("invalidates pre-mutation refresh continuations, including replies arriving after acknowledgement", async () => {
    let finish: (response: Response) => void = () => {};
    const pending = new Promise<Response>(resolve => { finish = resolve; });
    const fetchImpl = vi.fn<typeof fetch>()
      .mockReturnValueOnce(pending)
      .mockResolvedValueOnce(Response.json({ revision: entries[0] }))
      .mockResolvedValueOnce(Response.json({ revisions: entries, history }));
    const api = createDocumentRevisionsClient("workspace", "browser", fetchImpl);
    const signal = new AbortController().signal;
    const oldRefresh = api.list(UUID, signal, { refresh: true });
    // Wait for the request to own its position before the mutation.
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce());
    await api.rename(UUID, "newest", "Acknowledged name", signal);
    const oldFailure = expect(oldRefresh).rejects.toMatchObject({ reason: "downloading" });
    finish(Response.json({ reason: "downloading", readId: "pre-mutation" }, { status: 503 }));
    await oldFailure;
    await api.list(UUID, signal, { refresh: true });
    expect(fetchImpl.mock.calls[2]?.[0]).toBe(`/api/revisions?uuid=${UUID}&refresh=true`);
  });

  it.each([
    ["unreachable", /hub cannot be reached/], ["sign-in-required", /sign in/],
    ["forbidden", /refused access/], ["unsupported", /does not serve revisions/],
    ["deleted", /document was deleted/], ["revision-not-found", /revision no longer exists/],
    ["local-only", /local-only workspace/], ["invented-cause", /Try again/],
  ])("reports %s as unavailable instead of an empty history", async (reason, message) => {
    const { api } = client({ error: "history_unavailable", reason }, 503);
    await expect(api.list(UUID, new AbortController().signal)).rejects.toThrow(message);
    await expect(api.get(UUID, "revision", new AbortController().signal)).rejects.toThrow(message);
  });

  it.each([
    null, [], {}, { revisions: "empty" }, { revisions: [null] },
    { revisions: [{ ...entries[0], startedAt: "today" }] },
    { revisions: [{ ...entries[0], author: { githubUsername: "ben" } }] },
    { revisions: [{ ...entries[0], endedAt: true }] },
    { state: "AA==" },
  ])("rejects malformed list answers: %j", async body => {
    await expect(client(body).api.list(UUID, new AbortController().signal)).rejects.toBeInstanceOf(DocumentHistoryError);
  });

  it.each([{}, { revisions: entries }, { state: 12 }, { state: "!not base64!" }, { state: "AA==" }])(
    "rejects invalid snapshot answers without presenting a partial document: %j", async body => {
      await expect(client(body).api.get(UUID, "revision", new AbortController().signal)).rejects.toBeInstanceOf(DocumentHistoryError);
    },
  );

  it("rejects unreadable JSON and failed transport rather than returning history", async () => {
    const invalidJson = createDocumentRevisionsClient("workspace", "browser", async () => new Response("broken JSON"));
    await expect(invalidJson.list(UUID, new AbortController().signal)).rejects.toThrow();
    const offline = createDocumentRevisionsClient("workspace", "browser", async () => { throw new TypeError("fetch failed"); });
    await expect(offline.list(UUID, new AbortController().signal)).rejects.toThrow();
  });
});
