/** Credential admission stays unwired until the coordinated client cutover. */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Server } from "@hocuspocus/server";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { CredentialRegistry } from "../src/credentials.js";
import { silentLogger } from "../src/log.js";
import { HubDatabase } from "../src/persistence.js";
import { SYNC_PROTOCOL_VERSION } from "../src/protocol.js";
import { createRoomAuthenticator, type Hub, type HubContext } from "../src/server.js";
import { importCredentialKey, MAX_TOKEN_LIFETIME_SECONDS, mintToken } from "../src/token.js";
import {
  createClient,
  OTHER_WORKSPACE,
  removeTempDatabases,
  startHub,
  tempDatabasePath,
  TEST_SECRET,
  testRoom,
  token,
  type TestClient,
  WORKSPACE,
} from "./helpers.js";

let hub: Hub;
let localServer: Server<HubContext>;
let issuedToken: string;
const clients: TestClient[] = [];

beforeAll(async () => {
  // Start the live hub on a file already holding a credential: registry state
  // alone must not change its admission mode.
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

function connect(port: number, workspace: string, presented: string): TestClient {
  const client = createClient({
    port,
    room: testRoom(workspace),
    token: presented,
    reconnectDelayMs: 60_000,
  });
  clients.push(client);
  return client;
}

describe("current admission is unchanged", () => {
  it("the live hub still admits root-signed tokens into either workspace", async () => {
    for (const workspace of [WORKSPACE, OTHER_WORKSPACE]) {
      const client = connect(
        hub.port,
        workspace,
        await token("read-write", { workspace }),
      );
      await expect(client.synced).resolves.toBeUndefined();
    }
  });

  it("the live hub refuses a token signed under an issued credential", async () => {
    const client = connect(hub.port, WORKSPACE, issuedToken);
    await expect(client.denied).resolves.toBe("invalid-token");
  });

  it("the local authenticator admits its workspace with the root secret", async () => {
    const client = connect(localServer.address.port, WORKSPACE, await token());
    await expect(client.synced).resolves.toBeUndefined();
  });

  it("the local authenticator refuses a token signed under an issued credential", async () => {
    const client = connect(localServer.address.port, WORKSPACE, issuedToken);
    await expect(client.denied).resolves.toBe("invalid-token");
  });

  it("the local authenticator still refuses another workspace's root token", async () => {
    const client = connect(
      localServer.address.port,
      OTHER_WORKSPACE,
      await token("read-write", { workspace: OTHER_WORKSPACE }),
    );
    await expect(client.denied).resolves.toBe("workspace-mismatch");
  });
});

describe("no live credential-admission switch", () => {
  it("adds no environment variable that enables credential admission", () => {
    const source = readFileSync(new URL("../src/config.ts", import.meta.url), "utf8");
    const variables = [...source.matchAll(/\benv\.([A-Z][A-Z0-9_]*)/g)]
      .map((match) => match[1]);
    expect([...new Set(variables)].sort()).toEqual([
      "HUB_AUTH_TOKEN", "HUB_DB_PATH", "HUB_HOST", "PORT",
    ]);
  });

  it.each(["server.ts", "config.ts", "main.ts", "local-browser-server.ts"])(
    "%s does not import the credential boundary",
    (file) => {
      const source = readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8");
      expect(source).not.toMatch(/from\s+["']\.\/credential[^"']*["']/);
    },
  );
});
