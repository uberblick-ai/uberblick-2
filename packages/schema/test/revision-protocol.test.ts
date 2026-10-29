import { expect, it } from "vitest";
import { createRevisionResponseReader, encodeRevisionCatalogChanged, encodeRevisionRequest, encodeRevisionResponse, encodeRevisionResponseFrames,
  readOriginAck, readRevisionCatalogChanged, readRevisionRequest, readRevisionResponse, validRevisionName,
  type RevisionResponse } from "../src/index.js";

it("encodes only a catalog change and keeps it separate from addressed traffic", () => {
  const notice = encodeRevisionCatalogChanged();
  expect(notice).toBe('{"type":"uberblick:revision-catalog-changed"}');
  expect(readRevisionCatalogChanged(notice)).toEqual({ type: "uberblick:revision-catalog-changed" });
  expect(readRevisionRequest(notice)).toBeNull();
  expect(readRevisionResponse(notice)).toBeNull();
  expect(createRevisionResponseReader("one")(notice)).toBeNull();
  expect(readOriginAck(notice)).toBeNull();
  for (const raw of ["", "{", "null", "[]", '"uberblick:revision-catalog-changed"', "{}",
    '{"type":null}', '{"type":"settings-generation","generation":1}',
    encodeRevisionRequest({ requestId: "one", operation: "list" }),
    encodeRevisionResponseFrames({ requestId: "one", ok: true, revisions: [] })[0]!]) {
    expect(readRevisionCatalogChanged(raw)).toBeNull();
  }
});

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

