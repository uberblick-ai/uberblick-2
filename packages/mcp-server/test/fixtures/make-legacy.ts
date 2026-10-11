/**
 * Regenerate better-sqlite3.sqlite only in a checkout using better-sqlite3;
 * running with node:sqlite would turn compatibility coverage into a tautology.
 * From the repo root, the target path is relative to the package:
 *
 *   mise exec -- pnpm --filter @uberblick/mcp-server exec tsx \
 *     test/fixtures/make-legacy.ts test/fixtures/better-sqlite3.sqlite
 *
 */

import { rmSync } from "node:fs";
import * as Y from "yjs";
import { appendBlock, initDoc } from "@uberblick/schema";
import { MirrorStore } from "../../src/store.js";

const target = process.argv[2];
if (target === undefined) {
  throw new Error("usage: make-legacy.ts <path>");
}
rmSync(target, { force: true });

const UUID = "3f2b0a6c-8b1e-4a55-9c47-0d5d1e6b7a90";
const OTHER = "9a1c7d2e-4f60-4b18-8f3a-2c5e9b0d6c11";
// Preserve the fixture's opaque room key to reproduce its bytes.
const ROOM = `main/${UUID}`;

// Keep the named workspace for the fixture's opaque room keys.
const store = new MirrorStore(target, "main");

// A snapshot plus a live tail, so the fixture exercises both BLOB columns.
const doc = new Y.Doc();
initDoc(doc, { uuid: UUID, title: "Written by better-sqlite3", tags: ["legacy"] });
appendBlock(doc, { type: "paragraph", text: "seeded by the old binding" });
store.appendUpdate(ROOM, Y.encodeStateAsUpdate(doc), "remote");
store.compact(ROOM, Y.encodeStateAsUpdate(doc), 1);

const tail = new Y.Doc();
Y.applyUpdate(tail, Y.encodeStateAsUpdate(doc));
const updates: Uint8Array[] = [];
tail.on("update", (update: Uint8Array) => updates.push(update));
appendBlock(tail, { type: "paragraph", text: "appended after the snapshot" });
for (const update of updates) {
  store.appendUpdate(ROOM, update, "local");
}

store.indexDoc(
  {
    uuid: UUID,
    title: "Written by better-sqlite3",
    tags: ["legacy"],
    description: "",
    links: [OTHER],
    body: "seeded by the old binding\nappended after the snapshot",
  },
  2,
);

store.close();
