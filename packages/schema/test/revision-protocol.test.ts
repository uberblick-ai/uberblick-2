import { expect, it } from "vitest";
import { createRevisionResponseReader, encodeRevisionRequest, encodeRevisionResponseFrames,
  readRevisionRequest, readRevisionResponse, validRevisionName, type RevisionResponse } from "../src/index.js";

it("accepts only bounded, addressed revision requests", () => {
  expect(readRevisionRequest(encodeRevisionRequest({ requestId: "one", operation: "get", revisionId: "revision" })))
    .toEqual({ requestId: "one", operation: "get", revisionId: "revision" });
  expect(readRevisionRequest('{"type":"uberblick:revision-request","requestId":"one","operation":"get"}')).toBeNull();
  expect(readRevisionRequest(encodeRevisionRequest({ requestId: "x".repeat(257), operation: "list" }))).toBeNull();
});

it("negotiates names without changing legacy list replies and validates write replies", () => {
  const legacy = { id: "revision", author: null, startedAt: null, endedAt: 1 };
  const name = { text: "Reviewed", namer: { githubUsername: "ben", surface: { kind: "browser", name: "browser" } },
    namedAt: 2, canManage: true };
  for (const response of [
    { requestId: "one", ok: true, revisions: [legacy] },
    { requestId: "one", ok: true, revisions: [{ ...legacy, name }, { ...legacy, name: null }] },
    { requestId: "one", ok: true, revision: { ...legacy, name } },
    { requestId: "one", ok: false, error: "already-named", name },
  ] as RevisionResponse[]) {
    expect(readRevisionResponse(encodeRevisionResponseFrames(response)[0]!)).toEqual(response);
  }
  expect(readRevisionRequest(encodeRevisionRequest({ requestId: "one", operation: "list", includeNames: true })))
    .toEqual({ requestId: "one", operation: "list", includeNames: true });
  expect(readRevisionRequest(encodeRevisionRequest({ requestId: "one", operation: "name", checksum: "a".repeat(64),
    name: "Reviewed", surface: { kind: "mcp", name: "Claude Code" } }))).toMatchObject({ operation: "name", name: "Reviewed" });
  for (const invalid of ["", "x".repeat(101), "a\nb", "a\rb", "a\u2028b", "a\u2029b"]) expect(validRevisionName(invalid)).toBe(false);
  expect(validRevisionName("🦊".repeat(100))).toBe(true);
  const invalidName = encodeRevisionResponseFrames({ requestId: "one", ok: true, revision: { ...legacy, name } })[0]!
    .replace('"namedAt":2', '"namedAt":null');
  expect(readRevisionResponse(invalidName)).toBeNull();
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
