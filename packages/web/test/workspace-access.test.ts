// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorkspaceAccessClient } from "../src/shell/workspace-access.js";
import type { AccessAction } from "../src/shell/workspace-access.js";

vi.mock("../src/collab/rooms.js", () => ({ mintHubAuthMessage: vi.fn(async () => "local-browser-proof") }));

const ADMIN = { principalId: "principal", githubAccountId: "1234", githubUsername: "person",
  workspaces: 0, lastSignedInAt: 1_790_000_000_000, current: true };
const WORKSPACE = { workspaceId: "5c974496-a04d-4b31-81da-8b70308565c7", name: "Project", members: 1, admins: ["person"] };

function reply(body: unknown) {
  const fetchImpl = vi.fn(async () => Response.json(body));
  vi.stubGlobal("fetch", fetchImpl);
  return { fetchImpl, request: (action: AccessAction) => createWorkspaceAccessClient(WORKSPACE.workspaceId, "presence")(action, new AbortController().signal) };
}

describe("the browser's hub management answers", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses the browser proof and exposes only the hub-admin inventory fields", async () => {
    const { request, fetchImpl } = reply({ status: "ok", hub: "https://bound.example", credential: "private",
      admins: [{ ...ADMIN, document: "private content" }] });
    await expect(request({ operation: "list-hub-admins" })).resolves.toEqual({ status: "ok", hub: "https://bound.example", admins: [ADMIN] });
    expect(fetchImpl).toHaveBeenCalledWith("/api/access", expect.objectContaining({ cache: "no-store", redirect: "error",
      headers: expect.objectContaining({ Authorization: "Bearer local-browser-proof" }), body: JSON.stringify({ operation: "list-hub-admins" }) }));
    await expect(reply({ status: "ok", workspaces: [{ ...WORKSPACE, documents: ["private content"] }] })
      .request({ operation: "list-hub-workspaces" })).resolves.toEqual({ status: "ok", hub: null, workspaces: [WORKSPACE] });
  });

  it("refusals discard stale hub-role and inventory claims", async () => {
    await expect(reply({ status: "forbidden", role: "admin", admins: [ADMIN] })
      .request({ operation: "own-hub-role" })).resolves.toEqual({ status: "forbidden", hub: null });
  });

  it.each([{ ...ADMIN, workspaces: -1 }, { ...ADMIN, lastSignedInAt: "never" },
    { ...ADMIN, current: undefined }, { ...ADMIN, principalId: undefined }])("refuses malformed administrator state %j", async (admin) => {
    await expect(reply({ status: "ok", admins: [admin] }).request({ operation: "list-hub-admins" })).rejects.toThrow("Invalid access answer");
  });

  it("refuses workspace contents that do not meet the display-name and count contract", async () => {
    for (const workspace of [{ ...WORKSPACE, name: "bad\nname" }, { ...WORKSPACE, members: 0.5 }, { ...WORKSPACE, admins: [null] }]) {
      await expect(reply({ status: "ok", workspaces: [workspace] }).request({ operation: "list-hub-workspaces" })).rejects.toThrow();
    }
  });
});
