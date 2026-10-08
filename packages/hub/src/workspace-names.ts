/** Optional credential display data; reading names never opens or stores rooms. */
import { getWorkspaceName, settingsRoom } from "@uberblick/schema";
import * as Y from "yjs";
import { sanitizeWorkspaceNames } from "./auth-store.js";
import type { CredentialRecord } from "./credentials.js";
import type { HubDatabase } from "./persistence.js";

const MAX_CREDENTIAL_REPLY_BYTES = 65_536;

export class WorkspaceNameReader {
  constructor(
    private readonly database: HubDatabase,
    private readonly loadedDocument: (room: string) => Y.Doc | undefined = () => undefined,
  ) {}

  read(workspaceId: string): string | null {
    let settings: Y.Doc | undefined;
    try {
      const room = settingsRoom(workspaceId);
      const loaded = this.loadedDocument(room);
      const bytes = loaded === undefined
        ? this.database.connection.prepare('SELECT data FROM documents WHERE name = ?').get(room)?.data
        : Y.encodeStateAsUpdate(loaded);
      if (!(bytes instanceof Uint8Array)) return null;
      // getWorkspaceName may create a missing root in its Y.Doc. Read an
      // isolated copy so even a loaded room stays entirely untouched.
      settings = new Y.Doc();
      Y.applyUpdate(settings, bytes);
      return getWorkspaceName(settings);
    } catch {
      // Display data cannot turn a successful issuance into a lost key.
      return null;
    } finally {
      settings?.destroy();
    }
  }
}

interface CredentialReply {
  credential: { record: CredentialRecord; key: string; workspaceNames?: Record<string, string> };
}

/** Preserve the full envelope and credential, adding names only while it fits. */
export function addWorkspaceNames<T extends CredentialReply>(
  reply: T,
  reader: WorkspaceNameReader,
  collectionSecret?: string,
): T {
  try {
    const baseBytes = Buffer.byteLength(JSON.stringify(reply));
    let remaining = MAX_CREDENTIAL_REPLY_BYTES - baseBytes - Buffer.byteLength(',"workspaceNames":{}');
    if (remaining < 0) return reply;
    const workspaceNames: Record<string, string> = {};
    let count = 0;
    for (const workspaceId of reply.credential.record.workspaces) {
      let name: string | null;
      try {
        name = reader.read(workspaceId);
      } catch {
        continue;
      }
      const safe = sanitizeWorkspaceNames({ [workspaceId]: name }, [workspaceId], reply.credential.key, collectionSecret);
      const safeName = safe?.[workspaceId];
      if (safeName === undefined) continue;
      const bytes = Buffer.byteLength(`${JSON.stringify(workspaceId)}:${JSON.stringify(safeName)}`) + (count > 0 ? 1 : 0);
      if (bytes > remaining) continue;
      workspaceNames[workspaceId] = safeName;
      remaining -= bytes;
      count++;
    }
    return count === 0 ? reply : { ...reply, credential: { ...reply.credential, workspaceNames } };
  } catch {
    // Nothing after issue/renew may hide the only copy of a new device key.
    return reply;
  }
}
