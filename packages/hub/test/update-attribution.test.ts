import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { CredentialRegistry } from "../src/credentials.js";
import { HubDatabase } from "../src/persistence.js";
import type { CredentialContext } from "../src/credential-admission.js";
import { getUpdateAttribution, OriginUpdates, resolveUpdateAuthor, type UpdateAttribution } from "../src/update-attribution.js";
import { encodeOriginUpdate, type UpdateOriginMetadata } from "@uberblick/schema";

const databases: HubDatabase[] = [];
const documents: Y.Doc[] = [];
afterEach(() => {
  for (const document of documents.splice(0)) document.destroy();
  for (const database of databases.splice(0)) database.close();
});

function document(): Y.Doc {
  const doc = new Y.Doc();
  documents.push(doc);
  return doc;
}

function registry(): CredentialRegistry {
  const database = new HubDatabase(":memory:", error => { throw error; });
  database.open();
  databases.push(database);
  return new CredentialRegistry(database);
}

function issue(credentials: CredentialRegistry, principalId = "person", deviceId = "computer") {
  return credentials.issue({ principalId, deviceId, workspaces: [], publicKey: new Uint8Array(32) }).record;
}

function context(credentialId: string): CredentialContext {
  return {
    credentialId, principalId: "person", deviceId: "computer", workspaces: [], workspace: "workspace",
    authorization: { active: true, readOnly: false },
  };
}

function metadata(credentialId: string): UpdateOriginMetadata {
  return { updateId: "original-update", credentialId, surface: { kind: "mcp", name: "Claude Code" } };
}

describe("origin credential consistency", () => {
  it("only confirms the delivering principal/device, and preserves declared surfaces", () => {
    const credentials = registry();
    const current = issue(credentials);
    const connection = context(current.id);
    expect(resolveUpdateAuthor(connection, credentials, metadata(current.id))).toEqual({
      principalId: "person", surface: { kind: "mcp", name: "Claude Code" },
    });
    for (const origin of [null, metadata("unknown"), metadata(issue(credentials, "other").id),
      metadata(issue(credentials, "person", "other-device").id)]) {
      expect(resolveUpdateAuthor(connection, credentials, origin)).toBeNull();
    }
    credentials.revoke(current.id);
    expect(resolveUpdateAuthor(connection, credentials, metadata(current.id))).toBeNull();
  });

  it("accepts historical replaced and expired IDs without making them admission authority", () => {
    const credentials = registry();
    const historical = issue(credentials);
    const current = issue(credentials);
    const database = databases[0];
    expect(database).toBeDefined();
    database?.connection.prepare("UPDATE hub_credentials SET replaced_at = ?, issued_at = ? WHERE id = ?")
      .run(Date.now(), 0, historical.id);
    const freshHistorical = credentials.get(historical.id);
    expect(credentials.usable(freshHistorical)).toEqual({ failure: "replaced-credential" });
    expect(resolveUpdateAuthor(context(current.id), credentials, metadata(historical.id))).toEqual({
      principalId: "person", surface: { kind: "mcp", name: "Claude Code" },
    });
    credentials.revoke(historical.id);
    expect(resolveUpdateAuthor(context(current.id), credentials, metadata(historical.id))).toBeNull();
  });
});

describe("causal per-update application", () => {
  function describeReceiver(hub: Y.Doc) {
    const attributions: Array<UpdateAttribution | null> = [];
    hub.on("update", (_update: Uint8Array, origin: unknown) => attributions.push(getUpdateAttribution(origin)));
    const extension = new OriginUpdates({
      requireMetadata: true,
      assertCurrent() {},
      resolveAuthor(connection, origin) {
        return origin?.surface === null || origin?.surface === undefined ? null : {
          principalId: connection.principalId, surface: origin.surface,
        };
      },
    });
    const connection = { context: context("credential"), readOnly: false, sendStateless() {} };
    return {
      attributions,
      async apply(update: Uint8Array, updateId: string) {
        const origin = { ...metadata("credential"), updateId };
        await extension.onStateless({ connection, document: hub, documentName: "room",
          payload: encodeOriginUpdate(updateId, update, origin) } as unknown as Parameters<OriginUpdates["onStateless"]>[0]);
      },
    };
  }

  it("keeps Yjs buffering and downgrades the application that combines authors", async () => {
    const first = document();
    const second = document();
    const hub = document();
    first.getText("text").insert(0, "first");
    const predecessor = Y.encodeStateAsUpdate(first);
    Y.applyUpdate(second, predecessor);
    const before = Y.encodeStateVector(second);
    second.getText("text").insert(5, " second");
    const successor = Y.encodeStateAsUpdate(second, before);
    const receiver = describeReceiver(hub);
    await receiver.apply(successor, "later-arriving-first");
    expect(receiver.attributions).toEqual([]);
    await receiver.apply(predecessor, "predecessor");
    expect(receiver.attributions).toMatchObject([{ author: null, deliveredBy: { principalId: "person" } }]);
    expect(hub.getText("text").toString()).toBe("first second");
    await receiver.apply(successor, "duplicate");
    expect(receiver.attributions).toHaveLength(1);
  });

  it("does not give buffered deletions the inserting update's author", async () => {
    const source = document();
    const hub = document();
    source.getText("text").insert(0, "first");
    const insertion = Y.encodeStateAsUpdate(source);
    const before = Y.encodeStateVector(source);
    source.getText("text").delete(0, 5);
    const deletion = Y.encodeStateAsUpdate(source, before);
    const receiver = describeReceiver(hub);
    await receiver.apply(deletion, "deletion");
    expect(receiver.attributions).toEqual([]);
    await receiver.apply(insertion, "insertion");
    expect(receiver.attributions).toMatchObject([{ author: null }]);
    expect(hub.getText("text").toString()).toBe("");
  });
});
