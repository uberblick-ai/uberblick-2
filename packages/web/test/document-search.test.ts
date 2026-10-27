// @vitest-environment node
/** The browser trusts only complete search results and validated status answers. */

import { describe, expect, it, vi } from "vitest";
import { createDocumentSearchClient } from "../src/shell/document-search.js";
import { mintHubAuthMessage } from "../src/collab/rooms.js";

vi.mock("../src/collab/rooms.js", () => ({
  mintHubAuthMessage: vi.fn(async () => "local-token"),
}));

function read(body: unknown) {
  const fetchImpl = vi.fn(async () => new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  }));
  return createDocumentSearchClient("workspace", "browser", fetchImpl as typeof fetch)
    .status(new AbortController().signal);
}

describe("local status answers", () => {
  it("keeps the explicit local-only cause and room acknowledgement", async () => {
    await expect(read({
      caughtUp: false,
      rooms: { "workspace/document": { hubAcked: false } },
      notSharedReason: "no-hub-credentials",
    })).resolves.toEqual({
      caughtUp: false,
      rooms: { "workspace/document": { hubAcked: false } },
      notSharedReason: "no-hub-credentials",
    });
  });

  it.each(["sign-in-required", "no-workspace-access", "credential-store", "renewal-unavailable"])(
    "keeps the remote device recovery %s without assuming any acknowledgement", async (notSharedReason) => {
      await expect(read({ caughtUp: false, rooms: {}, notSharedReason }))
        .resolves.toEqual({ caughtUp: false, rooms: {}, notSharedReason });
    },
  );

  it("accepts an older server without inventing a not-shared cause", async () => {
    await expect(read({ caughtUp: true, rooms: {} })).resolves.toEqual({
      caughtUp: true,
      rooms: {},
      notSharedReason: null,
    });
  });

  it("refuses an unknown or malformed cause rather than displaying a guess", async () => {
    for (const notSharedReason of ["unknown-reason", true, {}]) {
      await expect(read({ caughtUp: false, rooms: {}, notSharedReason }))
        .rejects.toThrow("malformed status answer");
    }
  });

  it.each(["replica-held", "replica-quarantined", "replica-failed"])(
    "retains a workspace-local unavailable reading: %s", async (reason) => {
      const fetchImpl = vi.fn(async () => Response.json({ error: "replica_unavailable", reason }, { status: 503 }));
      await expect(createDocumentSearchClient("workspace", "browser", fetchImpl as typeof fetch)
        .status(new AbortController().signal)).resolves.toEqual({
          caughtUp: false, rooms: {}, notSharedReason: null, replicaUnavailable: reason,
        });
    },
  );
});

describe("local search answers", () => {
  it("keeps every UUID in server order and authenticates each uncached request", async () => {
    const hits = Array.from({ length: 150 }, (_, index) => ({ uuid: `document-${149 - index}` }));
    const fetchImpl = vi.fn(async () => Response.json({ hits, capped: false }));
    const client = createDocumentSearchClient("workspace", "browser", fetchImpl as typeof fetch);
    const signal = new AbortController().signal;
    vi.mocked(mintHubAuthMessage).mockClear();
    await expect(client.search("sync & launch", signal)).resolves.toEqual(hits.map((hit) => hit.uuid));
    await client.search("sync", signal);
    expect(fetchImpl).toHaveBeenNthCalledWith(1, "/api/search?q=sync%20%26%20launch", {
      cache: "no-store", headers: { Accept: "application/json", Authorization: "Bearer local-token" }, signal,
    });
    expect(mintHubAuthMessage).toHaveBeenCalledTimes(2);
  });

  it.each([
    { hits: [{ uuid: "one" }], capped: true },
    { hits: [{ uuid: "one" }] },
    { hits: "one", capped: false },
    { hits: [null], capped: false },
    { hits: [{ uuid: 12 }], capped: false },
    { hits: [{ uuid: "" }], capped: false },
  ])("refuses incomplete or malformed results: %j", async (body) => {
    const fetchImpl = vi.fn(async () => Response.json(body));
    await expect(createDocumentSearchClient("workspace", "browser", fetchImpl as typeof fetch)
      .search("sync", new AbortController().signal)).rejects.toThrow(/search answer/);
  });

  it.each([404, 503])("does not treat unavailable search (%s) as zero matches", async (status) => {
    const fetchImpl = vi.fn(async () => Response.json({ error: "replica_unavailable", reason: "replica-held" }, { status }));
    await expect(createDocumentSearchClient("workspace", "browser", fetchImpl as typeof fetch)
      .search("sync", new AbortController().signal)).rejects.toThrow();
  });
});

describe("local update answers", () => {
  function update(body: unknown) {
    const fetchImpl = vi.fn(async () => Response.json(body));
    return createDocumentSearchClient("workspace", "browser", fetchImpl as typeof fetch)
      .update(new AbortController().signal);
  }

  it("keeps a complete offer", async () => {
    const offer = { current: "0.4.11", latest: "0.4.12", notesUrl: "https://github.com/uberblick-ai/uberblick-2/blob/main/CHANGELOG.md" };
    await expect(update({ update: offer })).resolves.toEqual(offer);
  });

  it("offers nothing for no update, an incomplete offer or a link that is not https", async () => {
    for (const body of [
      { update: null },
      {},
      { update: { current: "0.4.11", latest: "0.4.12" } },
      { update: { current: "0.4.11", latest: "0.4.12", notesUrl: "javascript:alert(1)" } },
    ]) {
      await expect(update(body)).resolves.toBeNull();
    }
  });
});
