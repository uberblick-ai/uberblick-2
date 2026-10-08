/** Lazy replica starts must remain owned when shutdown overtakes admission. */
import { createMcpEngine, type McpConfig, type UberblickMcpEngine } from "@uberblick/mcp-server";
import { describe, expect, it, vi } from "vitest";
import { BrowserReplicas, type ServedWorkspace } from "../src/open-workspaces.js";

vi.mock("@uberblick/mcp-server", async importOriginal => ({
  ...await importOriginal<typeof import("@uberblick/mcp-server")>(),
  createMcpEngine: vi.fn(),
}));

const FIRST = "3f6a1c20-9d84-4b1e-8a77-2c5e9b0d4411";
const SECOND = "5b2d7e10-4c33-4f92-9e08-71a6d3c85220";

function config(workspaceId: string): McpConfig {
  return {
    workspaceId,
    hubUrl: "ws://localhost:1234",
    authSecret: null,
    databasePath: "unused.sqlite",
    sessionId: "test-session",
    color: "#7b5ec7",
    connectTimeoutMs: 1_500,
    syncTimeoutMs: 3_000,
    reconnectMaxDelayMs: 2_000,
    cursorTtlMs: 30_000,
    compactAfter: 500,
    reconcileRetryMs: 5_000,
    updatedAtCoarsenessMs: 300_000,
  };
}

function destination(workspaceId: string): ServedWorkspace {
  return {
    workspace: workspaceId,
    browserKey: "unused-browser-key",
    binding: { workspaceId, hubUrl: null },
    config: config(workspaceId),
  };
}

function engine(workspaceId: string) {
  const unsubscribe = vi.fn();
  const close = vi.fn(async () => {});
  const onRefresh = vi.fn(() => unsubscribe);
  // This probe supplies only the lifecycle surface; integration tests exercise
  // the real engines' SQLite stores, serving locks and upstream connections.
  const value = {
    replicas: { config: config(workspaceId) },
    health: { status: "healthy" },
    refreshStatus: { status: "running" },
    onRefresh,
    close,
  } as unknown as UberblickMcpEngine;
  return { value, close, onRefresh, unsubscribe };
}

describe("browser replica lifecycle", () => {
  it("refuses an in-flight admission after shutdown starts and closes its late engine", async () => {
    const startup = engine(FIRST);
    const secondary = engine(SECOND);
    let complete!: (engine: UberblickMcpEngine) => void;
    const started = new Promise<UberblickMcpEngine>(resolve => { complete = resolve; });
    vi.mocked(createMcpEngine).mockReturnValueOnce(started);
    const replicas = new BrowserReplicas(new Map([
      [FIRST, destination(FIRST)],
      [SECOND, destination(SECOND)],
    ]), startup.value, vi.fn());

    const preparing = replicas.prepare(SECOND);
    const denied = expect(preparing).rejects.toMatchObject({ reason: "replica-failed" });
    const closing = replicas.close();
    complete(secondary.value);
    await Promise.all([denied, closing]);

    expect(startup.unsubscribe).toHaveBeenCalledOnce();
    expect(secondary.onRefresh).not.toHaveBeenCalled();
    expect(startup.close).toHaveBeenCalledOnce();
    expect(secondary.close).toHaveBeenCalledOnce();
    await expect(replicas.prepare(FIRST)).rejects.toMatchObject({ reason: "replica-failed" });
  });
});
