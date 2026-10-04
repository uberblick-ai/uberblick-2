/**
 * The protocol version exchange: what the hub accepts, what it refuses, and
 * what a refusal is allowed to say.
 *
 * Four properties, and nothing about the constant's current value:
 *
 * 1. equal versions authenticate, and a client that speaks another one — or no
 *    envelope at all — is refused with a reason distinct from every other
 *    refusal, so a client can tell "update me" from "fix the secret";
 * 2. the raw auth string is bounded **before** it is parsed, so wrapping the
 *    token in JSON did not hand an unauthenticated caller an unbounded
 *    `JSON.parse` — and wrapping did not shrink the ceiling either: a token of
 *    the full {@link MAX_TOKEN_LENGTH} still authenticates inside an envelope;
 * 3. what a client extracts from the refusal is one validated integer, never
 *    the hub's text;
 * 4. the rejection line carries both integers and neither the token nor the
 *    envelope.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { HubLogRecord } from "../src/log.js";
import type { Hub } from "../src/server.js";
import {
  MAX_AUTH_MESSAGE_LENGTH,
  protocolMismatchReason,
  readAuthEnvelope,
  readProtocolMismatch,
  SYNC_PROTOCOL_VERSION,
  wrapToken,
} from "../src/protocol.js";
import { MAX_TOKEN_LENGTH } from "../src/token.js";
import {
  createClient,
  forgeToken,
  removeTempDatabases,
  startHub,
  testRoom,
  token,
  waitUntil,
  WORKSPACE,
  type TestClient,
} from "./helpers.js";

let hub: Hub;
const records: HubLogRecord[] = [];
const clients: TestClient[] = [];

beforeAll(async () => {
  hub = await startHub({
    log: (record) => {
      records.push(record);
    },
  });
});

beforeEach(() => {
  records.length = 0;
});

// A refused client reconnects on its own, so one left behind would go on
// writing records into the next test's expectations.
afterEach(() => {
  for (const client of clients.splice(0)) {
    client.destroy();
  }
});

afterAll(async () => {
  await hub.stop();
  removeTempDatabases();
});

function client(
  jwt: string,
  protocolVersion?: number | null,
): TestClient {
  const created = createClient({
    port: hub.port,
    room: testRoom(),
    token: jwt,
    ...(protocolVersion === undefined ? {} : { protocolVersion }),
  });
  clients.push(created);
  return created;
}

/**
 * A correctly signed token of exactly {@link MAX_TOKEN_LENGTH} characters —
 * the longest one the hub will look at, padded through `sub`, which is the one
 * claim with no length of its own.
 *
 * The arithmetic is the token's format: a base64url HMAC-SHA256 signature is 43
 * characters, plus the separator, so the payload is 4052 characters, which is
 * base64url of 3039 bytes of JSON.
 */
async function maximalToken(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    typ: "room",
    sub: "",
    workspace: WORKSPACE,
    scope: "read-write",
    kid: null,
    iat: now,
    exp: now + 60,
  };
  const payloadBytes = Math.floor(((MAX_TOKEN_LENGTH - 1 - 43) * 3) / 4);
  const padding = payloadBytes - Buffer.byteLength(JSON.stringify(claims));
  expect(padding).toBeGreaterThan(0);
  const jwt = await forgeToken({ ...claims, sub: "x".repeat(padding) });
  // The helper's whole point: if this is not exact the test below proves less
  // than it claims to.
  expect(jwt.length).toBe(MAX_TOKEN_LENGTH);
  return jwt;
}

describe("the version exchange", () => {
  it("refuses another version, and a bare token, with the same exact reason", async () => {
    const newer = client(await token("read-write"), SYNC_PROTOCOL_VERSION + 1);
    const older = client(await token("read-write"), SYNC_PROTOCOL_VERSION - 1);
    // What every client that has not been updated looks like on the flag day.
    const bare = client(await token("read-write"), null);

    const reason = protocolMismatchReason(SYNC_PROTOCOL_VERSION);
    await expect(newer.denied).resolves.toBe(reason);
    await expect(older.denied).resolves.toBe(reason);
    await expect(bare.denied).resolves.toBe(reason);
  });
});

