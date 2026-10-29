import type { RevisionEntry, RevisionRequest, RevisionResponse } from "@uberblick/schema";
import { afterEach, expect, it, vi } from "vitest";
import type { CachedHistoryCatalog, HistoryCacheResult, HistoryCacheStamp, HistoryCacheToken } from "../src/history-cache.js";
import { downloadHistorySnapshot, HistoryMirror, revalidateHistoryCatalog, type HistoryMirrorPage, type HistoryMirrorSource, type MirrorCache } from "../src/history-mirror.js";
import { selectHistorySnapshots } from "../src/history-retention.js";
import type { HistoryRetention } from "../src/local-settings.js";

const CHECKSUM = "a".repeat(64);
const STAMP = { hub: "wss://history.example.test/ws", workspace: "workspace", account: "123" };
const TOKEN = { ...STAMP, generation: "generation" };
type Operation = Omit<RevisionRequest, "requestId">;
type Call = { room: string; operation: Operation };
const mirrors: HistoryMirror[] = [];
const releaseReplies: (() => void)[] = [];

afterEach(async () => {
  for (const release of releaseReplies.splice(0)) release();
  await vi.advanceTimersByTimeAsync(20);
  for (const mirror of mirrors.splice(0)) await mirror.close();
  vi.useRealTimers();
});

function result<T>(value: T): HistoryCacheResult<T> { return { status: "ready", value }; }
function revision(id: string, extra: Partial<RevisionEntry> = {}): RevisionEntry {
  return { id, author: null, startedAt: 1, endedAt: 2, final: true, checksum: CHECKSUM, ...extra };
}
function listed(revisions: RevisionEntry[], version = "version-one"): RevisionResponse {
  return { requestId: "request", ok: true, revisions, version };
}
function downloaded(id: string): RevisionResponse {
  return { requestId: "request", ok: true, revisionId: id, checksum: CHECKSUM, state: new Uint8Array([1]) };
}
function page(uuid: string, archived = false): HistoryMirrorPage {
  return { uuid, room: `workspace/${uuid}`, sequence: 1, archived };
}
function deferredReply() {
  let resolve: (response: RevisionResponse) => void = () => {};
  const promise = new Promise<RevisionResponse>(accept => { resolve = accept; });
  releaseReplies.push(() => resolve({ requestId: "request", ok: false, error: "unavailable" }));
  return { promise, resolve };
}

class Cache implements MirrorCache {
  readonly catalogs = new Map<string, CachedHistoryCatalog>();
  readonly snapshots = new Map<string, Map<string, string>>();
  readonly verification: boolean[] = [];
  private publication = 0;

  readonly open = vi.fn(async (_stamp: HistoryCacheStamp): Promise<HistoryCacheResult<HistoryCacheToken>> => result(TOKEN));
  readonly resume = vi.fn(async (): Promise<HistoryCacheResult<HistoryCacheToken | null>> => result(TOKEN));
  readonly readCatalog = vi.fn(async (uuid: string): Promise<HistoryCacheResult<CachedHistoryCatalog | null>> =>
    result(this.catalogs.get(uuid) ?? null));
  readonly listPages = vi.fn(async (): Promise<HistoryCacheResult<string[]>> => result([...this.catalogs.keys()]));
  readonly putCatalog = vi.fn(async (uuid: string, input: Omit<CachedHistoryCatalog, "catalog">): Promise<HistoryCacheResult<void>> => {
    this.catalogs.set(uuid, { ...input, catalog: String(this.publication++) });
    return result(undefined);
  });
  readonly markRefreshFailed = vi.fn(async (uuid: string): Promise<HistoryCacheResult<void>> => {
    const catalog = this.catalogs.get(uuid);
    if (catalog !== undefined) this.catalogs.set(uuid, { ...catalog, failed: true });
    return result(undefined);
  });
  readonly hasSnapshot = vi.fn(async (uuid: string, id: string, checksum: string): Promise<HistoryCacheResult<boolean>> =>
    result(this.snapshots.get(uuid)?.get(id) === checksum));
  readonly putVerifiedSnapshot = vi.fn(async (uuid: string, id: string, checksum: string,
    _state: Uint8Array): Promise<HistoryCacheResult<boolean>> => {
    const valid = this.verification.shift() ?? true;
    if (valid) {
      const snapshots = this.snapshots.get(uuid) ?? new Map<string, string>();
      snapshots.set(id, checksum);
      this.snapshots.set(uuid, snapshots);
    }
    return result(valid);
  });
  readonly evict = vi.fn(async (uuid: string, policy: HistoryRetention, now: number): Promise<HistoryCacheResult<void>> => {
    const catalog = this.catalogs.get(uuid);
    const snapshots = this.snapshots.get(uuid);
    if (catalog?.complete && snapshots !== undefined) {
      const keep = selectHistorySnapshots({ revisions: catalog.revisions, downloaded: new Set(snapshots.keys()) }, policy, now);
      for (const id of snapshots.keys()) if (!keep.has(id)) snapshots.delete(id);
    }
    return result(undefined);
  });
  readonly close = vi.fn(async (): Promise<void> => {});

