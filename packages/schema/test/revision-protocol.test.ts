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

it("validates restore's revision, checksum and author surface and preserves no-op replies", () => {
  const request = { requestId: "restore", operation: "restore" as const, revisionId: "past", checksum: "a".repeat(64),
    surface: { kind: "mcp", name: "Claude Code" } };
  expect(readRevisionRequest(encodeRevisionRequest(request))).toEqual(request);
  for (const invalid of [{ ...request, revisionId: undefined }, { ...request, checksum: "stale" },
    { ...request, surface: undefined }, { ...request, surface: { kind: "", name: "browser" } }]) {
    expect(readRevisionRequest(JSON.stringify({ type: "uberblick:revision-request", ...invalid }))).toBeNull();
  }
  for (const applied of [true, false]) {
    const response = { requestId: "restore", ok: true as const, applied,
      revision: { id: "restored", author: null, startedAt: 1, endedAt: 1 } };
    const encoded = encodeRevisionResponseFrames(response)[0]!;
    expect(readRevisionResponse(encoded)).toEqual(response);
    expect(readRevisionResponse(encoded.replace(`"applied":${applied}`, '"applied":"unknown"'))).toBeNull();
  }
});

it("opts into titles independently of names and accepts legacy replies without titles", () => {
  const legacy = { id: "revision", author: null, startedAt: null, endedAt: 1 };
  const request = { requestId: "one", operation: "list" as const, includeTitles: true as const };
  expect(readRevisionRequest(encodeRevisionRequest(request))).toEqual(request);
  expect(readRevisionRequest(encodeRevisionRequest({ ...request, includeNames: true })))
    .toEqual({ ...request, includeNames: true });
  expect(readRevisionRequest(encodeRevisionRequest(request).replace('"includeTitles":true', '"includeTitles":false')))
    .toEqual({ requestId: "one", operation: "list" });
  for (const revisions of [[legacy], [{ ...legacy, title: "Alpha" }, { ...legacy, title: "" }]]) {
    const response = { requestId: "one", ok: true as const, revisions };
    expect(readRevisionResponse(encodeRevisionResponseFrames(response)[0]!)).toEqual(response);
  }
  const encoded = encodeRevisionResponseFrames({ requestId: "one", ok: true, revisions: [{ ...legacy, title: "Alpha" }] })[0]!;
  for (const invalid of ["null", "7", "{}", "[]"]) {
    expect(readRevisionResponse(encoded.replace('"title":"Alpha"', `"title":${invalid}`))).toBeNull();
  }
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
