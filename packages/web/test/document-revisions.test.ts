// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { appendBlock, getBlocks, getMeta, initDoc } from "@uberblick/schema";
import { createDocumentRevisionsClient, DocumentHistoryError } from "../src/shell/document-revisions.js";
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
beforeEach(() => vi.clearAllMocks());
afterEach(() => { for (const doc of documents.splice(0)) doc.destroy(); });

function client(body: unknown, status = 200) {
  const fetchImpl = vi.fn<typeof fetch>(async () => Response.json(body, { status }));
  return { api: createDocumentRevisionsClient("workspace", "browser", fetchImpl as typeof fetch), fetchImpl };
}

describe("document revision reads", () => {
  it("keeps newest-first metadata and authenticates uncached local requests with the page session", async () => {
    const { api, fetchImpl } = client({ revisions: entries });
    const controller = new AbortController();
    await expect(api.list(UUID, controller.signal)).resolves.toEqual(entries);
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
    await expect(client({ revisions: [] }).api.list(UUID, new AbortController().signal)).resolves.toEqual([]);
    await expect(client({ revisions: [] }, 503).api.list(UUID, new AbortController().signal)).rejects.toBeInstanceOf(DocumentHistoryError);
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
