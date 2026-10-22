// Run with the repository's tsx; see 2031-document-revisions.md.
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute, join } from "node:path";
import { readDeviceLogin } from "../../packages/mcp-server/src/device-login.ts";
import { importCredentialKey, mintToken } from "../../packages/schema/src/token.ts";
import { wrapToken } from "../../packages/schema/src/protocol.ts";
import { listDirectory } from "../../packages/schema/src/directory.ts";
import { getBlocks } from "../../packages/schema/src/blocks.ts";

const require = createRequire(new URL("../../packages/mcp-server/package.json", import.meta.url));
const Y = await import(require.resolve("yjs").replace("yjs.cjs", "yjs.mjs"));
const { HocuspocusProvider, HocuspocusProviderWebsocket } = await import(
  require.resolve("@hocuspocus/provider").replace(".cjs", ".esm.js"));
const { Awareness } = await import(require.resolve("y-protocols/awareness").replace("dist/awareness.cjs", "awareness.js"));
const [endpoint, workspace, output] = process.argv.slice(2);
if (!endpoint || !workspace || !output || !isAbsolute(output)) {
  throw new Error("Usage: tsx docs/spikes/2031-capture.mjs WSS_ENDPOINT WORKSPACE_UUID ABSOLUTE_PRIVATE_OUTPUT");
}
mkdirSync(output, { recursive: true, mode: 0o700 });
const login = readDeviceLogin(endpoint, workspace);
if (login.status !== "ready") throw new Error(`Stored login unavailable: ${login.status}`);
const key = await importCredentialKey(Buffer.from(login.login.credential.key, "base64url"));
const socket = new HocuspocusProviderWebsocket({ url: endpoint, autoConnect: false });
const deadline = setTimeout(() => {
  console.error("Capture exceeded its five-minute deadline");
  socket.destroy();
  process.exitCode = 1;
}, 300_000);

async function readRoom(uuid) {
  const doc = new Y.Doc({ gc: true });
  const awareness = new Awareness(doc);
  awareness.setLocalState(null);
  let provider;
  let timer;
  try {
    await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Read deadline: ${uuid}`)), 20_000);
      provider = new HocuspocusProvider({
        websocketProvider: socket, name: `${workspace}/${uuid}`, document: doc, awareness,
        token: async () => wrapToken(await mintToken(key, {
          typ: "room", sub: "revision-spike-read-only", workspace, scope: "read-only",
          kid: login.login.credential.record.id, lifetimeSeconds: 900,
        })),
        onAuthenticated: ({ scope }) => {
          if (scope !== "readonly") reject(new Error("Hub did not confirm read-only admission"));
        },
        onSynced: ({ state }) => { if (state) resolve(); },
        onAuthenticationFailed: () => reject(new Error(`Room admission refused: ${uuid}`)),
      });
      provider.attach();
    });
    return doc;
  } catch (error) {
    doc.destroy();
    throw error;
  } finally {
    clearTimeout(timer);
    provider?.destroy();
    awareness.destroy();
  }
}

try {
  void socket.connect();
  const directory = await readRoom("_directory");
  const entries = listDirectory(directory).filter(entry => entry.kind !== "decision");
  directory.destroy();
  const rows = [];
  for (const entry of entries) {
    const doc = await readRoom(entry.uuid);
    try {
      const state = Y.encodeStateAsUpdate(doc);
      const blocks = getBlocks(doc);
      const kinds = {};
      for (const block of blocks) kinds[block.type] = (kinds[block.type] ?? 0) + 1;
      writeFileSync(join(output, `${entry.uuid}.yjs`), state, { mode: 0o600, flag: "wx" });
      rows.push({ uuid: entry.uuid, title: entry.title, bytes: state.length,
        sha256: createHash("sha256").update(state).digest("hex"), blocks: blocks.length, kinds });
    } finally { doc.destroy(); }
  }
  rows.sort((a, b) => b.bytes - a.bytes || a.uuid.localeCompare(b.uuid));
  const manifest = { capturedAt: new Date().toISOString(), source: "hub read-only room sync into empty gc:true Y.Doc",
    scope: "live regular documents", rows };
  writeFileSync(join(output, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  console.log(JSON.stringify(manifest, null, 2));
} finally {
  clearTimeout(deadline);
  socket.destroy();
}