  seed(uuid: string, revisions: RevisionEntry[]): void {
    this.catalogs.set(uuid, { revisions, version: "version-one", refreshedAt: 1, complete: true, failed: false, catalog: "seed" });
    this.snapshots.set(uuid, new Map(revisions.map(entry => [entry.id, entry.checksum ?? ""])));
  }
}

function fixture(initialPages = [page("live")]) {
  vi.useFakeTimers();
  vi.setSystemTime(100_000);
  const cache = new Cache();
  const state = {
    pages: initialPages,
    retention: { mode: "everything" } as HistoryRetention,
    ready: true,
    stamp: STAMP as HistoryCacheStamp | null,
    reply: async (_room: string, operation: Operation): Promise<RevisionResponse> => operation.operation === "list"
      ? listed([revision("closed")]) : downloaded(operation.revisionId ?? ""),
  };
  const calls: Call[] = [];
  let activeRequests = 0;
  let maximumRequests = 0;
  const source: HistoryMirrorSource = {
    pages: () => state.pages,
    retention: () => state.retention,
    stamp: () => state.stamp,
    ready: () => state.ready,
    now: () => Date.now(),
    deadlineDelay: deadline => deadline - Date.now(),
    request: async (room, operation) => {
      calls.push({ room, operation });
      activeRequests++;
      maximumRequests = Math.max(maximumRequests, activeRequests);
      try { return await state.reply(room, operation); }
      finally { activeRequests--; }
    },
  };
  const mirror = new HistoryMirror(source, cache);
  mirrors.push(mirror);
  const start = () => { mirror.refresh(); mirror.connectionChanged(true); };
  return { cache, state, calls, mirror, start, maximumRequests: () => maximumRequests };
}

async function flush(): Promise<void> { await vi.advanceTimersByTimeAsync(10); }
function operations(calls: Call[]): string[] {
  return calls.map(call => `${call.room}:${call.operation.operation}${call.operation.revisionId === undefined ? "" : `:${call.operation.revisionId}`}`);
}

it("rereads competing catalog and snapshot publications instead of refusing a successful download", async () => {
  const test = fixture();
  test.cache.putCatalog.mockImplementationOnce(async () => {
    test.cache.seed("live", [revision("winner")]);
    return { status: "superseded" };
  });
  const catalog = await revalidateHistoryCatalog(test.cache, "live", async () => listed([revision("loser")]), () => Date.now());
  expect(catalog.revisions.map(entry => entry.id)).toEqual(["winner"]);
  expect(test.cache.markRefreshFailed).not.toHaveBeenCalled();

  test.cache.snapshots.delete("live");
  test.cache.putVerifiedSnapshot.mockImplementationOnce(async () => {
    test.cache.snapshots.set("live", new Map([["winner", CHECKSUM]]));
    return { status: "superseded" };
  });
  expect(await downloadHistorySnapshot(test.cache, "live", revision("winner"), async () => downloaded("winner"))).toBe(true);

  test.cache.snapshots.delete("live");
  test.cache.putVerifiedSnapshot.mockResolvedValueOnce({ status: "superseded" });
  expect(await downloadHistorySnapshot(test.cache, "live", revision("winner"), async () => downloaded("winner"))).toBe(false);
});

