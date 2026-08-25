/**
 * How `better-sqlite3.sqlite` was made. Kept so the fixture is reproducible.
 *
 * It was run once, on the commit that still used better-sqlite3, from the repo
 * root — through `mise exec`, the toolchain entry point, like everything else
 * here:
 *
 *   mise exec -- pnpm --filter @uberblick/mcp-server exec tsx \
 *     test/fixtures/make-legacy.ts test/fixtures/better-sqlite3.sqlite
 *
 * (The target path is relative to the package, which is where `pnpm exec` runs.)
 *
 * Do not re-run it here. `MirrorStore` speaks `node:sqlite` now, so it would
 * overwrite the fixture with bytes from the new binding and quietly turn the
 * back-compat test into a tautology. Regenerate only from a checkout that still
 * has the old binding — the committed file is the artefact, this is its recipe.
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
// The room key exactly as the old binding wrote it, back when a workspace id
// was a name. The store treats room keys as opaque, and the committed fixture
// is a historical artefact: this string must not be modernised, or it would
// stop reproducing the file it exists to reproduce.
const ROOM = `main/${UUID}`;

const store = new MirrorStore(target);

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

store.indexDoc({
  uuid: UUID,
  title: "Written by better-sqlite3",
  tags: ["legacy"],
  links: [OTHER],
  body: "seeded by the old binding\nappended after the snapshot",
});

store.close();
