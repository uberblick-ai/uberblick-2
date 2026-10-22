// SPIKE (#2144): marginal memory and start time per open replica set (one per workspace or per person).
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createHub, silentLogger } from "@uberblick/hub";
import { startHttpGateway, type HttpGateway } from "../src/http-gateway.js";
import { LIVE_HUB_SETTLE, TEST_SECRET, testConfig } from "../test/shared.js";

const DOCS = Number(process.argv[2] ?? 50);
const SETS = Number(process.argv[3] ?? 10);
const dir = mkdtempSync(join(tmpdir(), "ub-spike-mem-"));
const gc = () => (globalThis as any).gc?.();
const mb = () => { gc(); return Math.round(process.memoryUsage().rss / 1024 / 1024); };
const text = "A paragraph of ordinary corpus prose, about the length people write. ".repeat(6);

const hub = await createHub({ authSecret: TEST_SECRET, port: 0, databasePath: join(dir, "hub.sqlite"), log: silentLogger, debounce: 20, maxDebounce: 200, shutdownTimeoutMs: 5_000 });
const hubUrl = `ws://127.0.0.1:${hub.port}`;
const gateways: HttpGateway[] = [];
const rows: unknown[] = [];
const base = mb();
for (let i = 0; i < SETS; i += 1) {
  const workspaceId = randomUUID();
  const t = performance.now();
  const gateway = await startHttpGateway({
    config: { ...testConfig({ hubUrl, authSecret: TEST_SECRET, workspaceId, databasePath: join(dir, `${workspaceId}.sqlite`) }), ...LIVE_HUB_SETTLE },
    bearer: "b",
  });
  const startMs = Math.round(performance.now() - t);
  const client = new Client({ name: `c${i}`, version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(gateway.url), { requestInit: { headers: { Authorization: "Bearer b" } } }));
  for (let d = 0; d < DOCS; d += 1) {
    await client.callTool({ name: "create_doc", arguments: { title: `Doc ${d}`, description: "Memory fixture.",
      blocks: Array.from({ length: 8 }, () => ({ type: "paragraph", text })) } });
  }
  await client.close();
  gateways.push(gateway);
  rows.push({ sets: i + 1, startMs, rssMb: mb() });
}
// Cold start: a fresh mirror for a workspace whose documents already live on the hub.
const coldWorkspace = (gateways[0] as any).workspace.replicas.config.workspaceId as string;
let t0 = performance.now();
const cold = await startHttpGateway({
  config: { ...testConfig({ hubUrl, authSecret: TEST_SECRET, workspaceId: coldWorkspace, databasePath: join(dir, "cold.sqlite") }), ...LIVE_HUB_SETTLE },
  bearer: "b",
});
const coldStartMs = Math.round(performance.now() - t0);
const coldClient = new Client({ name: "cold", version: "0" });
await coldClient.connect(new StreamableHTTPClientTransport(new URL(cold.url), { requestInit: { headers: { Authorization: "Bearer b" } } }));
let listed = 0;
for (;;) {
  const r: any = await coldClient.callTool({ name: "list_docs", arguments: {} });
  listed = (r.structuredContent?.docs ?? []).length;
  if (listed >= DOCS || performance.now() - t0 > 30_000) break;
  await new Promise((res) => setTimeout(res, 50));
}
const coldAllListedMs = Math.round(performance.now() - t0);
const s: any = await coldClient.callTool({ name: "search", arguments: { query: "ordinary corpus prose" } });
await coldClient.close(); gateways.push(cold);
console.log(JSON.stringify({ docsPerSet: DOCS, baseRssMb: base, rows, cold: { coldStartMs, coldAllListedMs, listed, searchHits: (s.structuredContent?.hits ?? []).length } }, null, 1));
for (const g of gateways) await g.close();
await hub.stop();
process.exit(0);