it("bootstraps every held live regular page and skips pages first encountered archived", async () => {
  const test = fixture([page("unopened-a"), page("unopened-b"), page("archived", true)]);
  test.start();
  await flush();
  expect(operations(test.calls)).toEqual([
    "workspace/unopened-a:list", "workspace/unopened-a:get:closed",
    "workspace/unopened-b:list", "workspace/unopened-b:get:closed",
  ]);
  for (const uuid of ["unopened-a", "unopened-b"]) {
    expect(test.cache.catalogs.get(uuid)).toMatchObject({ complete: true, failed: false });
    expect(test.cache.snapshots.get(uuid)?.has("closed")).toBe(true);
  }
  expect(test.cache.catalogs.has("archived")).toBe(false);
});

it("coalesces notices and revalidates an unchanged catalog with one conditional request and no download", async () => {
  const test = fixture();
  test.start();
  await flush();
  test.calls.length = 0;
  test.state.reply = async () => ({ requestId: "request", ok: true, unchanged: true, version: "version-one" });
  for (let count = 0; count < 20; count++) test.mirror.notice("workspace/live");
  test.mirror.refresh();
  await flush();
  expect(test.calls).toEqual([{ room: "workspace/live", operation: {
    operation: "list", includeNames: true, includeTitles: true, ifVersion: "version-one",
  } }]);
  expect(test.cache.putVerifiedSnapshot).toHaveBeenCalledTimes(1);
});

it("evicts only the triggered page while edits and notices arrive, including while live sync is busy", async () => {
  const test = fixture([page("live"), page("other")]);
  test.cache.seed("archived", [revision("closed")]);
  test.cache.seed("orphan", [revision("closed")]);
  test.start();
  await flush();
  test.cache.listPages.mockClear();
  test.cache.evict.mockClear();
  test.calls.length = 0;
  test.state.ready = false;
  test.state.pages = [{ ...page("live"), sequence: 2 }, page("other")];
  test.mirror.refresh();
  test.mirror.notice("workspace/live");
  await flush();
  expect(test.calls).toEqual([]);
  expect(test.cache.listPages).not.toHaveBeenCalled();
  expect(test.cache.evict).not.toHaveBeenCalled();
  test.state.ready = true;
  test.mirror.refresh();
  await flush();
  for (let count = 0; count < 3; count++) {
    test.state.pages = [{ ...page("live"), sequence: 3 + count }, test.state.pages[1]!];
    test.mirror.refresh();
    test.mirror.notice("workspace/live");
    await flush();
  }
  expect(operations(test.calls)).toEqual(Array(4).fill("workspace/live:list"));
  expect(test.cache.listPages).not.toHaveBeenCalled();
  expect(test.cache.evict.mock.calls.map(call => call[0])).toEqual(Array(4).fill("live"));
});

it("waits behind live sync and permits only one request or download at a time", async () => {
  const test = fixture([page("a"), page("b")]);
  const firstDownload = deferredReply();
  test.state.ready = false;
  test.state.reply = async (room, operation) => {
    if (operation.operation === "list") return listed([revision("closed")]);
    return room === "workspace/a" ? firstDownload.promise : downloaded("closed");
  };
  test.start();
  await flush();
  expect(test.calls).toEqual([]);
  test.state.ready = true;
  test.mirror.refresh();
  await flush();
  expect(operations(test.calls)).toEqual(["workspace/a:list", "workspace/a:get:closed"]);
  expect(test.cache.catalogs.get("a")?.complete).toBe(true);
  expect(test.cache.snapshots.get("a")).toBeUndefined();
  firstDownload.resolve(downloaded("closed"));
  await flush();
  expect(operations(test.calls)).toEqual([
    "workspace/a:list", "workspace/a:get:closed", "workspace/b:list", "workspace/b:get:closed",
  ]);
  expect(test.maximumRequests()).toBe(1);
});

