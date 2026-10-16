import { OutgoingMessage, type Connection, type Hocuspocus, type ServerConfiguration } from "@hocuspocus/server";
import { DOC_DELETED_REASON } from "@uberblick/schema/protocol";
import type { HubDatabase } from "./persistence.js";
import type { HubContext } from "./server.js";

/** Room-local fences cover detached frames as well as current connections. */
export class DeletedRooms {
  private readonly stores = new Set<Promise<unknown>>();
  private readonly connections = new Set<Connection<HubContext>>();

  constructor(
    private readonly database: HubDatabase,
    private readonly hocuspocus: () => Hocuspocus<HubContext>,
  ) {
    database.onDeleteRooms(rooms => this.remove(rooms));
  }

  hooks(): Pick<ServerConfiguration<HubContext>, "afterLoadDocument" | "beforeHandleMessage" | "beforeSync"> {
    return {
      afterLoadDocument: async ({ documentName }) => { this.database.requireRoom(documentName); },
      beforeHandleMessage: async ({ documentName, connection }) => { this.requireRoom(documentName, connection); },
      beforeSync: async ({ documentName, connection }) => { this.requireRoom(documentName, connection); },
    };
  }

  requireRoom(room: string, connection: Connection<HubContext>): void {
    if (!this.connections.has(connection)) {
      this.connections.add(connection);
      const release = (): void => {
        // A detached room can retain a frame paused inside another hook.
        void connection.waitForPendingMessages().then(() => this.connections.delete(connection));
      };
      if (connection.document.hasConnection(connection)) connection.onClose(release);
      else release();
    }
    if (!this.database.isDeletedRoom(room)) return;
    this.refuse(connection);
    this.database.requireRoom(room);
  }

  async flush(): Promise<void> {
    await Promise.all(this.stores);
  }

  private refuse(connection: Connection<HubContext>): void {
    connection.readOnly = true;
    // Permission-denied is addressed to this room, including on a shared socket.
    connection.send(new OutgoingMessage(connection.messageAddress)
      .writePermissionDenied(DOC_DELETED_REASON).toUint8Array());
    connection.close({ code: 1000, reason: DOC_DELETED_REASON });
  }

  private remove(rooms: readonly string[]): void {
    const hocuspocus = this.hocuspocus();
    for (const room of rooms) {
      const document = hocuspocus.documents.get(room);
      const connections = new Set([...this.connections].filter(connection => connection.document.name === room));
      for (const connection of document?.getConnections() ?? []) connections.add(connection);
      // The receiver checks readOnly after awaiting every beforeSync hook;
      // closing alone leaves its pending and queued messages able to apply.
      for (const connection of connections) connection.readOnly = true;
      for (const connection of connections) this.refuse(connection);
      if (document === undefined) continue;
      const pending = hocuspocus.storeDocumentHooks(document, {
        instance: hocuspocus,
        clientsCount: 0,
        document,
        documentName: room,
        lastContext: {},
        lastTransactionOrigin: null,
      }, true);
      this.stores.add(pending);
      void pending.then(() => this.stores.delete(pending), () => this.stores.delete(pending));
      hocuspocus.documents.delete(room);
      document.destroy();
    }
  }
}
