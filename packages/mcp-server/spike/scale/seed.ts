/**
 * Scale probe — corpus seeder.
 *
 * Builds D real documents with the schema package's own helpers, then writes
 * each one's `Y.encodeStateAsUpdate` into a hub SQLite file in exactly the
 * shape `packages/hub/src/persistence.ts` writes (`documents(name, data)`).
 * That is the one shortcut in the probe: the documents are real and the rows
 * are the hub's own, but they were not created through `create_doc`, because
 * 2000 tool-call round trips would cost more probe time than they inform.
 *
 * Usage: tsx seed.ts <hub-sqlite-path> <documentCount>
 */

import { DatabaseSync } from "node:sqlite";
import { appendBlock, initDoc, upsertDirectoryEntry } from "@uberblick/schema";
import * as Y from "yjs";
import { corpusUuids, DIRECTORY_ROOM, roomOf } from "./common.js";

const LOREM =
  "The replica engine hydrates every room from the append-only update log and " +
  "never from the hub, which is what makes the offline path the default path " +
  "rather than a fallback nobody exercises. Sync is background work.";

function buildDocument(uuid: string, index: number): Y.Doc {
  const doc = new Y.Doc();
  initDoc(doc, {
    uuid,
    title: `Scale probe document ${index}`,
    tags: ["probe", index % 2 === 0 ? "even" : "odd"],
    description: `Synthetic document ${index} for the fan-in scale probe.`,
  });
  appendBlock(doc, { type: "heading", text: `Scale probe document ${index}`, level: 1 });
  for (let paragraph = 0; paragraph < 18; paragraph += 1) {
    appendBlock(doc, {
      type: "paragraph",
      text: `${paragraph}. ${LOREM} (document ${index}, paragraph ${paragraph})`,
    });
  }
  appendBlock(doc, {
    type: "code",
    language: "ts",
    text: `export const marker${index} = ${index};\nconst rooms = corpus.map((uuid) => roomOf(uuid));`,
  });
  for (let item = 0; item < 4; item += 1) {
    appendBlock(doc, {
      type: "list-item",
      text: `List item ${item} of document ${index}`,
      list: "bullet",
      indent: 0,
    });
  }
  appendBlock(doc, {
    type: "table",
    text: "| Question | Instrument |\n| --- | --- |\n| Fan-in | hub RSS |",
  });
  // The block the propagation probe edits, last so its id is findable by text.
  appendBlock(doc, { type: "paragraph", text: "PROBE-MARKER-SLOT" });
  return doc;
}

function main(): void {
  const [databasePath, countRaw] = process.argv.slice(2);
  if (databasePath === undefined || countRaw === undefined) {
    throw new Error("usage: seed.ts <hub-sqlite-path> <documentCount>");
  }
  const count = Number(countRaw);
  const started = Date.now();

  const db = new DatabaseSync(databasePath, { timeout: 5_000 });
  db.exec(
    `CREATE TABLE IF NOT EXISTS "documents" ("name" varchar(255) NOT NULL, "data" blob NOT NULL, UNIQUE(name))`,
  );
  const upsert = db.prepare(
    `INSERT INTO "documents" ("name", "data") VALUES ($name, $data)
       ON CONFLICT(name) DO UPDATE SET data = $data`,
  );

  const directory = new Y.Doc();
  const uuids = corpusUuids(count);
  let totalBytes = 0;

  db.exec("BEGIN");
  for (const [index, uuid] of uuids.entries()) {
    const doc = buildDocument(uuid, index);
    const state = Y.encodeStateAsUpdate(doc);
    totalBytes += state.byteLength;
    upsert.run({ name: roomOf(uuid), data: state });
    upsertDirectoryEntry(directory, {
      uuid,
      title: `Scale probe document ${index}`,
      tags: ["probe", index % 2 === 0 ? "even" : "odd"],
      description: `Synthetic document ${index} for the fan-in scale probe.`,
      createdAt: started,
      updatedAt: started,
    });
    doc.destroy();
  }
  const directoryState = Y.encodeStateAsUpdate(directory);
  upsert.run({ name: DIRECTORY_ROOM, data: directoryState });
  db.exec("COMMIT");
  db.close();

  process.stdout.write(
    `${JSON.stringify({
      documents: count,
      meanDocumentBytes: Math.round(totalBytes / Math.max(1, count)),
      directoryBytes: directoryState.byteLength,
      corpusBytes: totalBytes,
      seconds: (Date.now() - started) / 1000,
    })}\n`,
  );
}

main();