it("uses one deadline timer to revalidate and download a closing head without periodic requests", async () => {
  const test = fixture();
  const deadline = Date.now() + 1_000;
  test.state.reply = async (_room, operation) => {
    if (operation.operation === "get") return downloaded("head");
    return Date.now() < deadline
      ? listed([revision("head", { final: false, endedAt: null, deadlineAt: deadline })])
      : listed([revision("head")], "version-two");
  };
  test.start();
  await flush();
  expect(operations(test.calls)).toEqual(["workspace/live:list"]);
  expect(vi.getTimerCount()).toBe(1);
  await vi.advanceTimersByTimeAsync(989);
  expect(test.calls).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(11);
  await flush();
  expect(operations(test.calls)).toEqual(["workspace/live:list", "workspace/live:list", "workspace/live:get:head"]);
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(test.calls).toHaveLength(3);
});

it("finishes a tracked page's head when it is archived and keeps the previously cached history", async () => {
  const test = fixture();
  test.state.reply = async (_room, operation) => operation.operation === "list"
    ? listed([revision("head", { final: false, endedAt: null, deadlineAt: Date.now() + 1_000 }), revision("closed")])
    : downloaded(operation.revisionId ?? "");
  test.start();
  await flush();
  expect(test.cache.snapshots.get("live")?.has("closed")).toBe(true);
  expect(test.cache.snapshots.get("live")?.has("head")).toBe(false);
  test.state.pages = [{ ...page("live", true), sequence: 2 }];
  test.state.reply = async (_room, operation) => operation.operation === "list"
    ? listed([revision("head"), revision("closed")], "archived-version") : downloaded(operation.revisionId ?? "");
  test.mirror.refresh();
  await flush();
  expect([...test.cache.snapshots.get("live")?.keys() ?? []]).toEqual(["closed", "head"]);
  expect(test.calls.filter(call => call.operation.operation === "get").map(call => call.operation.revisionId)).toEqual(["closed", "head"]);
  expect(vi.getTimerCount()).toBe(0);
});

it("does not repeatedly poll a deadline that the hub still reports open", async () => {
  const test = fixture();
  let deadline = Date.now() + 100;
  test.state.reply = async () => listed([revision("head", { final: false, endedAt: null, deadlineAt: deadline })]);
  test.start();
  await vi.advanceTimersByTimeAsync(1_000);
  expect(operations(test.calls)).toEqual(["workspace/live:list", "workspace/live:list"]);
  expect(vi.getTimerCount()).toBe(0);
  test.mirror.notice("workspace/live");
  await flush();
  expect(test.calls).toHaveLength(3);
  expect(vi.getTimerCount()).toBe(0);
  deadline = Date.now() + 100;
  test.mirror.notice("workspace/live");
  await vi.advanceTimersByTimeAsync(1_000);
  expect(test.calls).toHaveLength(5);
  expect(vi.getTimerCount()).toBe(0);
});

it("retries a persistent checksum mismatch once across edits, notices and deadlines while filling other snapshots", async () => {
  const test = fixture();
  const deadline = Date.now() + 100;
  test.state.reply = async (_room, operation) => operation.operation === "list"
    ? listed([revision("head", { final: false, endedAt: null, deadlineAt: deadline }), revision("closed"), revision("other")])
    : downloaded(operation.revisionId ?? "");
  test.cache.verification.push(false, false);
  test.start();
  await flush();
  expect(operations(test.calls)).toEqual([
    "workspace/live:list", "workspace/live:get:closed", "workspace/live:list", "workspace/live:get:closed",
    "workspace/live:get:other",
  ]);
  expect(test.cache.catalogs.get("live")).toMatchObject({ complete: true, failed: true });
  expect([...test.cache.snapshots.get("live")?.keys() ?? []]).toEqual(["other"]);
  for (let count = 0; count < 6; count++) {
    test.state.pages = [{ ...page("live"), sequence: 2 + count }];
    test.mirror.refresh();
    test.mirror.notice("workspace/live");
    await flush();
  }
  await vi.advanceTimersByTimeAsync(60_000);
  expect(test.calls.filter(call => call.operation.operation === "list")).toHaveLength(9);
  expect(test.calls.filter(call => call.operation.operation === "get")).toHaveLength(3);
  expect(test.cache.catalogs.get("live")).toMatchObject({ complete: true, failed: true });
  test.mirror.connectionChanged(false);
  test.mirror.connectionChanged(true);
  await flush();
  expect(test.calls.filter(call => call.operation.operation === "get")).toHaveLength(4);
  expect(test.cache.snapshots.get("live")?.has("closed")).toBe(true);
  expect(test.cache.catalogs.get("live")?.failed).toBe(false);
});

