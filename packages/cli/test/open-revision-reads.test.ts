import { afterEach, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { getMeta, initDoc } from "@uberblick/schema";
import { readDocumentHistory, readDocumentRevision, requireDocumentHistory, RevisionClientError,
  WorkspaceDetachedError, WorkspaceRemovedError, type HistoryReadStatus, type UberblickMcpEngine } from "@uberblick/mcp-server";
import { serveRevisionRead } from "../src/open-revision-reads.js";

vi.mock("@uberblick/mcp-server", async importOriginal => ({
  ...await importOriginal<typeof import("@uberblick/mcp-server")>(),
  readDocumentHistory: vi.fn(),
  readDocumentRevision: vi.fn(),
  requireDocumentHistory: vi.fn(),
}));

const UUID = "7a819902-f86e-45d1-84d3-58d8f979a503";
const OTHER_UUID = "857eff05-19fc-42e0-baf1-b367096408a4";
const history: HistoryReadStatus = { complete: true, lastRefresh: "2026-10-28T17:00:00.000Z", refreshFailed: false,
  offline: false, newestDownloadedRevision: "revision-1" };
function engine(): UberblickMcpEngine {
  return { replicas: { store: { assertWorkspacePresent: vi.fn() }, config: {} } } as unknown as UberblickMcpEngine;
}
function address(query = ""): URL { return new URL(`http://localhost/api/revisions?uuid=${UUID}${query}`); }
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const result = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { result, resolve, reject };
}

afterEach(() => { vi.useRealTimers(); vi.resetAllMocks(); });

it("encodes a late snapshot and releases its hold before the same read is continued", async () => {
  vi.useFakeTimers();
  const serving = engine();
  const snapshot = deferred<Awaited<ReturnType<typeof readDocumentRevision>>>();
  vi.mocked(readDocumentRevision).mockReturnValue(snapshot.result);
  const firstReply = vi.fn();
  const first = serveRevisionRead(serving, address("&revision=revision-1"), firstReply);
  await vi.advanceTimersByTimeAsync(5_000);
  await first;
  expect(firstReply).toHaveBeenCalledWith(503, { error: "history_unavailable", reason: "downloading", uuid: UUID,
    revision: "revision-1", readId: expect.any(String) });
  const readId = firstReply.mock.calls[0]![1].readId as string;

  const againReply = vi.fn();
  const again = serveRevisionRead(serving, address(`&revision=revision-1&readId=${readId}`), againReply);
  await vi.advanceTimersByTimeAsync(5_000);
  await again;
  expect(againReply.mock.calls[0]![1].readId).toBe(readId);
  expect(readDocumentRevision).toHaveBeenCalledExactlyOnceWith(serving.replicas, UUID, "revision-1", { timeoutMs: 120_000 });

  const doc = new Y.Doc();
  initDoc(doc, { uuid: UUID, title: "Downloaded outside retention" });
  const destroyed = vi.fn();
  doc.once("destroy", destroyed);
  snapshot.resolve({ doc, history });
  await vi.advanceTimersByTimeAsync(0);
  expect(destroyed).toHaveBeenCalledOnce();
  const finalReply = vi.fn();
  await serveRevisionRead(serving, address(`&revision=revision-1&readId=${readId}`), finalReply);
  expect(readDocumentRevision).toHaveBeenCalledOnce();
  const body = finalReply.mock.calls[0]![1] as { state: string; history: HistoryReadStatus };
  expect(finalReply.mock.calls[0]![0]).toBe(200);
  expect(body.history).toEqual(history);
  const decoded = new Y.Doc();
  try { Y.applyUpdate(decoded, Buffer.from(body.state, "base64")); expect(getMeta(decoded).title).toBe("Downloaded outside retention"); }
  finally { decoded.destroy(); }
});

it("continues an explicit refresh without repeating the completed hub operation", async () => {
  vi.useFakeTimers();
  const serving = engine();
  const catalog = deferred<Awaited<ReturnType<typeof readDocumentHistory>>>();
  vi.mocked(readDocumentHistory).mockReturnValue(catalog.result);
  const firstReply = vi.fn();
  const first = serveRevisionRead(serving, address("&refresh=true"), firstReply);
  await vi.advanceTimersByTimeAsync(5_000);
  await first;
  const readId = firstReply.mock.calls[0]![1].readId as string;
  catalog.resolve({ revisions: [], history });
  await vi.advanceTimersByTimeAsync(0);
  const reply = vi.fn();
  await serveRevisionRead(serving, address(`&refresh=true&readId=${readId}`), reply);
  expect(reply).toHaveBeenCalledWith(200, { revisions: [], history });
  expect(readDocumentHistory).toHaveBeenCalledExactlyOnceWith(serving.replicas, UUID, { refresh: true, timeoutMs: 120_000 });
});

it("starts a new explicit refresh after older foreground reads finish", async () => {
  vi.useFakeTimers();
  const serving = engine();
  const older = deferred<Awaited<ReturnType<typeof readDocumentHistory>>>();
  vi.mocked(readDocumentHistory).mockReturnValueOnce(older.result).mockResolvedValueOnce({ revisions: [], history });
  const olderRead = serveRevisionRead(serving, address(), vi.fn());
  await vi.advanceTimersByTimeAsync(5_000);
  await olderRead;
  const newerReply = vi.fn();
  const newerRead = serveRevisionRead(serving, address("&refresh=true"), newerReply);
  expect(readDocumentHistory).toHaveBeenCalledOnce();
  older.resolve({ revisions: [], history: { ...history, lastRefresh: null } });
  await newerRead;
  expect(readDocumentHistory).toHaveBeenLastCalledWith(serving.replicas, UUID, { refresh: true, timeoutMs: 120_000 });
  expect(newerReply).toHaveBeenCalledWith(200, { revisions: [], history });
});

