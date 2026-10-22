// SPIKE (#2144): two MCP clients over Streamable HTTP against one gateway,
// a local hub, and an independent stdio-style replica that must see the writes.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createHub, silentLogger } from "@uberblick/hub";
import { createTagCatalogEntry, setTags } from "@uberblick/schema";
import { startHttpGateway } from "../src/http-gateway.js";
import { createMcpServer } from "../src/server.js";
import { LIVE_HUB_SETTLE, TEST_SECRET, testConfig } from "../test/shared.js";

const BEARER = "spike-token";
const dir = mkdtempSync(join(tmpdir(), "ub-spike-"));
const report: Record<string, unknown> = {};
const mb = () => Math.round(process.memoryUsage().rss / 1024 / 1024);

function payload(result: any): any {
  if (result.structuredContent !== undefined) return result.structuredContent;
  const text = result.content?.find((c: any) => c.type === "text")?.text;
  try { return JSON.parse(text); } catch { return text; }
}
async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result: any = await client.callTool({ name, arguments: args });
  return { isError: result.isError === true, body: payload(result) };
}
async function httpClient(url: string, name: string): Promise<Client> {
  const client = new Client({ name, version: "0.0.1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${BEARER}` } },
  }));
  return client;
}
async function until<T>(label: string, probe: () => Promise<T | undefined>, ms = 15_000): Promise<T> {
  const end = performance.now() + ms;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (performance.now() > end) throw new Error(`timed out: ${label}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

const hub = await createHub({
  authSecret: TEST_SECRET, port: 0, databasePath: join(dir, "hub.sqlite"), log: silentLogger,
  debounce: 20, maxDebounce: 200, shutdownTimeoutMs: 5_000,
});
const hubUrl = `ws://127.0.0.1:${hub.port}`;
const rssHubOnly = mb();

// The gateway: one replica set for the workspace, shared by every HTTP session.
let t = performance.now();
const gateway = await startHttpGateway({
  config: { ...testConfig({ hubUrl, authSecret: TEST_SECRET, databasePath: join(dir, "gateway.sqlite") }), ...LIVE_HUB_SETTLE },
  bearer: BEARER,
});
report.gatewayStartMs = Math.round(performance.now() - t);
report.rssMb = { hubOnly: rssHubOnly, withGateway: mb() };

// 1. No bearer: 401 with a WWW-Authenticate challenge.
const anonymous = await fetch(gateway.url, {
  method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "x", version: "0" } } }),
});
report.anonymous = { status: anonymous.status, challenge: anonymous.headers.get("www-authenticate") };

// 2. Two sessions over HTTP.
t = performance.now();
const alice = await httpClient(gateway.url, "client-a");
const tools = await alice.listTools();
report.firstToolsListMs = Math.round(performance.now() - t);
report.toolCount = tools.tools.length;
report.toolsListBytes = Buffer.byteLength(JSON.stringify(tools.tools));
const bob = await httpClient(gateway.url, "client-b");
report.sessions = gateway.sessions.size;

t = performance.now();
const created = await call(alice, "create_doc", {
  title: "Release checklist", description: "Steps to cut a release; spike fixture.",
  blocks: [{ type: "paragraph", text: "Tag the hub image after the client image." }],
});
report.createDoc = { isError: created.isError, ms: Math.round(performance.now() - t), applied: created.body?.applied, synced: created.body?.synced };
const uuid = created.body?.uuid;

const found = await call(bob, "search", { query: "release checklist" });
report.searchFromSecondSession = found.body?.hits?.map((h: any) => h.title);
const read = await call(bob, "get_doc", { uuid });
report.getDocFromSecondSession = { isError: read.isError, firstBlock: read.body?.blocks?.[0]?.text };

// 3. An independent local replica (as `ub mcp serve` on a laptop) sees the write through the hub.
const local = createMcpServer({ ...testConfig({ hubUrl, authSecret: TEST_SECRET, databasePath: join(dir, "laptop.sqlite") }), ...LIVE_HUB_SETTLE });
const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
await local.connect(serverSide);
const laptop = new Client({ name: "laptop", version: "0.0.1" });
await laptop.connect(clientSide);
t = performance.now();
const seen = await until("laptop sees the HTTP write", async () => {
  const listed = await call(laptop, "list_docs", {});
  return listed.body?.docs?.find((d: any) => d.uuid === uuid);
});
report.laptopSeesWriteMs = Math.round(performance.now() - t);
report.laptopSeesTitle = seen.title;

// And the other direction: a laptop write reaches the HTTP sessions.
const fromLaptop = await call(laptop, "create_doc", { title: "Written on a laptop", description: "Spike fixture from the stdio side." });
t = performance.now();
await until("HTTP session sees the laptop write", async () => {
  const listed = await call(alice, "list_docs", {});
  return listed.body?.docs?.find((d: any) => d.uuid === fromLaptop.body?.uuid);
});
report.httpSeesLaptopWriteMs = Math.round(performance.now() - t);

// 4. Guidance gate per session: tag a guidance page; only the session that read it may write.
const guide = await call(alice, "create_doc", { title: "Editorial guidance", description: "Read before writing; spike fixture." });
const marker = "5a7808ea-1c79-4330-af35-3f67f9f38a3b";
const replicas = gateway.workspace.replicas;
createTagCatalogEntry(replicas.settings().doc, "guidance", marker);
setTags(replicas.replica(guide.body.uuid).doc, [marker]);
const bobBefore = await call(bob, "create_doc", { title: "Bob before reading", description: "Should be refused." });
await call(alice, "get_doc", { uuid: guide.body.uuid });
const aliceAfter = await call(alice, "create_doc", { title: "Alice after reading", description: "Allowed." });
const bobStill = await call(bob, "create_doc", { title: "Bob still unread", description: "Should be refused." });
report.guidanceGate = {
  bobBeforeReading: bobBefore.body?.error ?? "applied",
  aliceAfterReading: aliceAfter.isError ? aliceAfter.body?.error : "applied",
  bobWhileAliceLeased: bobStill.body?.error ?? "applied",
};

// 5. Display name: shared replicas carry one agent name for all sessions.
report.agentNameAfterTwoSessions = (replicas as any).agentName ?? "(private)";

report.rssMb = { ...(report.rssMb as object), afterWork: mb() };

await alice.close(); await bob.close(); await laptop.close();
await local.close(); await gateway.close(); await hub.stop();
console.log(JSON.stringify(report, null, 2));
process.exit(0);