it("gives a changed checksum its own revalidation and retry, even when the change arrives during recovery", async () => {
  const test = fixture();
  const checksums = [CHECKSUM, "b".repeat(64), "c".repeat(64)];
  let checksum = checksums[0]!;
  let lists = 0;
  test.state.reply = async (_room, operation) => {
    if (operation.operation === "list") {
      if (++lists === 2) checksum = checksums[1]!;
      return listed([revision("closed", { checksum })], checksum);
    }
    return { ...downloaded("closed"), checksum };
  };
  test.cache.putVerifiedSnapshot.mockResolvedValue(result(false));
  test.start();
  await flush();
  expect(test.calls.filter(call => call.operation.operation === "get")).toHaveLength(3);
  expect(test.cache.putVerifiedSnapshot.mock.calls.map(call => call[2])).toEqual([
    checksums[0], checksums[1], checksums[1],
  ]);
  test.mirror.notice("workspace/live");
  await flush();
  expect(test.calls.filter(call => call.operation.operation === "get")).toHaveLength(3);
  checksum = checksums[2]!;
  test.mirror.notice("workspace/live");
  await flush();
  expect(test.cache.putVerifiedSnapshot.mock.calls.map(call => call[2])).toEqual([
    checksums[0], checksums[1], checksums[1], checksums[2], checksums[2],
  ]);
  expect(test.cache.catalogs.get("live")?.failed).toBe(true);
});

it("does not carry failed checksums into another account's cache stamp", async () => {
  const test = fixture();
  test.cache.verification.push(false, false);
  test.start();
  await flush();
  expect(test.calls.filter(call => call.operation.operation === "get")).toHaveLength(2);
  test.state.stamp = { ...STAMP, account: "456" };
  test.state.pages = [{ ...page("live"), sequence: 2 }];
  test.mirror.refresh();
  await flush();
  expect(test.cache.open).toHaveBeenLastCalledWith(test.state.stamp);
  expect(test.calls.filter(call => call.operation.operation === "get")).toHaveLength(3);
  expect(test.cache.snapshots.get("live")?.has("closed")).toBe(true);
});

it("discards a failed verification superseded by reconnect before granting the new connection its retry", async () => {
  const test = fixture();
  let finishVerification: (value: HistoryCacheResult<boolean>) => void = () => {};
  const verification = new Promise<HistoryCacheResult<boolean>>(resolve => { finishVerification = resolve; });
  releaseReplies.push(() => finishVerification(result(false)));
  test.cache.putVerifiedSnapshot.mockImplementationOnce(() => verification).mockResolvedValue(result(false));
  test.start();
  await flush();
  expect(test.calls.filter(call => call.operation.operation === "get")).toHaveLength(1);
  test.mirror.connectionChanged(false);
  test.mirror.connectionChanged(true);
  finishVerification(result(false));
  await flush();
  expect(test.calls.filter(call => call.operation.operation === "get")).toHaveLength(3);
  test.mirror.notice("workspace/live");
  await flush();
  expect(test.calls.filter(call => call.operation.operation === "get")).toHaveLength(3);
  expect(test.cache.catalogs.get("live")?.failed).toBe(true);
});

it("replaces reverted or backup-restored catalogs and evicts removed ids without redownloading closed snapshots", async () => {
  const test = fixture();
  test.state.reply = async (_room, operation) => operation.operation === "list"
    ? listed([revision("removed-head"), revision("retained")]) : downloaded(operation.revisionId ?? "");
  test.start();
  await flush();
  test.calls.length = 0;
  test.state.reply = async () => listed([revision("retained")], "restored-version");
  test.mirror.notice("workspace/live");
  await flush();
  expect(operations(test.calls)).toEqual(["workspace/live:list"]);
  expect(test.cache.catalogs.get("live")?.revisions.map(entry => entry.id)).toEqual(["retained"]);
  expect([...test.cache.snapshots.get("live")?.keys() ?? []]).toEqual(["retained"]);
});

