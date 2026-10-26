// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createAccountClient, createDeviceLoginClient } from "../src/shell/account.js";

vi.mock("../src/collab/rooms.js", () => ({
  mintHubAuthMessage: vi.fn(async () => "browser-key-proof"),
}));

function client(body: unknown, status = 200) {
  const fetchImpl = vi.fn(async () => new Response(JSON.stringify(body), {
    status, headers: { "Content-Type": "application/json" },
  }));
  return { read: createAccountClient("workspace", "presence-name", fetchImpl as typeof fetch), fetchImpl };
}

describe("the served account answer", () => {
  it("reads stored login state through its protected local route with the same safe projection", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ state: "signed-in", handle: "octocat", accountId: "1234", credential: "private", identity: "private" }));
    const read = createDeviceLoginClient("workspace", "presence-name", fetchImpl as typeof fetch);
    const signal = new AbortController().signal;
    await expect(read(signal)).resolves.toEqual({ state: "signed-in", handle: "octocat", accountId: "1234" });
    expect(fetchImpl).toHaveBeenCalledWith("/api/device-login", expect.objectContaining({
      cache: "no-store", redirect: "error", signal,
      headers: { Accept: "application/json", Authorization: "Bearer browser-key-proof" },
    }));
    fetchImpl.mockResolvedValueOnce(Response.json({ state: "unavailable", handle: "stale-person" }));
    await expect(read(signal)).resolves.toEqual({ state: "unavailable" });
    fetchImpl.mockResolvedValueOnce(Response.json({ state: "signed-in", handle: "bad handle" }));
    await expect(read(signal)).rejects.toThrow("Invalid account answer");
  });

  it("uses the browser proof and projects only the verified account and principal", async () => {
    const principalId = "5df99824-b9b5-4260-b20c-4680e2d51fac";
    const { read, fetchImpl } = client({ state: "signed-in", handle: "octocat", principalId, accountId: "1234", credential: "ignored", agent: "claude" });
    const signal = new AbortController().signal;
    await expect(read(signal)).resolves.toEqual({ state: "signed-in", handle: "octocat", principalId });
    expect(fetchImpl).toHaveBeenCalledWith("/api/account", expect.objectContaining({
      cache: "no-store", redirect: "error", signal,
      headers: { Accept: "application/json", Authorization: "Bearer browser-key-proof" },
    }));
  });

  it("accepts a legacy signed-in answer without a principal", async () => {
    await expect(client({ state: "signed-in", handle: "octocat" }).read(new AbortController().signal))
      .resolves.toEqual({ state: "signed-in", handle: "octocat" });
  });

  it.each([null, "octocat", "", 1234])("refuses an invalid verified principal %j", async (principalId) => {
    await expect(client({ state: "signed-in", handle: "octocat", principalId }).read(new AbortController().signal))
      .rejects.toThrow("Invalid account answer");
  });

  it.each([null, "", "0", "12x", 1234, "9007199254740992"])("refuses an invalid stored-login account id %j", async (accountId) => {
    const read = createDeviceLoginClient("workspace", "presence-name", async () =>
      Response.json({ state: "signed-in", handle: "octocat", accountId }));
    await expect(read(new AbortController().signal)).rejects.toThrow("Invalid account answer");
  });

  it.each(["signed-out", "unavailable"])("never retains a handle for %s", async (state) => {
    await expect(client({ state, handle: "octocat", principalId: "5df99824-b9b5-4260-b20c-4680e2d51fac" }).read(new AbortController().signal))
      .resolves.toEqual({ state });
  });

  it.each([null, [], {}, { state: "signed-in" }, { state: "signed-in", handle: "" },
    { state: "signed-in", handle: "loitering otter" }, { state: "signed-in", handle: "a".repeat(40) },
    { state: "unknown", handle: "octocat" }])("refuses malformed identity %j", async (body) => {
    await expect(client(body).read(new AbortController().signal)).rejects.toThrow("Invalid account answer");
  });

  it("does not trust a handle in a failed HTTP answer", async () => {
    await expect(client({ state: "signed-in", handle: "octocat" }, 401).read(new AbortController().signal))
      .rejects.toThrow("Account unavailable");
  });
});