describe("the length bound", () => {
  it("refuses an over-long auth string without parsing it", () => {
    // The property `MAX_TOKEN_LENGTH` exists for: an unauthenticated caller
    // does not get to choose how much work the hub does. Parsing first would
    // have handed `JSON.parse` the whole string before anything checked it.
    const parse = vi.spyOn(JSON, "parse");
    try {
      expect(readAuthEnvelope("x".repeat(MAX_AUTH_MESSAGE_LENGTH + 1))).toBeNull();
      expect(parse).not.toHaveBeenCalled();
    } finally {
      parse.mockRestore();
    }
  });

  it("refuses an over-long auth string on the wire too", async () => {
    const refused = client("x".repeat(MAX_AUTH_MESSAGE_LENGTH + 1), null);

    await expect(refused.denied).resolves.toBe(
      protocolMismatchReason(SYNC_PROTOCOL_VERSION),
    );
  });

  it("authenticates a token of the full MAX_TOKEN_LENGTH when it is wrapped", async () => {
    // Wrapping must not shrink the effective ceiling: the envelope's allowance
    // sits on top of the token's length, it does not eat into it.
    const accepted = client(await maximalToken());

    await expect(accepted.synced).resolves.toBeUndefined();
  });
});

describe("what a refused client may read", () => {
  it("extracts one validated integer and nothing else", () => {
    const ours = SYNC_PROTOCOL_VERSION;

    expect(readProtocolMismatch(`protocol-mismatch:${ours + 1}`, ours)).toBe(ours + 1);
    expect(readProtocolMismatch("protocol-mismatch:999999", ours)).toBe(999999);

    // Everything else is today's token rejection, handled as it is today. A
    // sentinel naming our own version included: no honest hub sends one, and
    // believing it would talk this client into an update it does not need.
    expect(readProtocolMismatch(`protocol-mismatch:${ours}`, ours)).toBeNull();
    expect(readProtocolMismatch("protocol-mismatch:0", ours)).toBeNull();
    expect(readProtocolMismatch("protocol-mismatch:01", ours)).toBeNull();
    expect(readProtocolMismatch("protocol-mismatch:9999999", ours)).toBeNull();
    expect(readProtocolMismatch("protocol-mismatch:2 or so", ours)).toBeNull();
    expect(readProtocolMismatch("invalid-token", ours)).toBeNull();
    expect(readProtocolMismatch("", ours)).toBeNull();
  });
});

describe("the rejection line", () => {
  it.each([
    // A readable envelope names the version it claimed; a bare token has none
    // to name, and `null` is the honest answer rather than a guess.
    { name: "a readable envelope", claimed: SYNC_PROTOCOL_VERSION + 1, logged: SYNC_PROTOCOL_VERSION + 1 },
    { name: "no envelope at all", claimed: null, logged: null },
  ])("carries both integers and no token for $name", async (scenario) => {
    const jwt = await token("read-write", { sub: "a-stale-client" });
    const envelope = wrapToken(jwt, scenario.claimed ?? SYNC_PROTOCOL_VERSION);
    client(jwt, scenario.claimed);

    await waitUntil("the rejection to be logged", () =>
      records.some((record) => record.cause === "protocol-mismatch"),
    );
    const line = records.find((record) => record.cause === "protocol-mismatch");

    expect(line?.clientProtocol).toBe(scenario.logged);
    expect(line?.hubProtocol).toBe(SYNC_PROTOCOL_VERSION);
    const written = JSON.stringify(line);
    expect(written).not.toContain(jwt);
    expect(written).not.toContain(envelope);
  });
});
