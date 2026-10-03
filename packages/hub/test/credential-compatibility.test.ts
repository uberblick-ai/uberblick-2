/** Credential and membership admission stay unwired until the client cutover. */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createConnection } from "node:net";
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
let renewedToken: string;
const clients: TestClient[] = [];

beforeAll(async () => {
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
  issuedToken = await mintToken(await importCredentialKey(Buffer.from(collected.credential.key, "base64url")), {
    typ: "room",
    sub: collected.identity.id,
    workspace: WORKSPACE,
    scope: "read-write",
    kid: collected.credential.record.id,
    lifetimeSeconds: MAX_TOKEN_LIFETIME_SECONDS,
  });
  const renewalProof = await mintRequestProof(await importCredentialKey(Buffer.from(collected.credential.key, "base64url")), {
    kid: collected.credential.record.id,
    operation: "renew-credential",
    lifetimeSeconds: MAX_TOKEN_LIFETIME_SECONDS,
  });
  const renewed = await (await post("/auth/credential/renew", {
    protocolVersion: SYNC_PROTOCOL_VERSION,
    token: renewalProof,
  })).json() as { status: string; credential?: typeof collected.credential };
  if (renewed.status !== "complete" || renewed.credential === undefined) throw new Error("renewal did not complete");
  expect(renewed.credential.record).toMatchObject({
    principalId: collected.credential.record.principalId,
    deviceId: collected.credential.record.deviceId,
    workspaces: [WORKSPACE],
  });
  expect(renewed.credential.record.id).not.toBe(collected.credential.record.id);
  renewedToken = await mintToken(await importCredentialKey(Buffer.from(renewed.credential.key, "base64url")), {
    typ: "room",
    sub: collected.identity.id,
    workspace: WORKSPACE,
    scope: "read-write",
    kid: renewed.credential.record.id,
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

  it.each(["issued", "renewed"] as const)("the live hub refuses a token signed under an %s credential", async (kind) => {
    const client = connect(hub.port, WORKSPACE, kind === "issued" ? issuedToken : renewedToken);
    await expect(client.denied).resolves.toBe("invalid-token");
  });

  it.each(["issued", "renewed"] as const)("the local authenticator refuses a token signed under an %s credential", async (kind) => {
    const client = connect(localServer.address.port, WORKSPACE, kind === "issued" ? issuedToken : renewedToken);
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