it("evicts archived and orphan caches on policy reduction and fills only live pages after an increase", async () => {
  const test = fixture([page("live"), page("archived", true)]);
  const revisions = [revision("newest"), revision("previous"), revision("older")];
  test.cache.seed("archived", revisions);
  test.cache.seed("orphan", revisions);
  test.state.reply = async (_room, operation) => operation.operation === "list"
    ? listed(revisions) : downloaded(operation.revisionId ?? "");
  test.start();
  await flush();
  test.calls.length = 0;
  test.state.retention = { mode: "named" };
  test.mirror.checkRetention();
  await flush();
  for (const uuid of ["live", "archived", "orphan"]) {
    expect([...test.cache.snapshots.get(uuid)?.keys() ?? []]).toEqual(["newest", "previous"]);
  }
  expect(operations(test.calls)).toEqual(["workspace/live:list"]);
  test.calls.length = 0;
  test.state.retention = { mode: "everything" };
  test.mirror.checkRetention();
  await flush();
  expect(operations(test.calls)).toEqual(["workspace/live:list", "workspace/live:get:older"]);
  expect(test.cache.snapshots.get("archived")?.has("older")).toBe(false);
  expect(test.cache.snapshots.get("orphan")?.has("older")).toBe(false);
});

it("stops on forbidden replies until reconnect while preserving downloaded history", async () => {
  const test = fixture();
  test.cache.seed("live", [revision("closed")]);
  test.state.reply = async () => ({ requestId: "request", ok: false, error: "forbidden" });
  test.start();
  await flush();
  expect(test.cache.catalogs.get("live")).toMatchObject({ complete: true, failed: true });
  expect(test.cache.snapshots.get("live")?.has("closed")).toBe(true);
  test.state.pages = [page("live")];
  test.state.pages[0]!.sequence++;
  test.mirror.refresh();
  test.mirror.notice("workspace/live");
  await vi.advanceTimersByTimeAsync(60_000);
  expect(test.calls).toHaveLength(1);
  test.state.reply = async () => listed([revision("closed")]);
  test.mirror.connectionChanged(false);
  test.mirror.connectionChanged(true);
  await flush();
  expect(operations(test.calls)).toEqual(["workspace/live:list", "workspace/live:list"]);
  expect(test.cache.catalogs.get("live")?.failed).toBe(false);
});

it("resumes after a reconnect that supersedes an in-flight response", async () => {
  const test = fixture();
  const oldConnection = deferredReply();
  test.state.reply = async () => oldConnection.promise;
  test.start();
  await flush();
  expect(test.calls).toHaveLength(1);
  test.mirror.connectionChanged(false);
  test.state.reply = async (_room, operation) => operation.operation === "list"
    ? listed([revision("closed")]) : downloaded("closed");
  test.mirror.connectionChanged(true);
  oldConnection.resolve(listed([revision("stale-connection-revision")]));
  await flush();
  expect(operations(test.calls)).toEqual(["workspace/live:list", "workspace/live:list", "workspace/live:get:closed"]);
  expect(test.cache.catalogs.get("live")?.revisions.map(entry => entry.id)).toEqual(["closed"]);
});

it("preserves a complete catalog after refresh failure and retries only on another trigger", async () => {
  const test = fixture();
  test.cache.seed("live", [revision("closed")]);
  test.state.reply = async () => ({ requestId: "request", ok: false, error: "unavailable" });
  test.start();
  await flush();
  expect(test.cache.catalogs.get("live")).toMatchObject({ revisions: [revision("closed")], version: "version-one", complete: true, failed: true });
  expect(test.cache.snapshots.get("live")?.has("closed")).toBe(true);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(test.calls).toHaveLength(1);
  test.state.reply = async () => listed([revision("closed")]);
  test.mirror.notice("workspace/live");
  await flush();
  expect(test.calls).toHaveLength(2);
  expect(test.cache.catalogs.get("live")?.failed).toBe(false);
});

it("records an initial failed refresh without claiming a complete catalog", async () => {
  const test = fixture();
  test.state.reply = async () => ({ requestId: "request", ok: false, error: "unavailable" });
  test.start();
  await flush();
  expect(test.cache.catalogs.get("live")).toMatchObject({ revisions: [], version: null, refreshedAt: null, complete: false, failed: true });
  await vi.advanceTimersByTimeAsync(60_000);
  expect(test.calls).toHaveLength(1);
});

