// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorkspaceAccessClient } from "../src/shell/workspace-access.js";
import type { AccessAction } from "../src/shell/workspace-access.js";

vi.mock("../src/collab/rooms.js", () => ({ mintHubAuthMessage: vi.fn(async () => "local-browser-proof") }));

const ADMIN = { principalId: "principal", githubAccountId: "1234", githubUsername: "person",
  workspaces: 0, lastSignedInAt: 1_790_000_000_000, current: true };
const WORKSPACE = { workspaceId: "5c974496-a04d-4b31-81da-8b70308565c7", status: "active", name: "Project", members: 1, admins: ["person"] };

function reply(body: unknown) {
  const fetchImpl = vi.fn(async () => Response.json(body));
  vi.stubGlobal("fetch", fetchImpl);
  return { fetchImpl, request: (action: AccessAction) => createWorkspaceAccessClient(WORKSPACE.workspaceId, "presence")(action, new AbortController().signal) };
}

describe("the browser's hub management answers", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses the browser proof and exposes only the hub-admin inventory fields", async () => {
    const { request, fetchImpl } = reply({ status: "ok", hub: "https://bound.example", credential: "private",
      admins: [{ ...ADMIN, document: "private content" }], nextCursor: "next-admin" });
    await expect(request({ operation: "list-hub-admins" })).resolves.toEqual({ status: "ok", hub: "https://bound.example", admins: [ADMIN], nextCursor: "next-admin" });
    expect(fetchImpl).toHaveBeenCalledWith("/api/access", expect.objectContaining({ cache: "no-store", redirect: "error",
      headers: expect.objectContaining({ Authorization: "Bearer local-browser-proof" }), body: JSON.stringify({ operation: "list-hub-admins" }) }));
    await expect(reply({ status: "ok", workspaces: [{ ...WORKSPACE, documents: ["private content"] }], nextCursor: null })
      .request({ operation: "list-hub-workspaces", cursor: "next-workspace" })).resolves.toEqual({ status: "ok", hub: null, workspaces: [WORKSPACE], nextCursor: null });
  });

  it("refusals discard stale hub-role and inventory claims", async () => {
    await expect(reply({ status: "forbidden", role: "admin", admins: [ADMIN], nextCursor: "private" })
      .request({ operation: "own-hub-role" })).resolves.toEqual({ status: "forbidden", hub: null });
    await expect(reply({ status: "ok", role: "admin", nextCursor: "private" })
      .request({ operation: "own-hub-role" })).resolves.toEqual({ status: "ok", role: "admin", hub: null });
  });

  it.each([{ ...ADMIN, workspaces: -1 }, { ...ADMIN, lastSignedInAt: "never" },
    { ...ADMIN, current: undefined }, { ...ADMIN, principalId: undefined }])("refuses malformed administrator state %j", async (admin) => {
    await expect(reply({ status: "ok", admins: [admin], nextCursor: null }).request({ operation: "list-hub-admins" })).rejects.toThrow("Invalid access answer");
  });

  it.each([undefined, "", "a".repeat(161), 12])("refuses malformed pagination state %j", async (nextCursor) => {
    await expect(reply({ status: "ok", admins: [ADMIN], nextCursor })
      .request({ operation: "list-hub-admins" })).rejects.toThrow("Invalid access answer");
    await expect(reply({ status: "ok", workspaces: [WORKSPACE], nextCursor })
      .request({ operation: "list-hub-workspaces" })).rejects.toThrow("Invalid access answer");
  });

  it("refuses workspace contents that do not meet the display-name and count contract", async () => {
    for (const workspace of [{ ...WORKSPACE, name: "bad\nname" }, { ...WORKSPACE, members: 0.5 }, { ...WORKSPACE, admins: [null] },
      { ...WORKSPACE, status: undefined }, { ...WORKSPACE, status: "private" }]) {
      await expect(reply({ status: "ok", workspaces: [workspace], nextCursor: null }).request({ operation: "list-hub-workspaces" })).rejects.toThrow();
    }
  });

  it("validates the target and resulting state before projecting suspension changes", async () => {
    for (const [operation, workspaceStatus] of [["suspend-workspace", "suspended"], ["restore-workspace", "active"]] as const) {
      const action = { operation, workspaceId: WORKSPACE.workspaceId };
      await expect(reply({ status: "ok", workspaceId: WORKSPACE.workspaceId, workspaceStatus, key: "private" }).request(action))
        .resolves.toEqual({ status: "ok", hub: null, workspaceId: WORKSPACE.workspaceId, workspaceStatus });
      for (const body of [
        { status: "ok", workspaceId: "another-workspace", workspaceStatus },
        { status: "ok", workspaceId: WORKSPACE.workspaceId, workspaceStatus: workspaceStatus === "active" ? "suspended" : "active" },
        { status: "ok", workspaceId: WORKSPACE.workspaceId },
      ]) await expect(reply(body).request(action)).rejects.toThrow("Invalid access answer");
      await expect(reply({ status: "forbidden", workspaceId: WORKSPACE.workspaceId, workspaceStatus, key: "private" }).request(action))
        .resolves.toEqual({ status: "forbidden", hub: null });
    }
    await expect(reply({ status: "closure-failed", applied: true, message: "private" })
      .request({ operation: "suspend-workspace", workspaceId: WORKSPACE.workspaceId }))
      .resolves.toEqual({ status: "closure-failed", applied: true, hub: null });
  });
});
