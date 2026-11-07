import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendBlock, directoryRoom, findBlockElement, getBlocks, initDoc, roomForDoc, upsertDirectoryEntry } from "@uberblick/schema";
import { issueCredential } from "@uberblick/hub/test-device-credentials";
import { CredentialRegistry } from "../../hub/src/credentials.js";
import { HubAdminRegistry } from "../../hub/src/hub-admins.js";
import { MembershipRegistry } from "../../hub/src/memberships.js";
import { HubDatabase } from "../../hub/src/persistence.js";
import { PrincipalRegistry } from "../../hub/src/principals.js";
import type { StoredHubLogin } from "../src/auth-store.js";
import type { McpHostGrant } from "../src/host-token-check.js";
import * as Y from "yjs";

export interface FixtureDocument {
  uuid: string;
  bucket: string;
  blockId: string;
}

export interface Fixture {
  workspaces: { uuid: string; documents: FixtureDocument[] }[];
  grants: { token: string; grant: McpHostGrant; login: StoredHubLogin }[];
  profile: {
    description: string;
    documentsPerWorkspace: number;
    workspaces: number;
    principals: number;
    grants: number;
    visibleTextBytesPerWorkspace: number;
    editTransactionsPerWorkspace: number;
    revisionStretchesPerWorkspace: number;
    encodedRoomBytesPerWorkspace: number;
    retainedStructsPerWorkspace: number;
    preGcEncodedRoomBytesPerWorkspace: number;
    documentClasses: { count: number; textBytes: number; edits: number; stretches: number }[];
  };
}

const CLASSES = [
  { count: 120, textBytes: 1024, edits: 20, stretches: 10 },
  { count: 50, textBytes: 4096, edits: 100, stretches: 20 },
  { count: 25, textBytes: 16 * 1024, edits: 500, stretches: 50 },
  { count: 5, textBytes: 64 * 1024, edits: 500, stretches: 50 },
];
const BUCKETS = ["capacitybucketalpha", "capacitybucketbeta"] as const;
const WORDS = "Planning decisions connect requirements, interface details, implementation findings and operational examples. ";
const HOUR = 60 * 60 * 1000;

function sizedText(prefix: string, length: number): string {
  return `${prefix}${WORDS.repeat(Math.ceil(length / WORDS.length))}`.slice(0, length);
}

