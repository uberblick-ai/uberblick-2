import { DatabaseSync } from "node:sqlite";
import { getWorkspaceName, settingsRoom } from "@uberblick/schema";
import * as Y from "yjs";
import { afterAll, expect, it } from "vitest";
import { PersistenceError } from "../src/replica.js";
import { storeWorkspaceName } from "../src/workspace-settings.js";
import { removeTempDirs, tempDatabasePath, testConfig } from "./helpers.js";

afterAll(removeTempDirs);

it("reports a refused settings append and leaves the durable name unchanged", () => {
  const config = testConfig({ databasePath: tempDatabasePath() });
  storeWorkspaceName(config, "Before");
  const db = new DatabaseSync(config.databasePath);
  const doc = new Y.Doc();
  try {
    db.exec(`
      CREATE TRIGGER refuse_settings BEFORE INSERT ON updates
      WHEN NEW.room LIKE '%/_settings'
      BEGIN SELECT RAISE(ABORT, 'settings log refused'); END;
    `);
    expect(() => storeWorkspaceName(config, "After")).toThrow(PersistenceError);
    const room = settingsRoom(config.workspaceId);
    for (const row of db.prepare("SELECT payload FROM updates WHERE room = ? ORDER BY seq").all(room)) {
      Y.applyUpdate(doc, new Uint8Array(row.payload as Uint8Array));
    }
    expect(getWorkspaceName(doc)).toBe("Before");
    expect(db.prepare("SELECT DISTINCT room FROM updates").all()).toEqual([{ room }]);
  } finally {
    doc.destroy();
    db.close();
  }
});
