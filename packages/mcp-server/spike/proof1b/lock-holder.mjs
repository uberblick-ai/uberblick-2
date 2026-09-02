// Hold the SQLite write lock on a store for N ms from a separate process.
import { DatabaseSync } from "node:sqlite";
const [path, ms] = process.argv.slice(2);
const db = new DatabaseSync(path);
db.exec("PRAGMA busy_timeout = 5000");
db.exec("BEGIN IMMEDIATE");
process.stdout.write("locked\n");
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(ms));
db.exec("COMMIT");
db.close();
process.stdout.write("released\n");