/** Seed only disposable fixture data; the measured hub uses its unchanged entry point. */
export async function prepareFixture(directory: string, grantCount: number): Promise<Fixture> {
  if (!Number.isInteger(grantCount) || grantCount < 1 || grantCount > 128) throw new Error("Fixture grants must be in 1..128");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  let clock = Date.now() - 7 * 24 * HOUR;
  const database = new HubDatabase(join(directory, "hub.sqlite"), error => { throw error; }, {
    revisions: true, now: () => clock, log: () => {},
  });
  database.open();
  const fixture: Fixture = {
    workspaces: [], grants: [],
    profile: {
      description: "Synthetic engineering workspace: 200 mixed prose, list and code documents, size distribution chosen to include a few long pages, with 20/100/500 actual Yjs edit transactions grouped into 10/20/50 durable hub revision stretches. No real document content is copied.",
      documentsPerWorkspace: 200, workspaces: 4, principals: 1, grants: grantCount,
      visibleTextBytesPerWorkspace: 0, editTransactionsPerWorkspace: 0, revisionStretchesPerWorkspace: 0,
      encodedRoomBytesPerWorkspace: 0, retainedStructsPerWorkspace: 0, preGcEncodedRoomBytesPerWorkspace: 0,
      documentClasses: CLASSES,
    },
  };
  try {
    // Preparation is outside every timing window and checkpointed before the hub starts.
    database.connection.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL");
    const principals = new PrincipalRegistry(database);
    const memberships = new MembershipRegistry(database);
    const admins = new HubAdminRegistry(database);
    const credentials = new CredentialRegistry(database, admins, () => {});
    const people = Array.from({ length: 8 }, (_, index) => principals.identify(String(900000 + index), `capacity-person-${index}`));
    const store = database.connection.prepare("INSERT INTO documents (name, data) VALUES (?, ?)");
    for (let workspaceIndex = 0; workspaceIndex < 4; workspaceIndex += 1) {
      const uuid = randomUUID();
      const directoryDocument = new Y.Doc();
      const documents: FixtureDocument[] = [];
      try {
        for (const [personIndex, person] of people.entries()) {
          memberships.grant({ workspaceId: uuid, principalId: person.id, role: personIndex === 0 ? "admin" : "member" });
        }
        for (const documentClass of CLASSES) {
          for (let item = 0; item < documentClass.count; item += 1) {
            const index = documents.length;
            const documentUuid = randomUUID();
            const bucket = BUCKETS[index < 100 ? 0 : 1];
            const title = `Capacity planning note ${index + 1}`;
            const description = "Synthetic requirements, implementation notes and operating examples for capacity measurement.";
            const source = new Y.Doc({ gc: false });
            const stored = new Y.Doc();
            const room = roomForDoc(uuid, documentUuid);
            const began = Date.now() - 7 * 24 * HOUR;
            clock = began;
            database.revisions.observe(room, stored);
            try {
              initDoc(source, { uuid: documentUuid, title, description });
              const blockCount = documentClass.textBytes === 1024 ? 1 : documentClass.textBytes === 4096 ? 4 : documentClass.textBytes === 16 * 1024 ? 8 : 16;
              let blockId = "";
              for (let block = 0; block < blockCount; block += 1) {
                const text = sizedText(block === 0 ? `${bucket} Document ${index + 1}. ` : `Section ${block + 1}. `, documentClass.textBytes / blockCount);
                const id = appendBlock(source, block % 3 === 1 ? { type: "list-item", text, list: "bullet" }
                  : block % 3 === 2 ? { type: "code", text, language: "text" } : { type: "paragraph", text });
                if (block === 0) blockId = id;
              }
              const element = findBlockElement(source, blockId);
              const text = element?.firstChild;
              if (!(text instanceof Y.XmlText)) throw new Error("Fixture paragraph has no editable text");
              let previous = Y.encodeStateVector(stored);
              const editsPerStretch = documentClass.edits / documentClass.stretches;
              for (let edit = 0; edit < documentClass.edits; edit += 1) {
                source.transact(() => {
                  const offset = 64 + (edit * 23) % (text.length - 128);
                  text.delete(offset, 64);
                  text.insert(offset, sizedText(`Revision ${String(edit + 1).padStart(4, "0")}. `, 64));
                });
                if ((edit + 1) % editsPerStretch === 0) {
                  clock = began + ((edit + 1) / editsPerStretch) * HOUR;
                  const author = people[Math.floor(edit / editsPerStretch) % people.length];
                  if (author === undefined) throw new Error("Missing fixture author");
                  Y.applyUpdate(stored, Y.encodeStateAsUpdate(source, previous), { attribution: {
                    author: { principalId: author.id,
                      surface: { kind: "web", name: "Capacity fixture editor" } },
                  } });
                  previous = Y.encodeStateVector(stored);
                }
              }
              const encoded = Y.encodeStateAsUpdate(stored);
              store.run(room, encoded);
              documents.push({ uuid: documentUuid, bucket, blockId });
              upsertDirectoryEntry(directoryDocument, { uuid: documentUuid, title, description, tags: [], createdAt: began,
                updatedAt: clock, openThreadCount: 0 });
              if (workspaceIndex === 0) {
                fixture.profile.visibleTextBytesPerWorkspace += getBlocks(stored).reduce((bytes, block) => bytes + Buffer.byteLength(block.text), 0);
                fixture.profile.editTransactionsPerWorkspace += documentClass.edits;
                fixture.profile.revisionStretchesPerWorkspace += database.revisions.list(room).length;
                fixture.profile.encodedRoomBytesPerWorkspace += encoded.length;
                fixture.profile.preGcEncodedRoomBytesPerWorkspace += Y.encodeStateAsUpdate(source).length;
                fixture.profile.retainedStructsPerWorkspace += [...stored.store.clients.values()].reduce((count, structs) => count + structs.length, 0);
              }
            } finally {
              source.destroy();
              stored.destroy();
            }
          }
        }
        store.run(directoryRoom(uuid), Y.encodeStateAsUpdate(directoryDocument));
        fixture.workspaces.push({ uuid, documents });
      } finally { directoryDocument.destroy(); }
    }
    for (let index = 0; index < grantCount; index += 1) {
      const person = people[0];
      const workspace = fixture.workspaces[index % fixture.workspaces.length]?.uuid;
      if (person === undefined || workspace === undefined) throw new Error("Missing fixture principal or workspace");
      const issued = issueCredential(credentials, { principalId: person.id, deviceId: randomUUID(), workspaces: [workspace] });
      const { replacedAt: _replacedAt, ...record } = issued.record;
      fixture.grants.push({
        token: `capacity-grant-${index}`,
        grant: { grantId: randomUUID(), principal: person.id, workspace, scope: "docs:read docs:write", expiresAt: Date.now() + 24 * HOUR },
        login: { identity: person, credential: { record, key: Buffer.from(issued.keyBytes).toString("base64url") } },
      });
    }
    database.connection.exec("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL");
  } finally { database.close(); }
  writeFileSync(join(directory, "fixture.json"), `${JSON.stringify(fixture, null, 2)}\n`, { mode: 0o600 });
  return fixture;
}
