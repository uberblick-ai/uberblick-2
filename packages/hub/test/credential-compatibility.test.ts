import { credentialPrivateKey, deviceFetch as fetch } from "./device-credentials.js";
import { mintDeviceRequestProof as mintRequestProof } from "./device-credentials.js";
/** Loopback admission retains the local shared-secret security model. */

import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { Server } from "@hocuspocus/server";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { GithubSignIn, SignInCollection } from "../src/github-sign-in.js";
import { silentLogger } from "../src/log.js";
import { SYNC_PROTOCOL_VERSION } from "@uberblick/schema/protocol";
import { createRoomAuthenticator, type HubContext } from "../src/server.js";
import { createTeamHub as createHub, type TeamHub as Hub } from "../src/team.js";
import { importCredentialKey, MAX_TOKEN_LIFETIME_SECONDS, mintToken } from "@uberblick/schema/token";
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
  // A private membership and device credential must not change root admission.
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
  const identity = hub.principals!.identify("1234", "compatibility-member");
  hub.memberships!.grant({ workspaceId: WORKSPACE, principalId: identity.id, role: "admin" });
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
  expect(collected.identity.id).toBe(identity.id);
  expect(collected.credential.record.workspaces).toEqual([WORKSPACE]);
  const proof = await mintRequestProof(await importCredentialKey(credentialPrivateKey(collected.credential.record)), {
    kid: collected.credential.record.id, operation: "renew-credential", lifetimeSeconds: 60,
  });
  const renewed = await (await post("/auth/credential/renew", { protocolVersion: SYNC_PROTOCOL_VERSION, token: proof })).json() as {
    status: string; credential: typeof collected.credential;
  };
  expect(renewed.status).toBe("renewed");
  expect(renewed.credential.record.deviceId).toBe(collected.credential.record.deviceId);
  issuedToken = await mintToken(await importCredentialKey(credentialPrivateKey(renewed.credential.record)), {
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
      const deviceToken = await mintToken(await importCredentialKey(credentialPrivateKey(claimed.credential.record)), {
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
