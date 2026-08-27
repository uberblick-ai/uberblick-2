// Writes rows into a WAL database and dies without closing it, the way a
// `kill -9`'d MCP server or hub leaves one: every row committed, and every row
// still in the `-wal` because no checkpoint ever ran.
//
//   node write-and-die.mjs <path> <rows>

import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync(process.argv[2]);
db.exec("PRAGMA journal_mode = WAL");
// No automatic checkpoint: the point of this fixture is a `-wal` that still
// holds everything.
db.exec("PRAGMA wal_autocheckpoint = 0");
db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
db.exec(
  "CREATE TABLE IF NOT EXISTS updates (seq INTEGER PRIMARY KEY AUTOINCREMENT, " +
    "room TEXT NOT NULL, payload BLOB NOT NULL)",
);
db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('workspace', ?)").run(
  process.argv[4],
);
const insert = db.prepare("INSERT INTO updates (room, payload) VALUES (?, ?)");
for (let i = 0; i < Number(process.argv[3]); i += 1) {
  insert.run(`room-${i}`, Buffer.from(`payload-${i}`));
}

process.kill(process.pid, "SIGKILL");
