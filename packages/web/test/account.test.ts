// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createAccountClient } from "../src/shell/account.js";

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
  it("uses the browser proof and projects only a verified handle", async () => {
    const { read, fetchImpl } = client({ state: "signed-in", handle: "octocat", credential: "ignored" });
    const signal = new AbortController().signal;
    await expect(read(signal)).resolves.toEqual({ state: "signed-in", handle: "octocat" });
    expect(fetchImpl).toHaveBeenCalledWith("/api/account", expect.objectContaining({
      cache: "no-store", redirect: "error", signal,
      headers: { Accept: "application/json", Authorization: "Bearer browser-key-proof" },
    }));
  });

  it.each(["signed-out", "unavailable"])("never retains a handle for %s", async (state) => {
    await expect(client({ state, handle: "octocat" }).read(new AbortController().signal))
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
