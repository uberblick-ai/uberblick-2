import type { Connection, Extension, beforeSyncPayload, onStatelessPayload } from "@hocuspocus/server";
import { encodeOriginAck, readOriginUpdate, type UpdateOriginMetadata } from "@uberblick/schema";
import { messageYjsSyncStep2, messageYjsUpdate } from "y-protocols/sync";
import * as Y from "yjs";
import type { CredentialContext } from "./credential-admission.js";
import type { CredentialRegistry } from "./credentials.js";
import type { HubContext } from "./server.js";

export interface UpdateAuthor {
  principalId: string;
  surface: { kind: string; name: string };
}

export interface UpdateAttribution {
  updateId: string;
  author: UpdateAuthor | null;
  deliveredBy: { principalId: string; credentialId: string; deviceId: string };
}

interface AttributedTransactionOrigin {
  source: "connection";
  connection: Connection<HubContext>;
  attribution: UpdateAttribution | null;
}

/** The attribution belongs to this application, rather than mutable connection state. */
export function getUpdateAttribution(origin: unknown): UpdateAttribution | null {
  if (typeof origin !== "object" || origin === null || !("attribution" in origin)) return null;
  return (origin as AttributedTransactionOrigin).attribution ?? null;
}

/** Historical metadata only confirms the currently verified delivering account and device. */
export function resolveUpdateAuthor(
  context: CredentialContext,
  registry: CredentialRegistry,
  origin: UpdateOriginMetadata | null,
): UpdateAuthor | null {
  if (origin?.credentialId === null || origin?.credentialId === undefined || origin.surface === null) return null;
  const historical = registry.get(origin.credentialId);
  if (historical === null || historical.revokedAt !== null ||
      historical.principalId !== context.principalId || historical.deviceId !== context.deviceId) return null;
  return { principalId: context.principalId, surface: { ...origin.surface } };
}

export interface OriginUpdatesOptions {
  assertCurrent(connection: Connection<HubContext>, room: string): void;
  resolveAuthor(context: CredentialContext, origin: UpdateOriginMetadata | null): UpdateAuthor | null;
  requireMetadata: boolean;
}

/** Exact durable rows travel independently of the provider's merged sync response. */
export class OriginUpdates implements Extension<HubContext> {
  constructor(private readonly options: OriginUpdatesOptions) {}

  beforeSync = async ({ type, document, payload }: beforeSyncPayload<HubContext>): Promise<void> => {
    if (!this.options.requireMetadata || (type !== messageYjsSyncStep2 && type !== messageYjsUpdate)) return;
    if (!Y.snapshotContainsUpdate(Y.snapshot(document), payload)) {
      throw { reason: "origin-metadata-required" };
    }
  };

  onStateless = async ({ connection, document, documentName, payload }: onStatelessPayload): Promise<void> => {
    const envelope = readOriginUpdate(payload);
    if (envelope === null) return;
    let applied = false;
    try {
      // Hocuspocus does not await stateless hooks. Keep the authority check and
      // application synchronous so no revoke or following frame can intervene.
      this.options.assertCurrent(connection, documentName);
      if (connection.readOnly) {
        applied = Y.snapshotContainsUpdate(Y.snapshot(document), envelope.update);
      } else {
        const context: HubContext = connection.context;
        // Yjs can integrate buffered operations in this transaction. They may
        // belong to a different surface, so the combined change stays unknown.
        const hadPending = document.store.pendingStructs !== null || document.store.pendingDs !== null;
        const attribution: UpdateAttribution | null = "principalId" in context ? {
          updateId: envelope.updateId,
          author: hadPending ? null : this.options.resolveAuthor(context, envelope.origin),
          deliveredBy: { principalId: context.principalId, credentialId: context.credentialId, deviceId: context.deviceId },
        } : null;
        const origin: AttributedTransactionOrigin = { source: "connection", connection, attribution };
        Y.applyUpdate(document, envelope.update, origin);
        applied = true;
      }
    } catch {
      // Refused or malformed rows are not acknowledged; their sender keeps them.
    }
    connection.sendStateless(encodeOriginAck(envelope.updateId, applied));
  };
}
