/**
 * What a refused connection says in the hub's log.
 *
 * The event exists to be acted on. Several machines, browser tabs and
 * long-lived agent sessions present tokens to one hub, and a rejection that
 * names neither the peer nor a cause turns "restart the stale client" into a
 * hunt across every machine. Three properties are worth defending:
 *
 * 1. the line names the peer, and behind the deployment's proxy that is the
 *    client's own address rather than the proxy's;
 * 2. the cause tells a fleet of pre-v2 clients apart from a wrong secret, an
 *    expired token or a token minted for another workspace;
 * 3. whatever went wrong, the line never carries the token, its signature or
 *    the hub's secret.
 */

import { HocuspocusProvider } from "@hocuspocus/provider";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import type { HubLogRecord } from "../src/log.js";
import type { Hub } from "../src/server.js";
import { PEER_ADDRESS_HEADER, resolvePeer } from "../src/server.js";
import { MAX_TOKEN_LIFETIME_SECONDS } from "../src/token.js";
import {
  createClient,
  forgeToken,
  OTHER_WORKSPACE,
  removeTempDatabases,
  startHub,
  TEST_SECRET,
  testRoom,
  token,
  type TestClient,
  waitUntil,
  WORKSPACE,
} from "./helpers.js";

let hub: Hub;
const records: HubLogRecord[] = [];
const clients: TestClient[] = [];

const NOW = Math.floor(Date.now() / 1000);

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

// A rejected client reconnects on its own, so leaving one behind would keep
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

/** Present `presented` to the hub and hand back the rejection it logged. */
async function rejectionFor(
  presented: string,
  options: { room?: string; headers?: Record<string, string> } = {},
): Promise<HubLogRecord> {
  const client = createClient({
    port: hub.port,
    room: options.room ?? testRoom(),
    token: presented,
    ...(options.headers === undefined ? {} : { headers: options.headers }),
  });
  clients.push(client);

  await client.denied;
  await waitUntil("a rejection to be logged", () =>
    records.some((record) => record.event === "hub.auth.rejected"),
  );
  const record = records.find((entry) => entry.event === "hub.auth.rejected");
  if (record === undefined) {
    throw new Error("no hub.auth.rejected record");
  }
  return record;
}

/**
 * The three things a rejection must never carry, asserted against the line as
 * it would actually be written. The token's segments are checked separately
 * from the whole: a log that quoted only the signature would still be one that
 * leaked it.
 */
function expectNoSecrets(record: HubLogRecord, presented: string): void {
  const line = JSON.stringify(record);
  expect(line).not.toContain(TEST_SECRET);
  for (const secret of [presented, ...presented.split(".")]) {
    if (secret.length >= 8) {
      expect(line).not.toContain(secret);
    }
  }
}

interface Case {
  name: string;
  cause: string;
  /** What the token said about itself, or `"unparseable"` when it said nothing. */
  identity: { typ: string | null; sub: string | null } | "unparseable";
  token: () => Promise<string>;
}

const cases: Case[] = [
  {
    name: "a string that is not a token at all",
    cause: "unparseable",
    identity: "unparseable",
    token: async () => "not-a-token",
  },
  {
    // Refused on length before anything decodes it: a real token is a few
    // hundred bytes, and an unauthenticated caller does not get to choose how
    // much work the hub does.
    //
    // Past MAX_TOKEN_LENGTH and still inside MAX_AUTH_MESSAGE_LENGTH, so it is
    // the *token* ceiling this case reaches. The envelope's own bound is the
    // outer one and refuses a longer string earlier, under a different cause —
    // see `protocol.test.ts`, which pins that one.
    name: "a token far longer than any token",
    cause: "unparseable",
    identity: "unparseable",
    token: async () => `${"A".repeat(2074)}.${"B".repeat(2075)}`,
  },
  {
    name: "a token signed with somebody else's secret",
    cause: "bad-signature",
    identity: { typ: "room", sub: "wrong-secret-client" },
    token: () =>
      token("read-write", {
        secret: "not-this-hub's-secret",
        sub: "wrong-secret-client",
      }),
  },
  {
    // The situation the event was written for: a client that has not been
    // restarted since the claims-v2 deploy, still minting the old shape.
    name: "a pre-v2 token from a client that was never restarted",
    cause: "unsupported-claims",
    identity: { typ: null, sub: "pre-v2-client" },
    token: () =>
      forgeToken({
        sub: "pre-v2-client",
        workspace: WORKSPACE,
        scope: "read-write",
        iat: NOW,
      }),
  },
  {
    name: "a token that claimed a decade",
    cause: "lifetime-too-long",
    identity: { typ: "room", sub: "a-compromised-machine" },
    token: () =>
      forgeToken({
        typ: "room",
        sub: "a-compromised-machine",
        workspace: WORKSPACE,
        scope: "read-write",
        kid: null,
        iat: NOW,
        exp: NOW + 10 * 365 * 24 * 60 * 60,
      }),
  },
  {
    name: "a token from a clock that runs ahead",
    cause: "not-yet-issued",
    identity: { typ: "room", sub: "tomorrow" },
    token: () =>
      forgeToken({
        typ: "room",
        sub: "tomorrow",
        workspace: WORKSPACE,
        scope: "read-write",
        kid: null,
        iat: NOW + 3_600,
        exp: NOW + 3_600 + MAX_TOKEN_LIFETIME_SECONDS,
      }),
  },
  {
    name: "an expired token",
    cause: "expired",
    identity: { typ: "room", sub: "yesterday" },
    token: () =>
      forgeToken({
        typ: "room",
        sub: "yesterday",
        workspace: WORKSPACE,
        scope: "read-write",
        kid: null,
        iat: NOW - 1_800,
        exp: NOW - 900,
      }),
  },
  {
    name: "a valid token for another workspace",
    cause: "workspace-mismatch",
    identity: { typ: "room", sub: "intruder" },
    token: () =>
      token("read-write", { workspace: OTHER_WORKSPACE, sub: "intruder" }),
  },
];