it.each([
  { name: "a disabled hub", response: { requestId: "request", ok: false, error: "unsupported" } as RevisionResponse },
  { name: "a legacy catalog", response: { requestId: "request", ok: true,
    revisions: [{ id: "legacy", author: null, startedAt: 1, endedAt: 2 }] } as RevisionResponse },
  { name: "a catalog without a version", response: { requestId: "request", ok: true,
    revisions: [revision("closed")] } as RevisionResponse },
  { name: "a versioned legacy catalog", response: { requestId: "request", ok: true, version: "legacy",
    revisions: [{ id: "legacy", author: null, startedAt: 1, endedAt: 2 }] } as RevisionResponse },
])("suspends unsupported mirroring for $name until reconnect", async ({ response }) => {
  const test = fixture();
  test.state.reply = async () => response;
  test.start();
  await flush();
  test.mirror.notice("workspace/live");
  test.state.pages = [{ ...page("live"), sequence: 2 }];
  test.mirror.refresh();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(operations(test.calls)).toEqual(["workspace/live:list"]);
  expect(test.cache.putVerifiedSnapshot).not.toHaveBeenCalled();
  test.state.reply = async (_room, operation) => operation.operation === "list"
    ? listed([revision("closed")]) : downloaded("closed");
  test.mirror.connectionChanged(false);
  test.mirror.connectionChanged(true);
  await flush();
  expect(operations(test.calls)).toEqual(["workspace/live:list", "workspace/live:list", "workspace/live:get:closed"]);
});

it("enforces cached retention when no current sign-in stamp is available", async () => {
  const test = fixture([]);
  test.cache.seed("archived", [revision("newest"), revision("previous"), revision("older")]);
  test.state.stamp = null;
  test.state.retention = { mode: "named" };
  test.mirror.refresh();
  await flush();
  expect(test.calls).toEqual([]);
  expect(test.cache.resume).toHaveBeenCalledTimes(1);
  expect([...test.cache.snapshots.get("archived")?.keys() ?? []]).toEqual(["newest", "previous"]);
});

it("applies a retention reduction queued during network work even if the connection then goes offline", async () => {
  const test = fixture();
  test.cache.seed("archived", [revision("newest"), revision("previous"), revision("older")]);
  const inFlight = deferredReply();
  test.state.reply = async (_room, operation) => operation.operation === "list"
    ? listed([revision("closed")]) : inFlight.promise;
  test.start();
  await flush();
  expect(operations(test.calls)).toEqual(["workspace/live:list", "workspace/live:get:closed"]);
  test.state.retention = { mode: "named" };
  test.mirror.checkRetention();
  test.mirror.connectionChanged(false);
  inFlight.resolve(downloaded("closed"));
  await flush();
  expect([...test.cache.snapshots.get("archived")?.keys() ?? []]).toEqual(["newest", "previous"]);
  expect(test.calls).toHaveLength(2);
});

it("cancels deadline work and closes the cache while waiting for the current network operation", async () => {
  const test = fixture([page("head"), page("downloading")]);
  const pendingDownload = deferredReply();
  test.state.reply = async (room, operation) => {
    if (operation.operation === "get") return pendingDownload.promise;
    return room === "workspace/head"
      ? listed([revision("head", { final: false, endedAt: null, deadlineAt: Date.now() + 1_000 })])
      : listed([revision("closed")]);
  };
  test.start();
  await flush();
  expect(vi.getTimerCount()).toBe(1);
  let closed = false;
  const closing = test.mirror.close().then(() => { closed = true; });
  await flush();
  expect(closed).toBe(false);
  expect(test.cache.close).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
  pendingDownload.resolve(downloaded("closed"));
  await closing;
  expect(test.cache.close).toHaveBeenCalledTimes(1);
  expect(test.cache.putVerifiedSnapshot).not.toHaveBeenCalled();
  const requests = test.calls.length;
  test.mirror.notice("workspace/head");
  await vi.advanceTimersByTimeAsync(60_000);
  expect(test.calls).toHaveLength(requests);
});