it("preserves an optional rename surface and rejects malformed attribution", () => {
  const request = { requestId: "rename", operation: "rename" as const, revisionId: "past", name: "Reviewed" };
  expect(readRevisionRequest(encodeRevisionRequest(request))).toEqual(request);
  const surface = { kind: "browser", name: "browser" };
  expect(readRevisionRequest(encodeRevisionRequest({ ...request, surface }))).toEqual({ ...request, surface });
  for (const invalid of [null, {}, { kind: "", name: "browser" }, { kind: "browser", name: "" },
    { kind: "browser", name: "x".repeat(257) }, { kind: "x".repeat(257), name: "browser" }]) {
    expect(readRevisionRequest(JSON.stringify({ type: "uberblick:revision-request", ...request, surface: invalid }))).toBeNull();
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

it("preserves list version strings within the request bound independently of the include options", () => {
  const request = { requestId: "one", operation: "list" as const, ifVersion: "catalog-version" };
  for (const options of [{}, { includeNames: true as const }, { includeTitles: true as const },
    { includeNames: true as const, includeTitles: true as const }]) {
    expect(readRevisionRequest(encodeRevisionRequest({ ...request, ...options }))).toEqual({ ...request, ...options });
  }
  for (const ifVersion of ["", "x".repeat(257)]) {
    expect(readRevisionRequest(encodeRevisionRequest({ ...request, ifVersion }))).toEqual({ ...request, ifVersion });
  }
  expect(readRevisionRequest(encodeRevisionRequest({ ...request, ifVersion: "x".repeat(4096) }))).toBeNull();
  for (const ifVersion of [null, 1, {}, []]) {
    expect(readRevisionRequest(JSON.stringify({ type: "uberblick:revision-request", ...request, ifVersion }))).toBeNull();
  }
});

it("distinguishes a token-less catalog, a versioned catalog and an unchanged reply", () => {
  const responses: RevisionResponse[] = [
    { requestId: "one", ok: true, revisions: [] },
    { requestId: "one", ok: true, revisions: [], version: "catalog-version" },
    { requestId: "one", ok: true, unchanged: true, version: "catalog-version" },
  ];
  for (const response of responses) {
    const encoded = encodeRevisionResponseFrames(response)[0]!;
    expect(readRevisionResponse(encoded)).toEqual(response);
    expect(createRevisionResponseReader("one")(encoded)).toEqual(response);
  }
  expect(readRevisionResponse(encodeRevisionResponseFrames(responses[0]!)[0]!)).not.toHaveProperty("version");
  for (const fields of [{ unchanged: true }, { unchanged: false, version: "catalog-version" },
    { unchanged: true, version: "catalog-version", revisions: [] },
    { unchanged: true, version: "catalog-version", state: "" },
    ...[null, "", "x".repeat(257), 1, {}, []].flatMap(version => [{ revisions: [], version }, { unchanged: true, version }])]) {
    expect(readRevisionResponse(JSON.stringify({ type: "uberblick:revision-response", requestId: "one", ok: true, ...fields })))
      .toBeNull();
  }
});

it("preserves canonical catalog metadata and rejects malformed metadata", () => {
  const revision = { id: "revision", author: null, startedAt: 1, endedAt: null,
    checksum: "a".repeat(64), final: false, deadlineAt: 900001 };
  const response = { requestId: "one", ok: true as const, revisions: [revision], version: "catalog-version" };
  expect(readRevisionResponse(encodeRevisionResponseFrames(response)[0]!)).toEqual(response);
  for (const fields of [{ checksum: "A".repeat(64) }, { checksum: "a".repeat(63) }, { checksum: null },
    { final: null }, { final: "false" }, { deadlineAt: null }, { deadlineAt: "900001" }]) {
    expect(readRevisionResponse(JSON.stringify({ type: "uberblick:revision-response", ...response,
      revisions: [{ ...revision, ...fields }] }))).toBeNull();
  }
  expect(readRevisionResponse(encodeRevisionResponseFrames(response)[0]!.replace('"deadlineAt":900001', '"deadlineAt":1e999')))
    .toBeNull();
});

it("preserves snapshot identity and checksum while accepting legacy snapshots", () => {
  for (const metadata of [{}, { revisionId: "revision", checksum: "b".repeat(64) }]) {
    const response = { requestId: "one", ok: true as const, state: Uint8Array.of(1, 2, 3), ...metadata };
    expect(readRevisionResponse(encodeRevisionResponseFrames(response)[0]!)).toEqual(response);
  }
  for (const metadata of [{ revisionId: "" }, { revisionId: "x".repeat(257) }, { revisionId: null },
    { checksum: "B".repeat(64) }, { checksum: null }]) {
    expect(readRevisionResponse(JSON.stringify({ type: "uberblick:revision-response", requestId: "one", ok: true,
      state: "AQID", ...metadata }))).toBeNull();
  }
});

it("reassembles large snapshots and lists without exceeding the WebSocket frame ceiling", () => {
  const ceiling = 16 * 1024 * 1024;
  const state = new Uint8Array(1.5 * 1024 * 1024);
  for (let index = 0; index < state.length; index++) state[index] = index % 251;
  // Text exercises the message ceiling without paying for a ceiling-sized base64 snapshot.
  const title = "🦊é".repeat(256 * 1024);
  const responses: RevisionResponse[] = [
    { requestId: "one", ok: true, state, revisionId: "revision", checksum: "c".repeat(64) },
    { requestId: "one", ok: true, version: "catalog-version", revisions: Array.from({ length: 12 }, (_, index) => ({
      id: `revision-${index}`, author: { githubUsername: "person", surface: { kind: "mcp", name: "Claude Code" } },
      startedAt: index, endedAt: index + 1, checksum: "d".repeat(64), final: index % 2 === 0, title,
    })) },
  ];
  for (const response of responses) {
    if ("revisions" in response) expect(Buffer.byteLength(encodeRevisionResponse(response), "utf8")).toBeGreaterThan(ceiling);
    const frames = encodeRevisionResponseFrames(response);
    expect(frames.length).toBeGreaterThan(1);
    expect(frames.every(frame => Buffer.byteLength(frame, "utf8") < ceiling)).toBe(true);
    const read = createRevisionResponseReader("one");
    const other = createRevisionResponseReader("other");
    let result: RevisionResponse | null = null;
    for (const [index, frame] of frames.toReversed().entries()) {
      expect(other(frame)).toBeNull();
      expect(read(encodeRevisionCatalogChanged())).toBeNull();
      result = read(frame);
      if (index < frames.length - 1) expect(result).toBeNull();
    }
    if ("state" in response) {
      expect(result !== null && "state" in result && Buffer.from(result.state).equals(response.state)).toBe(true);
      expect(result).toMatchObject({ revisionId: "revision", checksum: "c".repeat(64) });
    } else {
      expect(result).toEqual(response);
    }
  }
});
