import { expect, it } from "vitest";
import { createRevisionResponseReader, encodeRevisionRequest, encodeRevisionResponseFrames,
  readRevisionRequest, type RevisionResponse } from "../src/index.js";

it("accepts only bounded, addressed revision requests", () => {
  expect(readRevisionRequest(encodeRevisionRequest({ requestId: "one", operation: "get", revisionId: "revision" })))
    .toEqual({ requestId: "one", operation: "get", revisionId: "revision" });
  expect(readRevisionRequest('{"type":"uberblick:revision-request","requestId":"one","operation":"get"}')).toBeNull();
  expect(readRevisionRequest(encodeRevisionRequest({ requestId: "x".repeat(257), operation: "list" }))).toBeNull();
});

it("reassembles large snapshots and lists without exceeding the WebSocket frame ceiling", () => {
  const state = Uint8Array.from({ length: 17 * 1024 * 1024 }, (_, index) => index % 251);
  const responses: RevisionResponse[] = [
    { requestId: "one", ok: true, state },
    { requestId: "one", ok: true, revisions: Array.from({ length: 5000 }, (_, index) => ({
      id: `revision-${index}`, author: { githubUsername: "person", surface: { kind: "mcp", name: "Claude Code" } },
      startedAt: index, endedAt: index + 1,
    })) },
  ];
  for (const response of responses) {
    const frames = encodeRevisionResponseFrames(response);
    expect(frames.length).toBeGreaterThan(1);
    expect(frames.every(frame => new TextEncoder().encode(frame).length < 16 * 1024 * 1024)).toBe(true);
    const read = createRevisionResponseReader("one");
    const other = createRevisionResponseReader("other");
    let result: RevisionResponse | null = null;
    for (const frame of frames.toReversed()) {
      expect(other(frame)).toBeNull();
      result = read(frame);
    }
    if ("state" in response) {
      expect(result !== null && "state" in result && Buffer.from(result.state).equals(response.state)).toBe(true);
    } else {
      expect(result).toEqual(response);
    }
  }
}, 15000);
