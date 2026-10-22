import { describe, expect, it } from "vitest";
import { encodeOriginAck, encodeOriginUpdate, readOriginAck, readOriginUpdate } from "../src/origin.js";

describe("update origin envelopes", () => {
  it("round trips large exact update bytes and their original surface", () => {
    const update = Uint8Array.from({ length: 100_000 }, (_, index) => index % 256);
    const origin = { updateId: "original", credentialId: "credential", surface: { kind: "mcp", name: "Claude Code" } };
    expect(readOriginUpdate(encodeOriginUpdate("original", update, origin))).toEqual({ updateId: "original", update, origin });
  });

  it("downgrades missing, malformed or mismatched provenance without inventing a surface", () => {
    for (const origin of [null, {}, { updateId: "another" }, {
      updateId: "original", credentialId: "credential", surface: { kind: "mcp", name: " " },
    }]) {
      expect(readOriginUpdate(JSON.stringify({ type: "uberblick:origin-update", updateId: "original", update: "AAE=", origin })))
        .toEqual({ updateId: "original", update: new Uint8Array([0, 1]), origin: null });
    }
  });

  it("rejects malformed payloads and unrelated acknowledgements", () => {
    for (const raw of ["{", "[]", JSON.stringify({ type: "uberblick:origin-update", updateId: "id", update: "%%%" })]) {
      expect(readOriginUpdate(raw)).toBeNull();
    }
    expect(readOriginAck(encodeOriginAck("original", true))).toEqual({ updateId: "original", applied: true });
    expect(readOriginAck('{"type":"other","updateId":"original","applied":true}')).toBeNull();
    expect(readOriginAck('{"type":"uberblick:origin-ack","updateId":"original","applied":1}')).toBeNull();
  });
});
