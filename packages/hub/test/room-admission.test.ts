import type { onAuthenticatePayload } from "@hocuspocus/server";
import { MAX_ROOM_NAME_LENGTH } from "@uberblick/schema";
import { SYNC_PROTOCOL_VERSION } from "@uberblick/schema/protocol";
import { describe, expect, it, vi } from "vitest";
import { CredentialAdmission, type CredentialContext } from "../src/credential-admission.js";
import { CredentialRegistry } from "../src/credentials.js";
import type { HubLogRecord } from "../src/log.js";
import { MembershipRegistry } from "../src/memberships.js";
import { HubDatabase } from "../src/persistence.js";
import { createHub, createRoomAuthenticator, type HubContext } from "../src/server.js";
import { createClient, TEST_SECRET, token, WORKSPACE } from "./helpers.js";

const INVALID_ROOMS = [
  "a".repeat(MAX_ROOM_NAME_LENGTH + 1),
  `${WORKSPACE}/forged\n{"event":"hub.auth.accepted"}`,
  `${WORKSPACE}/space name`,
  `${WORKSPACE}/back\\slash`,
];

/** A throwing getter proves rejection happens before the callback reads the token. */
function uncheckedPayload<Context>(documentName: string) {
  const readToken = vi.fn(() => { throw new Error("token was read before name rejection"); });
  const payload = {
    documentName,
    get token() { return readToken(); },
    requestHeaders: new Headers(),
    requestParameters: new URLSearchParams(),
    connectionConfig: {},
  } as unknown as onAuthenticatePayload<Context>;
  return { payload, readToken };
}

describe("bounded room admission", () => {
  it.each(["local signing key", "remote device credentials", "sign-in not configured"])(
    "rejects invalid names before reading the token: %s",
    async (path) => {
      const records: HubLogRecord[] = [];
      const log = (record: HubLogRecord) => records.push(record);
      let authenticate: (payload: onAuthenticatePayload<HubContext>) => Promise<unknown>;
      let close: () => Promise<void> = async () => {};
      if (path === "local signing key") {
        authenticate = await createRoomAuthenticator({ authSecret: TEST_SECRET,
          protocolVersion: SYNC_PROTOCOL_VERSION, log });
      } else if (path === "remote device credentials") {
        const database = new HubDatabase(":memory:", error => { throw error; });
        database.open();
        const admission = new CredentialAdmission(new CredentialRegistry(database),
          new MembershipRegistry(database), { protocolVersion: SYNC_PROTOCOL_VERSION, log });
        authenticate = payload => admission.onAuthenticate(payload as onAuthenticatePayload<CredentialContext>);
        close = async () => { await admission.onDestroy(); database.close(); };
      } else {
        const hub = await createHub({ port: 0, address: "127.0.0.1", databasePath: ":memory:", log },
          { deviceCredentials: true });
        const callback = hub.hocuspocus.configuration.onAuthenticate;
        if (callback === undefined) throw new Error("missing unconfigured admission callback");
        authenticate = async payload => callback(payload);
        close = () => hub.stop();
      }

      try {
        for (const room of INVALID_ROOMS) {
          const { payload, readToken } = uncheckedPayload<HubContext>(room);
          await expect(authenticate(payload)).rejects.toMatchObject({ reason: "room-name-invalid" });
          expect(readToken).not.toHaveBeenCalled();
          const record = records.at(-1);
          expect(record).toMatchObject({ event: "hub.auth.rejected", cause: "room-name-invalid" });
          expect(record).not.toHaveProperty("room");
          expect(JSON.stringify(record)).not.toContain(room);
        }
      } finally {
        await close();
      }
    },
  );

  it("syncs current and legacy names, including a name at the length bound", async () => {
    const hub = await createHub({ port: 0, address: "127.0.0.1", databasePath: ":memory:",
      authSecret: TEST_SECRET, log: () => {} });
    const clients = [];
    try {
      const presented = await token("read-write");
      for (const suffix of ["abcdef01-2345-4678-89ab-cdef01234567",
        "ABCDEF01-2345-4678-89AB-CDEF01234567", "_directory", "_sidebar", "_settings", "_feedback",
        "a".repeat(MAX_ROOM_NAME_LENGTH - WORKSPACE.length - 1)]) {
        const client = createClient({ port: hub.port, room: `${WORKSPACE}/${suffix}`, token: presented });
        clients.push(client);
        await client.synced;
      }
    } finally {
      for (const client of clients) client.destroy();
      await hub.stop();
    }
  });
});
