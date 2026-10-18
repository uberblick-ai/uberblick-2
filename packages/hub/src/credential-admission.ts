import type {
  Connection,
  Extension,
  Hocuspocus,
  beforeHandleMessagePayload,
  beforeSyncPayload,
  connectedPayload,
  onAuthenticatePayload,
} from "@hocuspocus/server";
import { isRoomNameWithinBounds, parseRoom, settingsRoom } from "@uberblick/schema";
import type { CredentialRecord, CredentialRegistry } from "./credentials.js";
import type { HubLogger } from "./log.js";
import type { MembershipRegistry } from "./memberships.js";
import type { HubAdminRegistry } from "./hub-admins.js";
import { protocolMismatchReason, readAuthEnvelope } from "@uberblick/schema/protocol";
import { resolvePeer, TOKEN_QUERY_PARAMS } from "./server.js";

export interface CredentialContext {
  credentialId: string;
  principalId: string;
  deviceId: string;
  workspaces: readonly string[];
  workspace: string;
  /** Shared across Hocuspocus' context copies, never populated by a client. */
  authorization: { active: boolean; readOnly: boolean };
}

class CredentialRefusal extends Error {
  constructor(readonly reason = "device-credential-refused") {
    super("credential access refused");
  }
}

export class CredentialAdmission implements Extension<CredentialContext> {
  // Share sign-in/renewal authority; remote admission never accepts the root key.
  // Loopback and ub open use their separate local admission paths.
  private readonly instances = new Set<Hocuspocus<CredentialContext>>();
  private readonly connections = new Set<Connection<CredentialContext>>();
  private readonly expiryTimers = new Map<Connection<CredentialContext>, ReturnType<typeof setTimeout>>();
  private readonly unsubscribe: () => void;

  constructor(
    private readonly registry: CredentialRegistry,
    private readonly memberships: MembershipRegistry,
    private readonly options: { protocolVersion: number; log: HubLogger },
    private readonly hubAdmins?: HubAdminRegistry,
  ) {
    const unsubscribeRevoke = registry.onRevoke((id) => {
      this.closeWhere((context) => context.credentialId === id);
    });
    const unsubscribeRemove = memberships.onRemove((workspace, principalId) => {
      this.closeWhere((context) =>
        context.workspace === workspace && context.principalId === principalId);
    });
    const unsubscribeRole = memberships.onRoleChange((workspace, principalId, role) => {
      if (role === "admin") return;
      for (const connection of this.allConnections()) {
        if (connection.context.workspace === workspace &&
            connection.context.principalId === principalId &&
            connection.document.name === settingsRoom(workspace)) {
          // A later hook may already be awaiting before the receiver applies.
          connection.readOnly = true;
        }
      }
    });
    const unsubscribeSuspend = hubAdmins?.onSuspend(workspace => {
      this.closeWhere(context => context.workspace === workspace);
    });
    this.unsubscribe = () => {
      unsubscribeRevoke();
      unsubscribeRemove();
      unsubscribeRole();
      unsubscribeSuspend?.();
    };
  }

  onAuthenticate = async (payload: onAuthenticatePayload<CredentialContext>): Promise<CredentialContext> => {
    const { documentName, requestHeaders, requestParameters, connectionConfig, instance } = payload;
    const peer = resolvePeer(requestHeaders);
    const refuse = (cause: string, reason?: string): never => {
      // No client claims, token, signature or key material in diagnostic output.
      this.options.log({ event: "hub.auth.rejected", peer: peer.address, cause });
      throw new CredentialRefusal(reason);
    };
    if (!isRoomNameWithinBounds(documentName)) {
      return refuse("room-name-invalid", "room-name-invalid");
    }
    if (TOKEN_QUERY_PARAMS.some((key) => requestParameters.has(key))) {
      return refuse("token-in-query");
    }
    const envelope = readAuthEnvelope(payload.token);
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
    if (record === null || record.revokedAt !== null || record.replacedAt !== null) {
      return refuse(record !== null && record.replacedAt !== null ? "replaced-credential" : "revoked-credential");
    }
    if (this.registry.isExpired(record)) return refuse("expired-credential");
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
    if (this.hubAdmins?.isSuspended(workspace)) return refuse("workspace-suspended");
    const context: CredentialContext = {
      credentialId: record.id,
      principalId: record.principalId,
      deviceId: record.deviceId,
      workspaces: record.workspaces,
      workspace,
      authorization: { active: true, readOnly: verified.claims.scope === "read-only" },
    };
    connectionConfig.readOnly = context.authorization.readOnly ||
      (documentName === settingsRoom(workspace) &&
        this.memberships.roleFor(workspace, record.principalId) !== "admin");
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
    for (const timer of this.expiryTimers.values()) clearTimeout(timer);
    this.expiryTimers.clear();
    this.instances.clear();
    this.connections.clear();
  };

