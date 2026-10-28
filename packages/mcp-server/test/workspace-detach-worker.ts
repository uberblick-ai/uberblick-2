import { detachWorkspaceCopy } from "../src/store.js";

const [path, workspace] = process.argv.slice(2);
if (path === undefined || workspace === undefined) throw new Error("database and workspace are required");
detachWorkspaceCopy(path, workspace, () => {});
