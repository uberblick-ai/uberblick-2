/**
 * Test-only composition for clients built ahead of the remote cutover. Keeping
 * issuance, admission and renewal here preserves the hub-only authority seam;
 * no live server entry point imports this fixture.
 */
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { Server, type onAuthenticatePayload } from "@hocuspocus/server";
import type * as Y from "yjs";
import type { StoredHubLogin } from "../src/auth-store.js";
import { CredentialAdmission, type CredentialContext } from "../src/credential-admission.js";
import { handleCredentialRenewal } from "../src/credential-renewal.js";
import { CredentialRegistry } from "../src/credentials.js";
import type { HubLogRecord } from "../src/log.js";
import { MembershipRegistry } from "../src/memberships.js";
import { HubDatabase } from "../src/persistence.js";
import { readAuthEnvelope, SYNC_PROTOCOL_VERSION } from "../src/protocol.js";
import type { TokenClaims } from "../src/token.js";

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
  const credentials = new CredentialRegistry(database);
  const memberships = new MembershipRegistry(database);
  const principalId = randomUUID();
  const adminId = randomUUID();
  const logs: HubLogRecord[] = [];
  const authentications: DeviceSyncAuthentication[] = [];
  let server: Server<CredentialContext> | undefined;
  let port = 0;
  let renewalCount = 0;
  let renewalReply: DeviceSyncRenewalReply | null = null;
  let renewalDelayMs = 0;
  let closed = false;

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
    const admission = new CredentialAdmission(credentials, memberships, { protocolVersion, log });
    const candidate = new Server<CredentialContext>({
      address: "127.0.0.1", port, quiet: true, stopOnSignals: false,
      debounce: 10, maxDebounce: 50,
      extensions: [{ priority: 1_000, onAuthenticate: captureAuthentication }, database, admission],
      async onRequest({ request, response }) {
        if (request.url !== "/auth/credential/renew") return;
        renewalCount += 1;
        if (renewalDelayMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, renewalDelayMs));
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
    principalId, logs, authentications,
    issue(request: { workspaces: string[]; principalId?: string; deviceId?: string }): StoredHubLogin {
      const issued = credentials.issue({
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
    grant(workspaceId: string, memberId = principalId): void {
      if (memberships.roleFor(workspaceId, adminId) === null) memberships.grant({ workspaceId, principalId: adminId, role: "admin" });
      if (memberships.roleFor(workspaceId, memberId) === null) memberships.grant({ workspaceId, principalId: memberId, role: "member" });
    },
    removeMembership(workspaceId: string, memberId = principalId): void {
      memberships.remove({ workspaceId, principalId: memberId, actorPrincipalId: adminId });
    },
    revoke(credentialId: string): void { credentials.revoke(credentialId); },
    setRenewalReply(reply: DeviceSyncRenewalReply | null): void { renewalReply = reply; },
    setRenewalDelay(ms: number): void { renewalDelayMs = ms; },
    closeConnections(): void { server?.hocuspocus.closeConnections(); },
    readRoom(room: string): Y.Doc | undefined { return server?.hocuspocus.documents.get(room); },
    pause, resume,
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      try { await pause(); } finally { database.close(); }
    },
  };
}