it("restricts a continuation to its engine, document, revision and refresh operation and expires completed results", async () => {
  vi.useFakeTimers();
  const serving = engine();
  const catalog = deferred<Awaited<ReturnType<typeof readDocumentHistory>>>();
  vi.mocked(readDocumentHistory).mockReturnValue(catalog.result);
  const firstReply = vi.fn();
  const first = serveRevisionRead(serving, address(), firstReply);
  await vi.advanceTimersByTimeAsync(5_000);
  await first;
  const readId = firstReply.mock.calls[0]![1].readId as string;
  for (const target of [address(`&revision=revision-1&readId=${readId}`), address(`&refresh=true&readId=${readId}`),
    new URL(`http://localhost/api/revisions?uuid=${OTHER_UUID}&readId=${readId}`)]) {
    const refused = vi.fn();
    await serveRevisionRead(serving, target, refused);
    expect(refused).toHaveBeenCalledWith(400, { error: "invalid_history_read" });
  }
  const otherEngine = vi.fn();
  await serveRevisionRead(engine(), address(`&readId=${readId}`), otherEngine);
  expect(otherEngine).toHaveBeenCalledWith(400, { error: "invalid_history_read" });
  expect(readDocumentHistory).toHaveBeenCalledOnce();
  catalog.resolve({ revisions: [], history });
  await vi.advanceTimersByTimeAsync(60_000);
  const expired = vi.fn();
  await serveRevisionRead(serving, address(`&readId=${readId}`), expired);
  expect(expired).toHaveBeenCalledWith(400, { error: "invalid_history_read" });
});

it("returns a late read failure through the original continuation", async () => {
  vi.useFakeTimers();
  const serving = engine();
  const snapshot = deferred<Awaited<ReturnType<typeof readDocumentRevision>>>();
  vi.mocked(readDocumentRevision).mockReturnValue(snapshot.result);
  const firstReply = vi.fn();
  const first = serveRevisionRead(serving, address("&revision=revision-1"), firstReply);
  await vi.advanceTimersByTimeAsync(5_000);
  await first;
  const readId = firstReply.mock.calls[0]![1].readId as string;
  snapshot.reject(new RevisionClientError("not-downloaded", { uuid: UUID, revision: "revision-1", history: { ...history, offline: true } }));
  await vi.advanceTimersByTimeAsync(0);
  const reply = vi.fn();
  await serveRevisionRead(serving, address(`&revision=revision-1&readId=${readId}`), reply);
  expect(reply).toHaveBeenCalledWith(503, { error: "history_unavailable", reason: "not-downloaded", uuid: UUID,
    revision: "revision-1", history: { ...history, offline: true } });
});

it.each(["deleted", "decision-no-history", "local-only", "detached", "removed"] as const)(
  "refuses a completed continuation after its document becomes %s", async failure => {
    vi.useFakeTimers();
    const serving = engine();
    const catalog = deferred<Awaited<ReturnType<typeof readDocumentHistory>>>();
    vi.mocked(readDocumentHistory).mockReturnValue(catalog.result);
    const firstReply = vi.fn();
    const first = serveRevisionRead(serving, address(), firstReply);
    await vi.advanceTimersByTimeAsync(5_000);
    await first;
    const readId = firstReply.mock.calls[0]![1].readId as string;
    catalog.resolve({ revisions: [], history });
    await vi.advanceTimersByTimeAsync(0);
    if (failure === "local-only") serving.replicas.config.localWorkspace = true;
    else if (failure === "detached" || failure === "removed") {
      vi.mocked(serving.replicas.store.assertWorkspacePresent).mockImplementation(() => {
        throw failure === "detached" ? new WorkspaceDetachedError() : new WorkspaceRemovedError();
      });
    } else vi.mocked(requireDocumentHistory).mockImplementation(() => {
      throw new RevisionClientError(failure, { uuid: UUID });
    });
    const reply = vi.fn();
    await serveRevisionRead(serving, address(`&readId=${readId}`), reply);
    expect(reply).toHaveBeenCalledWith(503, expect.objectContaining({ error: "history_unavailable",
      reason: failure === "detached" || failure === "removed" ? "unreachable" : failure,
      ...(failure === "detached" || failure === "removed" ? { cause: "cache-superseded" } : {}) }));
    expect(readDocumentHistory).toHaveBeenCalledOnce();
  },
);

it("keeps a completed cached read available without sign-in or a connected hub", async () => {
  vi.useFakeTimers();
  const serving = engine();
  const connected = vi.fn(() => { throw new Error("A cached read must not require the hub."); });
  Object.assign(serving.replicas, { sync: { state: connected } });
  const catalog = deferred<Awaited<ReturnType<typeof readDocumentHistory>>>();
  vi.mocked(readDocumentHistory).mockReturnValue(catalog.result);
  const firstReply = vi.fn();
  const first = serveRevisionRead(serving, address(), firstReply);
  await vi.advanceTimersByTimeAsync(5_000);
  await first;
  const readId = firstReply.mock.calls[0]![1].readId as string;
  catalog.resolve({ revisions: [], history: { ...history, offline: true } });
  await vi.advanceTimersByTimeAsync(0);
  const reply = vi.fn();
  await serveRevisionRead(serving, address(`&readId=${readId}`), reply);
  expect(reply).toHaveBeenCalledWith(200, { revisions: [], history: { ...history, offline: true } });
  expect(connected).not.toHaveBeenCalled();
});