  /**
   * Change backing authority first to refuse in-flight admissions. Fence all
   * selected rooms synchronously before closing; closure alone leaves queued
   * frames and message loops able to apply updates.
   */
  closeWhere(predicate: (context: CredentialContext) => boolean): void {
    const connections: Connection<CredentialContext>[] = [];
    for (const connection of this.allConnections()) {
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
      connection.close({ code: 4403, reason: "device-credential-refused" });
    }
  }

  private allConnections(): Set<Connection<CredentialContext>> {
    const candidates = new Set(this.connections);
    for (const instance of this.instances) {
      for (const document of instance.documents.values()) {
        for (const connection of document.getConnections()) candidates.add(connection);
      }
    }
    return candidates;
  }

  private check(connection: Connection<CredentialContext>, room: string): void {
    this.track(connection);
    const context = connection.context;
    const record = this.registry.get(context.credentialId);
    const workspace = workspaceOf(room);
    const cause = this.credentialFailure(record) ??
      (record === null || workspace === null ||
              workspace !== context.workspace ||
              !record.workspaces.includes(workspace)
          ? "workspace-mismatch"
          : this.memberships.roleFor(workspace, record.principalId) === null
            ? "missing-membership"
            : this.hubAdmins?.isSuspended(workspace)
              ? "workspace-suspended"
            : !context.authorization.active
              ? "access-ended"
              : null);
    if (cause !== null) {
      context.authorization.active = false;
      connection.readOnly = true;
      connection.close({ code: 4403, reason: "device-credential-refused" });
      this.options.log({ event: "hub.auth.rejected", cause });
      throw new CredentialRefusal();
    }
    if (!this.expiryTimers.has(connection) && record !== null) {
      this.scheduleExpiry(connection, record);
    }
    if (room === settingsRoom(context.workspace)) {
      connection.readOnly = context.authorization.readOnly ||
        this.memberships.roleFor(context.workspace, context.principalId) !== "admin";
    }
  }

  private credentialFailure(record: CredentialRecord | null): string | null {
    if (record === null) return "unknown-credential";
    if (record.revokedAt !== null) return "revoked-credential";
    if (record.replacedAt !== null) return "replaced-credential";
    return this.registry.isExpired(record) ? "expired-credential" : null;
  }

  private scheduleExpiry(connection: Connection<CredentialContext>, record: CredentialRecord): void {
    // Thirty days exceeds Node's maximum timeout. Re-read the hub clock at
    // each bounded wake-up, including after the clock moves backwards.
    const delay = Math.min(Math.max(0, this.registry.remainingLifetime(record)), 2_147_483_647);
    const timer = setTimeout(() => {
      this.expiryTimers.delete(connection);
      if (this.registry.isExpired(record)) {
        this.closeWhere(context => context.credentialId === record.id);
      } else {
        this.scheduleExpiry(connection, record);
      }
    }, delay);
    timer.unref();
    this.expiryTimers.set(connection, timer);
  }

  private track(connection: Connection<CredentialContext>): void {
    if (this.connections.has(connection)) return;
    this.connections.add(connection);
    const release = (): void => {
      // A room detached before revocation may still have an in-flight frame.
      // Keep its apply fence reachable until Hocuspocus finishes that loop.
      void connection.waitForPendingMessages().then(() => {
        this.connections.delete(connection);
        const timer = this.expiryTimers.get(connection);
        if (timer !== undefined) clearTimeout(timer);
        this.expiryTimers.delete(connection);
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
