/** Credential and membership admission stay unwired until the client cutover. */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Server } from "@hocuspocus/server";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { GithubSignIn, SignInCollection } from "../src/github-sign-in.js";
import { silentLogger } from "../src/log.js";
import { MembershipRegistry } from "../src/memberships.js";
import { HubDatabase } from "../src/persistence.js";
import { PrincipalRegistry } from "../src/principals.js";
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
  // An existing member can sign in on the live hub without activating
  // credential admission. Root admission must remain independent of both.
  const databasePath = tempDatabasePath();
  const database = new HubDatabase(databasePath, () => {});
  database.open();
  try {
    const principal = new PrincipalRegistry(database).identify("1234", "compatibility-member");
    new MembershipRegistry(database).grant({
      workspaceId: WORKSPACE,
      principalId: principal.id,
      role: "admin",
    });
  } finally {
    database.close();
  }
  let now = 1000;
  hub = await startHub({
    databasePath,
    github: {
      clientId: "Iv1.0123456789abcdef",
      now: () => now,
      fetch: async (url) => {
        const body = String(url) === "https://github.com/login/device/code"
          ? { device_code: "github-private-device-code", user_code: "ABCD-EFGH", verification_uri: "https://github.com/login/device", expires_in: 900, interval: 1 }
          : String(url) === "https://github.com/login/oauth/access_token"
            ? { access_token: "github-private-token", token_type: "bearer", scope: "" }
            : String(url) === "https://api.github.com/user"
              ? { id: 1234, login: "compatibility-member" }
              : null;
        if (body === null) throw new Error("unexpected GitHub endpoint");
        return Response.json(body);
      },
    },
  });
  const post = (path: string, body: unknown) => fetch(`http://127.0.0.1:${hub.port}${path}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const started = await (await post("/auth/github/start", {})).json() as Awaited<ReturnType<GithubSignIn["start"]>>;
  if (started.status !== "pending") throw new Error("sign-in did not start");
  now += 1000;
  const collected = await (await post("/auth/github/collect", {
    requestId: started.requestId, collectionSecret: started.collectionSecret,
  })).json() as SignInCollection;
  if (collected.status !== "complete") throw new Error("sign-in did not complete");
  expect(collected.credential.record.workspaces).toEqual([WORKSPACE]);
  issuedToken = await mintToken(await importCredentialKey(Buffer.from(collected.credential.key, "base64url")), {
    typ: "room",
    sub: collected.identity.id,
    workspace: WORKSPACE,
    scope: "read-write",
    kid: collected.credential.record.id,
    lifetimeSeconds: MAX_TOKEN_LIFETIME_SECONDS,
  });

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
    "%s does not import credential admission",
    (file) => {
      const source = readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8");
      expect(source).not.toMatch(/(?:from\s+|import\s*\(?\s*)["']\.\/credential-admission(?:\.[^"']*)?["']/);
    },
  );
});
