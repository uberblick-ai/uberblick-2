/**
 * How `extension-sqlite.sqlite` was made. Kept so the fixture is reproducible.
 *
 * It was run once, on the commit that still used `@hocuspocus/extension-sqlite`
 * and its better-sqlite3 binding, from the repo root — through `mise exec`, the
 * toolchain entry point, like everything else here:
 *
 *   mise exec -- pnpm --filter @uberblick/hub exec tsx \
 *     test/fixtures/make-legacy.ts test/fixtures/extension-sqlite.sqlite
 *
 * (The target path is relative to the package, which is where `pnpm exec` runs.)
 *
 * It writes the row the way the extension wrote it: the extension's own
 * exported `schema` and `upsertQuery`, run through better-sqlite3, holding
 * `Y.encodeStateAsUpdate(doc)` — Yjs v1. Nothing here is the hub's code, which
 * is the point: the committed file is what a hub of that generation left on
 * disk, and `persistence.test.ts` opens it with no migration.
 *
 * Do not re-run it here. Both the extension and better-sqlite3 are gone from
 * the tree, so this script no longer resolves; regenerate only from a checkout
 * that still has them. The committed file is the artefact, this is its recipe.
 */

import { rmSync } from "node:fs";
import BetterSqlite3 from "better-sqlite3";
import { schema, upsertQuery } from "@hocuspocus/extension-sqlite";
import * as Y from "yjs";

const target = process.argv[2];
if (target === undefined) {
  throw new Error("usage: make-legacy.ts <path>");
}
rmSync(target, { force: true });

/** The test workspace and a fixed document uuid: a room like any other. */
const ROOM = "3f6a1c20-9d84-4b1e-8a77-2c5e9b0d4411/6c0f2b48-1d5a-4c73-9f2e-8b41d7a90e35";
const TEXT_KEY = "body";
const TEXT = "written by the sqlite extension";

const doc = new Y.Doc();
doc.getText(TEXT_KEY).insert(0, TEXT);

const database = new BetterSqlite3(target);
database.exec(schema);
database.prepare(upsertQuery).run({
  name: ROOM,
  data: Buffer.from(Y.encodeStateAsUpdate(doc)),
});
database.close();
