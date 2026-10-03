/**
 * Device-credential admission, deliberately absent from createHub and ub open.
 * Compose this extension with HubDatabase and the same CredentialRegistry
 * and MembershipRegistry used by issuance and management. The coordinated client cutover owns
 * installing it on remote hubs. It never accepts the legacy root key.
 */
import type {
  Connection,
  Extension,
  Hocuspocus,
  beforeHandleMessagePayload,
  beforeSyncPayload,
  connectedPayload,
  onAuthenticatePayload,
} from "@hocuspocus/server";
import { parseRoom } from "@uberblick/schema";
import type { CredentialRegistry } from "./credentials.js";
import type { HubLogger } from "./log.js";
import type { MembershipRegistry } from "./memberships.js";
import { protocolMismatchReason, readAuthEnvelope } from "./protocol.js";
import { resolvePeer, TOKEN_QUERY_PARAMS } from "./server.js";

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

export class CredentialAdmission implements Extension<CredentialContext> {
  private readonly instances = new Set<Hocuspocus<CredentialContext>>();
  private readonly connections = new Set<Connection<CredentialContext>>();
  private readonly unsubscribe: () => void;

  constructor(
    private readonly registry: CredentialRegistry,
    private readonly memberships: MembershipRegistry,
    private readonly options: { protocolVersion: number; log: HubLogger },
  ) {
    const unsubscribeRevoke = registry.onRevoke((id) => {
      this.closeWhere((context) => context.credentialId === id);
    });
    const unsubscribeRemove = memberships.onRemove((workspace, principalId) => {
      this.closeWhere((context) =>
        context.workspace === workspace && context.principalId === principalId);
    });
    this.unsubscribe = () => {
      unsubscribeRevoke();
      unsubscribeRemove();
    };
  }

  onAuthenticate = async ({
    documentName,
    token,
    requestHeaders,
    requestParameters,
    connectionConfig,
    instance,
  }: onAuthenticatePayload<CredentialContext>): Promise<CredentialContext> => {
    const peer = resolvePeer(requestHeaders);
    const refuse = (cause: string, reason?: string): never => {
      // No client claims, token, signature or key material in diagnostic output.
      this.options.log({ event: "hub.auth.rejected", peer: peer.address, cause });
      throw new CredentialRefusal(reason);
    };
    if (TOKEN_QUERY_PARAMS.some((key) => requestParameters.has(key))) {
      return refuse("token-in-query");
    }
    const envelope = readAuthEnvelope(token);
    if (
      envelope === null ||
      envelope.protocolVersion !== this.options.protocolVersion
    ) {
      return refuse(
        "protocol-mismatch",
        protocolMismatchReason(this.options.protocolVersion),
      );
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
    if (record.replacedAt !== null) return refuse("replaced-credential");
    const workspace = workspaceOf(documentName);
    if (workspace === null || workspace !== verified.claims.workspace) {
      return refuse("workspace-mismatch");
    }
    if (!record.workspaces.includes(workspace)) {
      return refuse("workspace-not-authorized");
    }
    // Read membership after verification's last await, from the same authority
    // management mutates. Neither token claims nor a cached role grant access.
    if (this.memberships.roleFor(workspace, record.principalId) === null) {
      return refuse("missing-membership");
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
    this.options.log({
      event: "hub.auth.accepted", credentialId: record.id, workspace,
    });
    return context;
  };

  connected = async ({
    connection, documentName,
  }: connectedPayload<CredentialContext>): Promise<void> => {
    this.check(connection, documentName);
  };

  beforeHandleMessage = async ({
    connection, documentName,
  }: beforeHandleMessagePayload<CredentialContext>): Promise<void> => {
    this.check(connection, documentName);
  };

  beforeSync = async ({
    connection, documentName,
  }: beforeSyncPayload<CredentialContext>): Promise<void> => {
    this.check(connection, documentName);
  };

  onDestroy = async (): Promise<void> => {
    this.unsubscribe();
    this.instances.clear();
    this.connections.clear();
  };

  /**
   * Close selected admitted rooms, reusable for workspace membership removal.
   * Callers must first change the backing authority so authentication and
   * message checks refuse that access, including admissions still in flight.
   * The latch and readOnly flag are set synchronously before closing any room;
   * closing alone leaves in-flight loops and queued frames alive.
   */
  closeWhere(predicate: (context: CredentialContext) => boolean): void {
    const candidates = new Set(this.connections);
    for (const instance of this.instances) {
      for (const document of instance.documents.values()) {
        for (const connection of document.getConnections()) {
          candidates.add(connection);
        }
      }
    }
    const connections: Connection<CredentialContext>[] = [];
    for (const connection of candidates) {
      if (predicate(connection.context)) {
        connection.context.authorization.active = false;
        // MessageReceiver checks this *after* awaiting beforeSync and
        // immediately before both Yjs apply branches. This also fences a
        // frame whose authorization check passed before revocation.
        connection.readOnly = true;
        connections.push(connection);
      }
    }
    for (const connection of connections) {
      connection.close({ code: 4403, reason: "invalid-token" });
    }
  }

  private check(connection: Connection<CredentialContext>, room: string): void {
    this.track(connection);
    const context = connection.context;
    const record = this.registry.get(context.credentialId);
    const workspace = workspaceOf(room);
    const cause = record === null
      ? "unknown-credential"
      : record.revokedAt !== null
        ? "revoked-credential"
        : record.replacedAt !== null
          ? "replaced-credential"
          : workspace === null ||
                workspace !== context.workspace ||
                !record.workspaces.includes(workspace)
            ? "workspace-mismatch"
            : this.memberships.roleFor(workspace, record.principalId) === null
              ? "missing-membership"
              : !context.authorization.active
                ? "access-ended"
                : null;
    if (cause !== null) {
      context.authorization.active = false;
      connection.readOnly = true;
      connection.close({ code: 4403, reason: "invalid-token" });
      this.options.log({ event: "hub.auth.rejected", cause });
      throw new CredentialRefusal();
    }
  }

  private track(connection: Connection<CredentialContext>): void {
    if (this.connections.has(connection)) return;
    this.connections.add(connection);
    const release = (): void => {
      // A room detached before revocation may still have an in-flight frame.
      // Keep its apply fence reachable until Hocuspocus finishes that loop.
      void connection.waitForPendingMessages().then(() => {
        this.connections.delete(connection);
      });
    };
    if (connection.document.hasConnection(connection)) {
      connection.onClose(release);
    } else {
      release();
    }
  }
}

function workspaceOf(room: string): string | null {
  try {
    return parseRoom(room).workspaceId;
  } catch {
    return null;
  }
}
