import { randomUUID } from "node:crypto";
import { HocuspocusProvider } from "@hocuspocus/provider";
import {
  decisionDirectoryFields, directoryRoom, getDirectoryEntry, getMeta, roomForDoc,
  setKind, setStatus, setTldr, upsertDirectoryEntry,
} from "@uberblick/schema";
import type { DecisionStatus } from "@uberblick/schema";
import { importRootSecret, MAX_TOKEN_LIFETIME_SECONDS, mintToken } from "@uberblick/schema/token";
import { wrapToken } from "@uberblick/schema/protocol";
import * as Y from "yjs";
import type { Harness } from "./harness.js";

/** Older clients can still publish decision content that newer MCP writers refuse. */
export async function legacyDecisionPeer(
  harness: Harness,
  uuid: string,
): Promise<{
  doc: Y.Doc;
  directory: Y.Doc;
  join: (room: string) => Promise<Y.Doc>;
  decide: (status: DecisionStatus, tldr?: string | null) => void;
  close: () => void;
}> {
  const secret = await importRootSecret(harness.authSecret);
  const peers: Array<{ doc: Y.Doc; provider: HocuspocusProvider }> = [];
  const close = (): void => {
    for (const peer of peers) { peer.provider.destroy(); peer.doc.destroy(); }
  };
  const connect = async (room: string): Promise<Y.Doc> => {
    const doc = new Y.Doc();
    const provider = new HocuspocusProvider({
      url: harness.hubUrl, name: room, document: doc,
      token: async () => wrapToken(await mintToken(secret, {
        typ: "room", sub: randomUUID(), workspace: harness.workspaceUuid,
        scope: "read-write", kid: null, lifetimeSeconds: MAX_TOKEN_LIFETIME_SECONDS,
      })),
    });
    peers.push({ doc, provider });
    await new Promise<void>((resolve) => provider.on("synced", resolve));
    return doc;
  };
  try {
    const doc = await connect(roomForDoc(harness.workspaceUuid, uuid));
    const directory = await connect(directoryRoom(harness.workspaceUuid));
    return {
      doc, directory, join: connect, close,
      decide: (status, tldr) => {
        doc.transact(() => {
          setKind(doc, "decision");
          setStatus(doc, status);
          if (tldr !== undefined) setTldr(doc, tldr);
        });
        const meta = getMeta(doc);
        upsertDirectoryEntry(directory, {
          ...getDirectoryEntry(directory, uuid), uuid, title: meta.title,
          kind: "decision", status, ...decisionDirectoryFields(doc),
        });
      },
    };
  } catch (error) { close(); throw error; }
}
