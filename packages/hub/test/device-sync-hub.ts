/**
 * Test-only composition for exercising stored-login remote clients. Keeping
 * issuance, admission and renewal here preserves the hub-only authority seam;
 * no live server entry point imports this fixture.
 */
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { Server, type Connection, type onAuthenticatePayload } from "@hocuspocus/server";
import * as Y from "yjs";
import type { StoredHubLogin } from "../../mcp-server/src/auth-store.js";
import { CredentialAdmission, type CredentialContext } from "../src/credential-admission.js";
import { handleCredentialRenewal } from "../src/credential-renewal.js";
import { CredentialRegistry } from "../src/credentials.js";
import type { HubLogRecord } from "../src/log.js";
import { MembershipRegistry } from "../src/memberships.js";
import { HubAdminRegistry } from "../src/hub-admins.js";
import { HubDatabase } from "../src/persistence.js";
import { readAuthEnvelope, SYNC_PROTOCOL_VERSION } from "@uberblick/schema/protocol";
import type { TokenClaims } from "@uberblick/schema/token";
import { issueCredential } from "./device-credentials.js";
import { getUpdateAttribution, OriginUpdates, resolveUpdateAuthor, type UpdateAttribution } from "../src/update-attribution.js";

export type { UpdateAttribution } from "../src/update-attribution.js";

export interface DeviceSyncChange {
  room: string;
  attribution: UpdateAttribution | null;
}

export interface DeviceSyncAuthentication {
  room: string;
  /** Private fixture observations, never emitted by the client or hub logger. */
  token: string;
  protocolVersion: number | null;
  claims: TokenClaims | null;
}

export interface DeviceSyncRenewalReply {
  status: number;
  body?: unknown;
  raw?: string;
  location?: string;
}

