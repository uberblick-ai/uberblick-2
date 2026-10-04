/** The browser trusts only a validated local status answer. */

import { describe, expect, it, vi } from "vitest";
import { createDocumentSearchClient } from "../src/shell/document-search.js";

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
});
