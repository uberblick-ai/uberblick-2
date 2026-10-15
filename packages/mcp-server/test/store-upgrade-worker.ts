import { MirrorStore } from "../src/store.js";

const [databasePath, workspace, record] = process.argv.slice(2) as [string, string, string];
const store = new MirrorStore(databasePath, workspace);
store.indexDoc(JSON.parse(record), 2, 7);
store.close();