/** The caller owns the directory and removes it after close(). */
export async function startDeviceSyncHub(options: {
  directory: string;
  protocolVersion?: number;
}) {
  const protocolVersion = options.protocolVersion ?? SYNC_PROTOCOL_VERSION;
  const database = new HubDatabase(join(options.directory, "credential-hub.sqlite"), (error) => { throw error; });
  database.open();
  const readStoredRoom = database.connection.prepare("SELECT data FROM documents WHERE name = ?");
  const credentials = new CredentialRegistry(database);
  const memberships = new MembershipRegistry(database);
  const admins = new HubAdminRegistry(database);
  const principalId = randomUUID();
  const adminId = randomUUID();
  admins.grant(adminId);
  const logs: HubLogRecord[] = [];
  const authentications: DeviceSyncAuthentication[] = [];
  const changes: DeviceSyncChange[] = [];
  let server: Server<CredentialContext> | undefined;
  let port = 0;
  let renewalCount = 0;
  let renewalReply: DeviceSyncRenewalReply | null = null;
  let renewalDelayMs = 0;
  let closed = false;
  /** Pending renewal delays, ended by close() so no caller waits one out. */
  const delays = new Set<() => void>();
  const messageReleases = new Set<() => void>();
  let nextMessage: { room: string; entered(): void; released: Promise<void> } | null = null;

  const log = (record: HubLogRecord): void => { logs.push(record); };
  const captureAuthentication = async ({ documentName, token }: onAuthenticatePayload<CredentialContext>): Promise<void> => {
    const envelope = readAuthEnvelope(token);
    let claims: TokenClaims | null = null;
    if (envelope !== null) {
      try {
        claims = JSON.parse(Buffer.from(envelope.token.split(".")[0] ?? "", "base64url").toString("utf8")) as TokenClaims;
      } catch { /* A malformed token is still useful as an arrival observation. */ }
    }
    authentications.push({ room: documentName, token,
      protocolVersion: envelope?.protocolVersion ?? null, claims });
  };

  async function resume(): Promise<void> {
    if (closed) throw new Error("device sync test hub is closed");
    if (server !== undefined) return;
    const admission = new CredentialAdmission(credentials, memberships, { protocolVersion, log }, admins);
    const originUpdates = new OriginUpdates({
      requireMetadata: true,
      assertCurrent(connection, room) {
        admission.assertCurrent(connection as Connection<CredentialContext>, room);
        database.requireRoom(room);
      },
      resolveAuthor(context, origin) { return resolveUpdateAuthor(context, credentials, origin); },
    });
    const candidate = new Server<CredentialContext>({
      address: "127.0.0.1", port, quiet: true, stopOnSignals: false,
      debounce: 10, maxDebounce: 50,
      extensions: [{ priority: 1_000, onAuthenticate: captureAuthentication }, database, admission, originUpdates, {
        priority: -1_000,
        async beforeHandleMessage({ documentName }) {
          if (nextMessage?.room !== documentName) return;
          const gate = nextMessage;
          nextMessage = null;
          gate.entered();
          await gate.released;
        },
      }],
      async onChange({ documentName, transactionOrigin }) {
        changes.push({ room: documentName, attribution: getUpdateAttribution(transactionOrigin) });
      },
      async onRequest({ request, response }) {
        if (request.url !== "/auth/credential/renew") return;
        renewalCount += 1;
        if (renewalDelayMs > 0) {
          await new Promise<void>((resolve) => {
            const end = (): void => { clearTimeout(timer); delays.delete(end); resolve(); };
            const timer = setTimeout(end, renewalDelayMs);
            delays.add(end);
          });
          if (closed) {
            response.destroy();
            return Promise.reject();
          }
        }
        if (renewalReply !== null) {
          response.writeHead(renewalReply.status, {
            "Content-Type": "application/json", "Cache-Control": "no-store",
            ...(renewalReply.location === undefined ? {} : { Location: renewalReply.location }),
          });
          response.end(renewalReply.raw ?? JSON.stringify(renewalReply.body ?? {}));
          return Promise.reject();
        }
        await handleCredentialRenewal(credentials, memberships, protocolVersion, log, request, response);
        return Promise.reject();
      },
    });
    try {
      await candidate.listen();
      port = candidate.address.port;
      server = candidate;
    } catch (error) {
      await candidate.destroy();
      throw error;
    }
  }

  async function pause(): Promise<void> {
    const current = server;
    server = undefined;
    if (current !== undefined) await current.destroy();
  }

  try { await resume(); }
  catch (error) { database.close(); throw error; }

  return {
    get origin(): string { return `http://127.0.0.1:${port}`; },
    get url(): string { return `ws://127.0.0.1:${port}`; },
    get port(): number { return port; },
    get renewalCount(): number { return renewalCount; },
    principalId, logs, authentications, changes,
    holdNextMessage(room: string): { entered: Promise<void>; release(): void } {
      let arrived = (): void => {};
      let end = (): void => {};
      const entered = new Promise<void>(resolve => { arrived = resolve; });
      const released = new Promise<void>(resolve => { end = resolve; });
      const release = (): void => { messageReleases.delete(release); end(); };
      messageReleases.add(release);
      nextMessage = { room, entered: arrived, released };
      return { entered, release };
    },
    issue(request: { workspaces: string[]; principalId?: string; deviceId?: string }): StoredHubLogin {
      const issued = issueCredential(credentials, {
        workspaces: request.workspaces,
        principalId: request.principalId ?? principalId,
        deviceId: request.deviceId ?? randomUUID(),
      });
      const { replacedAt: _replacedAt, ...record } = issued.record;
      return {
        identity: { id: record.principalId, githubAccountId: "12345", githubUsername: "device-sync-person" },
        credential: { record, key: Buffer.from(issued.keyBytes).toString("base64url") },
      };
    },
    grant(workspaceId: string, memberId: string = principalId): void {
      if (memberships.roleFor(workspaceId, adminId) === null) memberships.grant({ workspaceId, principalId: adminId, role: "admin" });
      if (memberships.roleFor(workspaceId, memberId) === null) memberships.grant({ workspaceId, principalId: memberId, role: "member" });
    },
    removeMembership(workspaceId: string, memberId = principalId): void {
      memberships.remove({ workspaceId, principalId: memberId });
    },
    changeRole(workspaceId: string, role: "admin" | "member", memberId = principalId): void {
      memberships.changeRole({ workspaceId, principalId: memberId, role });
    },
    revoke(credentialId: string): void { credentials.revoke(credentialId); },
    setWorkspaceStatus(workspaceId: string, status: "active" | "suspended"): void {
      admins.setWorkspaceStatus(workspaceId, status);
    },
    setRenewalReply(reply: DeviceSyncRenewalReply | null): void { renewalReply = reply; },
    setRenewalDelay(ms: number): void { renewalDelayMs = ms; },
    closeConnections(): void { server?.hocuspocus.closeConnections(); },
    readRoom<T>(room: string, read: (document: Y.Doc) => T): T | undefined {
      const live = server?.hocuspocus.documents.get(room);
      if (live !== undefined) return read(live);
      // Rooms unload after their last connection leaves; persisted state remains observable.
      const data = readStoredRoom.get(room)?.data;
      if (!(data instanceof Uint8Array)) return undefined;
      const document = new Y.Doc();
      try {
        Y.applyUpdate(document, data);
        return read(document);
      } finally { document.destroy(); }
    },
    pause, resume,
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      for (const end of [...delays]) end();
      for (const release of [...messageReleases]) release();
      try { await pause(); } finally { database.close(); }
    },
  };
}
