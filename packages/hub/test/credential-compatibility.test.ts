/** Loopback admission retains the local shared-secret security model. */

import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { Server } from "@hocuspocus/server";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { adminSocketPath, type SetupGrant } from "../src/admin-setup.js";
import type { GithubSignIn, SignInCollection } from "../src/github-sign-in.js";
import { silentLogger } from "../src/log.js";
import { SYNC_PROTOCOL_VERSION } from "../src/protocol.js";
import { createHub, createRoomAuthenticator, type Hub, type HubContext } from "../src/server.js";
import { importCredentialKey, MAX_TOKEN_LIFETIME_SECONDS, mintRequestProof, mintToken } from "../src/token.js";
import {
  createClient,
  removeTempDatabases,
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
let originalDirectory: string;

beforeAll(async () => {
  originalDirectory = process.cwd();
  process.chdir(tmpdir());
  // Actual host setup must leave root admission independent of membership,
  // and issue no credential until the approving account later signs in.
  const databasePath = tempDatabasePath();
  let now = 1000;
  hub = await createHub({
    authSecret: TEST_SECRET,
    port: 0,
    address: "127.0.0.1",
    log: silentLogger,
    shutdownTimeoutMs: 5_000,
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
  }, { operatorSetup: true });
  const setup = await new Promise<SetupGrant>((resolve, reject) => {
    const socket = createConnection(adminSocketPath(databasePath));
    let input = "";
    let grant: SetupGrant | undefined;
    socket.setTimeout(5_000, () => socket.destroy(new Error("setup timed out")));
    socket.on("error", reject);
    socket.on("close", () => {
      if (grant === undefined) reject(new Error("setup closed before completing"));
      else resolve(grant);
    });
    socket.on("connect", () => {
      socket.write(`${JSON.stringify({ action: "start", workspaceId: WORKSPACE })}\n`);
    });
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      try {
        input += chunk;
        for (;;) {
          const newline = input.indexOf("\n");
          if (newline < 0) return;
          const message = JSON.parse(input.slice(0, newline)) as { status: string; userCode?: string };
          input = input.slice(newline + 1);
          if (message.status === "pending") {
            expect(message.userCode).toBe("ABCD-EFGH");
            now += 1000;
          } else if (message.status === "complete") {
            grant = message as SetupGrant;
            socket.end();
          } else if (message.status !== "starting") {
            throw new Error(`setup ended with ${message.status}`);
          }
        }
      } catch (error) {
        socket.destroy(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });
  expect(setup.workspaceId).toBe(WORKSPACE);
  expect(setup.hadDocuments).toBe(false);
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    expect(database.prepare("SELECT COUNT(*) AS count FROM hub_credentials").get()?.count).toBe(0);
    expect(database.prepare("SELECT workspace_id, principal_id, role FROM hub_memberships").all())
      .toEqual([{ workspace_id: WORKSPACE, principal_id: setup.identity.id, role: "admin" }]);
  } finally {
    database.close();
  }
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
  expect(collected.identity.id).toBe(setup.identity.id);
  expect(collected.credential.record.workspaces).toEqual([WORKSPACE]);
  const proof = await mintRequestProof(await importCredentialKey(Buffer.from(collected.credential.key, "base64url")), {
    kid: collected.credential.record.id, operation: "renew-credential", lifetimeSeconds: 60,
  });
  const renewed = await (await post("/auth/credential/renew", { protocolVersion: SYNC_PROTOCOL_VERSION, token: proof })).json() as {
    status: string; credential: typeof collected.credential;
  };
  expect(renewed.status).toBe("renewed");
  expect(renewed.credential.record.deviceId).toBe(collected.credential.record.deviceId);
  issuedToken = await mintToken(await importCredentialKey(Buffer.from(renewed.credential.key, "base64url")), {
    typ: "room",
    sub: collected.identity.id,
    workspace: WORKSPACE,
    scope: "read-write",
    kid: renewed.credential.record.id,
    lifetimeSeconds: MAX_TOKEN_LIFETIME_SECONDS,
  });

  // This is the shared authenticator installed by ub open. It needs only its
  // local workspace key, without a registry or credential.
  localServer = new Server<HubContext>({
    port: 0,
    address: "127.0.0.1",
    quiet: true,
    stopOnSignals: false,
    onAuthenticate: await createRoomAuthenticator({
      workspaceKeys: new Map([[WORKSPACE, TEST_SECRET]]),
      protocolVersion: SYNC_PROTOCOL_VERSION,
      log: silentLogger,
    }),
  });
  await localServer.listen();
});

afterEach(() => {
  for (const client of clients.splice(0)) client.destroy();
});

afterAll(async () => {
  try {
    await localServer?.destroy();
    await hub?.stop();
    removeTempDatabases();
  } finally { process.chdir(originalDirectory); }
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

describe("loopback admission is unchanged", () => {
  it("claiming a fresh hub changes no live admission decisions", async () => {
    let now = 1000;
    const fresh = await createHub({ authSecret: TEST_SECRET, databasePath: tempDatabasePath(), address: "127.0.0.1", port: 0,
      log: silentLogger, github: {
        clientId: "Iv1.0123456789abcdef", now: () => now,
        fetch: async (url) => Response.json(String(url) === "https://github.com/login/device/code"
          ? { device_code: "claim-private-code", user_code: "ABCD-EFGH", verification_uri: "https://github.com/login/device", expires_in: 900, interval: 1 }
          : String(url) === "https://github.com/login/oauth/access_token"
            ? { access_token: "claim-private-token", token_type: "bearer", scope: "" }
            : { id: 5678, login: "claiming-account" }),
      },
    }, { initializeDefaultWorkspace: true });
    try {
      const post = (path: string, body: unknown) => fetch(`http://127.0.0.1:${fresh.port}${path}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      const pending = await (await post("/auth/github/start", {})).json() as Awaited<ReturnType<GithubSignIn["start"]>>;
      if (pending.status !== "pending") throw new Error("sign-in did not start");
      now += 1000;
      const claimed = await (await post("/auth/github/collect", {
        requestId: pending.requestId, collectionSecret: pending.collectionSecret,
      })).json() as SignInCollection;
      if (claimed.status !== "complete" || claimed.claimedWorkspaceId === undefined) throw new Error("hub was not claimed");
      const workspace = claimed.claimedWorkspaceId;
      const room = testRoom(workspace);
      const rootToken = await token("read-write", { workspace, sub: randomUUID() });
      const rootClient = connect(fresh.port, workspace, rootToken, room);
      await rootClient.synced;
      rootClient.text.insert(0, "claim still uses root admission");
      const observer = connect(fresh.port, workspace, rootToken, room);
      await observer.synced;
      await waitForText("claimed-hub observer", observer.text, "claim still uses root admission");
      const deviceToken = await mintToken(await importCredentialKey(Buffer.from(claimed.credential.key, "base64url")), {
        typ: "room", sub: claimed.identity.id, workspace, scope: "read-write", kid: claimed.credential.record.id,
        lifetimeSeconds: MAX_TOKEN_LIFETIME_SECONDS,
      });
      await expect(connect(fresh.port, workspace, deviceToken).denied).resolves.toBe("invalid-token");
    } finally { await fresh.stop(); }
  });

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