describe("a rejected connection", () => {
  it.each(cases)("names $cause for $name", async (scenario) => {
    const presented = await scenario.token();

    const record = await rejectionFor(presented);

    expect(record.cause).toBe(scenario.cause);
    if (scenario.identity === "unparseable") {
      expect(record.token).toBe("unparseable");
      expect(record).not.toHaveProperty("sub");
    } else {
      expect(record.typ).toBe(scenario.identity.typ);
      expect(record.sub).toBe(scenario.identity.sub);
    }
    expectNoSecrets(record, presented);
  });

  it("names token-in-query without reading any token", async () => {
    // Refused on the URL, before a token has been read — so the parameter is
    // the whole finding, and there is no identity to report.
    const presented = await token("read-write");
    const provider = new HocuspocusProvider({
      url: `ws://127.0.0.1:${hub.port}/?token=${presented}`,
      name: testRoom(),
      token: presented,
      document: new Y.Doc(),
    });
    const denied = new Promise<string>((resolve) => {
      provider.on("authenticationFailed", ({ reason }: { reason: string }) => {
        resolve(reason);
      });
    });

    try {
      await denied;
      const record = records.find(
        (entry) => entry.event === "hub.auth.rejected",
      );
      if (record === undefined) {
        throw new Error("no hub.auth.rejected record");
      }
      expect(record.cause).toBe("token-in-query");
      expect(record.parameter).toBe("token");
      expect(record).not.toHaveProperty("sub");
      expectNoSecrets(record, presented);
    } finally {
      provider.destroy();
    }
  });

  it("names the socket's own address when nothing is in front of the hub", async () => {
    // Sending the internal header is the obvious way to lie about the peer, so
    // the upgrade hook overwrites it rather than reading it.
    const record = await rejectionFor("not-a-token", {
      headers: { [PEER_ADDRESS_HEADER]: "8.8.8.8" },
    });

    expect(["127.0.0.1", "::ffff:127.0.0.1", "::1"]).toContain(record.peer);
    expect(record.proxied).toBe(false);
  });

  it("names the client the proxy saw, not the proxy", async () => {
    // What the Compose deployment looks like from here: the hub's peer is the
    // local proxy, and the address that matters is the one Caddy observed.
    const record = await rejectionFor("not-a-token", {
      headers: { "x-forwarded-for": "198.51.100.9" },
    });

    expect(record.peer).toBe("198.51.100.9");
    expect(record.proxied).toBe(true);
  });

  it("ignores the hops a client wrote into the proxy header itself", async () => {
    // Only the last hop is the address a proxy observed; everything left of it
    // is somebody's claim about itself, which is what a `trusted_proxies`
    // configuration would let through.
    const record = await rejectionFor("not-a-token", {
      headers: { "x-forwarded-for": "203.0.113.7, 198.51.100.9" },
    });

    expect(record.peer).toBe("198.51.100.9");
    expect(record.proxied).toBe(true);
  });
});

describe("the proxy header", () => {
  // A socket from an untrusted address cannot be opened from a test, so the
  // trust rule itself is checked where it is decided.
  it.each([
    {
      peer: "172.18.0.5",
      of: "the deployment's own bridge network",
      expected: { address: "198.51.100.9", proxied: true },
    },
    {
      peer: "203.0.113.5",
      of: "a routable address",
      expected: { address: "203.0.113.5", proxied: false },
    },
    {
      // The tailnet a client dials the deployed hub from. Private-looking, and
      // deliberately not trusted: it is where the clients are.
      peer: "100.64.0.7",
      of: "the tailnet",
      expected: { address: "100.64.0.7", proxied: false },
    },
  ])("from $of is $expected.proxied", ({ peer, expected }) => {
    const headers = new Headers({
      [PEER_ADDRESS_HEADER]: peer,
      "x-forwarded-for": "198.51.100.9",
    });

    expect(resolvePeer(headers)).toEqual(expected);
  });
});
