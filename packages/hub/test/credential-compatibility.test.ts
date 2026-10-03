/** Credential and membership admission stay unwired until the client cutover. */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Server } from "@hocuspocus/server";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { CredentialRegistry } from "../src/credentials.js";
import { silentLogger } from "../src/log.js";
import { MembershipRegistry } from "../src/memberships.js";
import { HubDatabase } from "../src/persistence.js";
import { SYNC_PROTOCOL_VERSION } from "../src/protocol.js";
import { createRoomAuthenticator, type Hub, type HubContext } from "../src/server.js";
import { importCredentialKey, MAX_TOKEN_LIFETIME_SECONDS, mintToken } from "../src/token.js";
import {
  createClient,
  removeTempDatabases,
  startHub,
  tempDatabasePath,
  TEST_SECRET,
  testRoom,
  token,
  type TestClient,
  waitForText,
  WORKSPACE,
} from "./helpers.js";

let hub: Hub;
let localServer: Server<HubContext>;
let issuedToken: string;
const clients: TestClient[] = [];

beforeAll(async () => {
  // Start the live hub on a file already holding a credential and membership:
  // authority state alone must not change its admission mode.
  const databasePath = tempDatabasePath();
  const database = new HubDatabase(databasePath, () => {});
  database.open();
  try {
    const registry = new CredentialRegistry(database);
    const issued = registry.issue({
      principalId: randomUUID(),
      deviceId: randomUUID(),
      workspaces: [WORKSPACE],
    });
    new MembershipRegistry(database).grant({
      workspaceId: WORKSPACE,
      principalId: issued.record.principalId,
      role: "admin",
    });
    issuedToken = await mintToken(await importCredentialKey(issued.keyBytes), {
      typ: "room",
      sub: issued.record.principalId,
      workspace: WORKSPACE,
      scope: "read-write",
      kid: issued.record.id,
      lifetimeSeconds: MAX_TOKEN_LIFETIME_SECONDS,
    });
  } finally {
    database.close();
  }
  hub = await startHub({ databasePath });

  // This is the shared authenticator installed by ub open. It needs only its
  // local secret and served workspace, without a registry or credential.
  localServer = new Server<HubContext>({
    port: 0,
    address: "127.0.0.1",
    quiet: true,
    stopOnSignals: false,
    onAuthenticate: await createRoomAuthenticator({
      authSecret: TEST_SECRET,
      protocolVersion: SYNC_PROTOCOL_VERSION,
      log: silentLogger,
      servedWorkspace: WORKSPACE,
    }),
  });
  await localServer.listen();
});

afterEach(() => {
  for (const client of clients.splice(0)) client.destroy();
});

afterAll(async () => {
  await localServer?.destroy();
  await hub?.stop();
  removeTempDatabases();
});

function connect(
  port: number,
  workspace: string,
  presented: string,
  room: string = testRoom(workspace),
): TestClient {
  const client = createClient({
    port,
    room,
    token: presented,
    reconnectDelayMs: 60_000,
  });
  clients.push(client);
  return client;
}

describe("current admission is unchanged", () => {
  it.each(["live hub", "local authenticator"])(
    "%s admits root-signed document edits without membership",
    async (server) => {
      const port = server === "live hub" ? hub.port : localServer.address.port;
      const room = testRoom();
      // Neither root-token principal has a membership or device credential.
      const writer = connect(port, WORKSPACE, await token("read-write", { sub: randomUUID() }), room);
      const observer = connect(port, WORKSPACE, await token("read-write", { sub: randomUUID() }), room);
      await Promise.all([writer.synced, observer.synced]);
      writer.text.insert(0, "root access still writes");
      await waitForText("the root-signed observer", observer.text, "root access still writes");
    },
  );

  it("the live hub refuses a token signed under an issued credential", async () => {
    const client = connect(hub.port, WORKSPACE, issuedToken);
    await expect(client.denied).resolves.toBe("invalid-token");
  });

  it("the local authenticator refuses a token signed under an issued credential", async () => {
    const client = connect(localServer.address.port, WORKSPACE, issuedToken);
    await expect(client.denied).resolves.toBe("invalid-token");
  });
});

describe("no live credential or membership admission switch", () => {
  it.each(["server.ts", "config.ts", "main.ts", "local-browser-server.ts"])(
    "%s does not import credential or membership authority",
    (file) => {
      const source = readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8");
      expect(source).not.toMatch(/(?:from\s+|import\s*\(?\s*)["']\.\/(?:credential|memberships)[^"']*["']/);
    },
  );
});
