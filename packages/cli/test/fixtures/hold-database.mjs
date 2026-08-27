// Holds a real SQLite connection open, the way a running MCP server or hub
// does, so a test can prove `ub storage migrate` refuses rather than copying a
// database out from under a live process.
//
//   node hold-database.mjs <path>
//
// Prints "open" once the connection is established and a read has been made —
// which is when SQLite actually holds the WAL locks — then waits to be killed.

import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync(process.argv[2]);
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA busy_timeout = 5000");
db.prepare("SELECT count(*) FROM sqlite_schema").get();

process.stdout.write("open\n");
// Nothing else to do: the connection is the point, and the parent kills us.
setInterval(() => {}, 1_000);
