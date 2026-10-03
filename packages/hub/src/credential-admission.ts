/**
 * Device-credential admission, deliberately absent from createHub and ub open.
 * Compose this extension with HubDatabase; the coordinated client cutover owns
 * installing it on remote hubs. It never accepts the legacy root key.
 */
import type {
  Connection,
  ConnectionConfiguration,
  Extension,
  Hocuspocus,
  beforeHandleMessagePayload,
  beforeSyncPayload,
  connectedPayload,
  onAuthenticatePayload,
  onDisconnectPayload,
} from "@hocuspocus/server";
import { parseRoom } from "@uberblick/schema";
import type { CredentialRegistry } from "./credentials.js";
import type { HubLogger } from "./log.js";
import { protocolMismatchReason, readAuthEnvelope } from "./protocol.js";
import { resolvePeer } from "./server.js";

export interface CredentialContext {
  credentialId: string;
  principalId: string;
  deviceId: string;
  workspaces: readonly string[];
  workspace: string;
  /** Shared across Hocuspocus' context copies, never populated by a client. */
  authorization: { active: boolean };
}

class CredentialRefusal extends Error {
  constructor(readonly reason = "invalid-token") {
    super("credential access refused");
  }
}

interface PendingAdmission {
  context: CredentialContext;
  config: ConnectionConfiguration;
}

export class CredentialAdmission implements Extension<CredentialContext> {
  private readonly instances = new Set<Hocuspocus<CredentialContext>>();
  private readonly pending = new Map<string, PendingAdmission>();
  private readonly unsubscribe: () => void;

  constructor(
    private readonly registry: CredentialRegistry,
    private readonly options: { protocolVersion: number; log: HubLogger },
  ) {
    this.unsubscribe = registry.onRevoke((id) => {
      this.closeWhere((context) => context.credentialId === id);
    });
  }

  onAuthenticate = async ({
    documentName,
    token,
    requestHeaders,
    requestParameters,
    connectionConfig,
    socketId,
    instance,
  }: onAuthenticatePayload<CredentialContext>): Promise<CredentialContext> => {
    const peer = resolvePeer(requestHeaders);
    const refuse = (cause: string, reason?: string): never => {
      // No client claims, token, signature or key material in diagnostic output.
      this.options.log({ event: "hub.auth.rejected", peer: peer.address, cause });
      throw new CredentialRefusal(reason);
    };
    if (["token", "access_token", "auth", "authToken"].some((key) => requestParameters.has(key))) {
      return refuse("token-in-query");
    }
    const envelope = readAuthEnvelope(token);
    if (envelope === null || envelope.protocolVersion !== this.options.protocolVersion) {
      return refuse("protocol-mismatch", protocolMismatchReason(this.options.protocolVersion));
    }
    const verified = await this.registry.verify(envelope.token);
    if ("failure" in verified) {
      return refuse(verified.failure);
    }
    // verify includes WebCrypto awaits. Revocation can also land between its
    // resolution and this continuation, so admission reads authority again.
    const record = this.registry.get(verified.record.id);
    if (record === null || record.revokedAt !== null) {
      return refuse("revoked-credential");
    }
    const workspace = workspaceOf(documentName);
    if (workspace === null || workspace !== verified.claims.workspace) {
      return refuse("workspace-mismatch");
    }
    if (!record.workspaces.includes(workspace)) {
      return refuse("workspace-not-authorized");
    }
    const context: CredentialContext = {
      credentialId: record.id,
      principalId: record.principalId,
      deviceId: record.deviceId,
      workspaces: record.workspaces,
      workspace,
      authorization: { active: true },
    };
    connectionConfig.readOnly = verified.claims.scope === "read-only";
    this.instances.add(instance);
    this.pending.set(this.key(socketId, documentName), { context, config: connectionConfig });
    this.options.log({ event: "hub.auth.accepted", credentialId: record.id, workspace });
    return context;
  };

  connected = async ({ connection, socketId, documentName }: connectedPayload<CredentialContext>): Promise<void> => {
    this.pending.delete(this.key(socketId, documentName));
    this.check(connection, documentName);
  };

  beforeHandleMessage = async ({ connection, documentName }: beforeHandleMessagePayload<CredentialContext>): Promise<void> => {
    this.check(connection, documentName);
  };

  beforeSync = async ({ connection, documentName }: beforeSyncPayload<CredentialContext>): Promise<void> => {
    this.check(connection, documentName);
  };

  onDisconnect = async ({ socketId, documentName }: onDisconnectPayload<CredentialContext>): Promise<void> => {
    this.pending.delete(this.key(socketId, documentName));
  };

  onDestroy = async (): Promise<void> => {
    this.unsubscribe();
    this.pending.clear();
    this.instances.clear();
  };

  /**
   * End selected access, reusable for workspace membership removal. The latch
   * and readOnly flag are set synchronously before closing any room. Closing
   * alone leaves Hocuspocus' in-flight loop and queued frames alive.
   */
  closeWhere(predicate: (context: CredentialContext) => boolean): void {
    for (const { context, config } of this.pending.values()) {
      if (predicate(context)) {
        context.authorization.active = false;
        // A connection still loading its document inherits this fence.
        config.readOnly = true;
      }
    }
    const connections: Connection<CredentialContext>[] = [];
    for (const instance of this.instances) {
      for (const document of instance.documents.values()) {
        for (const connection of document.getConnections()) {
          if (predicate(connection.context)) {
            connection.context.authorization.active = false;
            // MessageReceiver checks this *after* awaiting beforeSync and
            // immediately before both Yjs apply branches. This also fences a
            // frame whose authorization check passed before revocation.
            connection.readOnly = true;
            connections.push(connection);
          }
        }
      }
    }
    for (const connection of connections) {
      connection.close({ code: 4403, reason: "invalid-token" });
    }
  }

  private check(connection: Connection<CredentialContext>, room: string): void {
    const context = connection.context;
    const record = this.registry.get(context.credentialId);
    const workspace = workspaceOf(room);
    const cause = record === null ? "unknown-credential"
      : record.revokedAt !== null ? "revoked-credential"
      : !context.authorization.active ? "access-ended"
      : workspace === null || workspace !== context.workspace || !record.workspaces.includes(workspace) ? "workspace-mismatch"
      : null;
    if (cause !== null) {
      context.authorization.active = false;
      connection.readOnly = true;
      connection.close({ code: 4403, reason: "invalid-token" });
      this.options.log({ event: "hub.auth.rejected", cause });
      throw new CredentialRefusal();
    }
  }

  private key(socketId: string, room: string): string {
    return `${socketId}/${room}`;
  }
}

function workspaceOf(room: string): string | null {
  try {
    return parseRoom(room).workspaceId;
  } catch {
    return null;
  }
}
