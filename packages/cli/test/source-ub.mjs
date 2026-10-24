import { fileURLToPath } from "node:url";
import { register } from "tsx/esm/api";

// Private-storage harnesses exercise their candidate, including MCP children.
const tsconfig = fileURLToPath(new URL("../tsconfig.json", import.meta.url));
process.env.TSX_TSCONFIG_PATH = tsconfig;
register({ tsconfig });
await import(new URL("../src/main.ts", import.meta.url).href);
